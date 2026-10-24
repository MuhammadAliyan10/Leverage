import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  createBackupEnvelope,
  createRecoveryKey,
  openBackupEnvelope,
  createPassphraseBackupEnvelope,
  openPassphraseBackupEnvelope,
  assertBackupSchemaVersion,
} from '../../src/security/backupEnvelope.ts';
import { createProfileKeyManager, keyFromHex } from '../../src/security/keyMaterial.ts';

const nativeAlgorithmAdapter = {
  async seal(plaintext, key, aad) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  },
  async open(sealed, key, aad) {
    const nonce = sealed.subarray(0, 12);
    const tag = sealed.subarray(sealed.length - 16);
    const ciphertext = sealed.subarray(12, sealed.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  },
};

test('256-bit recovery key encrypts and authenticates a versioned profile-scoped backup', async () => {
  const recoveryKey = await createRecoveryKey(async (count) => randomBytes(count));
  const database = new Uint8Array([83, 81, 76, 105, 116, 101, 0, 1, 2, 3]);
  const envelope = await createBackupEnvelope(nativeAlgorithmAdapter, recoveryKey, 'profile-1', 1, database);
  assert.equal(Buffer.from(envelope).includes(database), false, 'raw database bytes are absent from the envelope');
  const restored = await openBackupEnvelope(nativeAlgorithmAdapter, recoveryKey, 'profile-1', 1, envelope);
  assert.deepEqual(Buffer.from(restored.database), Buffer.from(database));
  assert.equal(restored.schemaVersion, 1);
});

test('wrong key, damaged ciphertext, wrong profile, and incompatible schema fail closed', async () => {
  const key = await createRecoveryKey(async (count) => randomBytes(count));
  const anotherKey = await createRecoveryKey(async (count) => randomBytes(count));
  const backup = await createBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-a', 1, new Uint8Array([1, 2, 3]));
  await assert.rejects(openBackupEnvelope(nativeAlgorithmAdapter, anotherKey, 'owner-a', 1, backup), /incorrect or .*damaged/);
  const damaged = backup.slice();
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(openBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-a', 1, damaged), /incorrect or .*damaged/);
  await assert.rejects(openBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-b', 1, backup), /different profile/);
  await assert.rejects(openBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-a', 2, backup), /incompatible/);
  await assert.rejects(openBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-a', 1, backup.subarray(0, 12)), /Invalid backup size/);
  assert.throws(() => keyFromHex('short'), /Invalid 256-bit/);
});

test('passphrase backups use a salted KDF and reject wrong passphrases, tampering, profiles, and schemas', async () => {
  const bytes = new Uint8Array([83, 81, 76, 0, 1, 2, 3, 4]);
  const random = async (count) => randomBytes(count);
  const first = await createPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', 'owner-a', 8, bytes, random);
  const second = await createPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', 'owner-a', 8, bytes, random);
  assert.notDeepEqual(Buffer.from(first), Buffer.from(second), 'independent salt and nonce produce different encrypted backups');
  assert.equal(Buffer.from(first).includes(bytes), false, 'raw SQLite bytes are not present in the portable backup');
  const restored = await openPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', null, 8, first);
  assert.deepEqual(Buffer.from(restored.database), Buffer.from(bytes));
  assert.equal(restored.profileId, 'owner-a');
  assert.equal(restored.schemaVersion, 8);
  await assert.rejects(openPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'a different backup phrase', null, 8, first), /incorrect or .*damaged/);
  await assert.rejects(openPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', 'owner-b', 8, first), /different Leverage profile/);
  await assert.rejects(openPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', null, 7, first), /incompatible/);
  const older = await createPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', 'owner-a', 8, bytes, random);
  assert.equal((await openPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', null, 11, older)).schemaVersion, 8,
    'a supported older backup can reach the isolated migration path');
  assert.doesNotThrow(() => assertBackupSchemaVersion(11, 11, 11), 'current schema backups are accepted');
  assert.doesNotThrow(() => assertBackupSchemaVersion(8, 8, 11), 'older schema backups can be migrated');
  assert.throws(() => assertBackupSchemaVersion(8, 11, 11), /incompatible/, 'envelope metadata must match the actual SQLite image');
  assert.throws(() => assertBackupSchemaVersion(12, 12, 11), /incompatible/, 'a newer database is never downgraded');
  await assert.rejects(createPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'short', 'owner-a', 8, bytes, random), /at least 12/);
  const damaged = first.slice();
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(openPassphraseBackupEnvelope(nativeAlgorithmAdapter, 'my memorable backup phrase', null, 8, damaged), /incorrect or .*damaged/);
});

test('device key manager creates once, isolates profiles, and refuses missing or corrupted keys', async () => {
  const secureStore = new Map();
  const databases = new Set();
  let generations = 0;
  const manager = createProfileKeyManager({
    async read(name) { return secureStore.get(name) ?? null; },
    async write(name, value) { secureStore.set(name, value); },
    async randomBytes(count) { generations += 1; return randomBytes(count); },
    async databaseExists(profileId) { return databases.has(profileId); },
  });

  const [first, concurrent] = await Promise.all([
    manager.loadOrCreate('owner-a'), manager.loadOrCreate('owner-a'),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(generations, 1);
  const second = await manager.loadOrCreate('owner-b');
  assert.notDeepEqual(first, second);
  databases.add('owner-a');
  secureStore.delete('houselog.dbkey.v1.owner-a');
  await assert.rejects(manager.loadOrCreate('owner-a'), /key is unavailable/);
  assert.equal(generations, 2, 'the missing key never causes regeneration over an existing database');
  secureStore.set('houselog.dbkey.v1.owner-a', 'invalid');
  await assert.rejects(manager.loadExisting('owner-a'), /Invalid 256-bit/);
});

test('encrypted SQLite backup restores into a clean installation with records and identity intact', async () => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), 'houselog-backup-source-'));
  const restoreDirectory = mkdtempSync(join(tmpdir(), 'houselog-backup-restore-'));
  const sourcePath = join(sourceDirectory, 'synthetic.sqlite');
  const restorePath = join(restoreDirectory, 'restored.sqlite');
  try {
    const original = new DatabaseSync(sourcePath);
    original.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE Account (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, openingMinor INTEGER NOT NULL);
      CREATE TABLE "Transaction" (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, accountId TEXT NOT NULL REFERENCES Account(id),
        amountMinor INTEGER NOT NULL CHECK(amountMinor > 0)
      );
      INSERT INTO Account VALUES ('acct-1', 'owner-a', 10000);
      INSERT INTO "Transaction" VALUES ('tx-gift', 'owner-a', 'acct-1', 2000000);
      INSERT INTO "Transaction" VALUES ('tx-fee', 'owner-a', 'acct-1', 500000);
      PRAGMA user_version = 1;
    `);
    assert.equal(original.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    original.close();

    const key = await createRecoveryKey(async (count) => randomBytes(count));
    const backup = await createBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-a', 1, readFileSync(sourcePath));
    const restored = await openBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-a', 1, backup);
    writeFileSync(restorePath, restored.database, { flag: 'wx' });
    const database = new DatabaseSync(restorePath);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(database.prepare('SELECT id FROM "Transaction" ORDER BY id').all().map((row) => row.id), ['tx-fee', 'tx-gift']);
    assert.equal(database.prepare('SELECT SUM(amountMinor) AS total FROM "Transaction"').get().total, 2_500_000);
    database.close();

    const corrupted = backup.slice();
    corrupted[corrupted.length - 1] ^= 1;
    await assert.rejects(openBackupEnvelope(nativeAlgorithmAdapter, key, 'owner-a', 1, corrupted));
    assert.equal(readFileSync(restorePath).length, readFileSync(sourcePath).length, 'failed recovery did not replace the restored file');
  } finally {
    rmSync(sourceDirectory, { recursive: true, force: true });
    rmSync(restoreDirectory, { recursive: true, force: true });
  }
});

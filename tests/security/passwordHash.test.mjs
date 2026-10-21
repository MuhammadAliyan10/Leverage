import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync } from 'node:crypto';
import test from 'node:test';
import { derivePasswordHash, PASSWORD_HASH_ITERATIONS, verifyAndUpgradePassword, verifyPbkdf2Password } from '../../src/security/passwordHash.ts';

const salt = Uint8Array.from({ length: 16 }, (_, index) => index);

test('versioned PBKDF2-SHA256 encoding matches Node crypto and rejects wrong or malformed credentials', async () => {
  const encoded = await derivePasswordHash('synthetic-password', salt);
  const expectedKey = pbkdf2Sync('synthetic-password', salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('hex');
  assert.equal(encoded, `pbkdf2-sha256$${PASSWORD_HASH_ITERATIONS}$000102030405060708090a0b0c0d0e0f$${expectedKey}`);
  assert.equal(await verifyPbkdf2Password('synthetic-password', encoded), true);
  assert.equal(await verifyPbkdf2Password('wrong-password', encoded), false);
  assert.equal(await verifyPbkdf2Password('synthetic-password', 'pbkdf2-sha256$1$000102030405060708090a0b0c0d0e0f$' + '00'.repeat(32)), false);
  assert.equal(await verifyPbkdf2Password('synthetic-password', `${encoded}extra`), false);
});

test('legacy credential upgrades only after successful verification and persists a versioned hash', async () => {
  const password = 'Synthetic-Password-42';
  const legacyHash = createHash('sha256').update(password).digest('hex');
  let storedHash = legacyHash;
  const result = await verifyAndUpgradePassword(password, storedHash, {
    verifyLegacy: async (candidate, hash) => createHash('sha256').update(candidate).digest('hex') === hash,
    createCurrentHash: async (candidate) => derivePasswordHash(candidate, salt),
    replaceStoredHash: async (expected, current) => { assert.equal(storedHash, expected); storedHash = current; },
  });
  assert.deepEqual(result, { valid: true, upgraded: true });
  assert.notEqual(storedHash, legacyHash);
  assert.equal(await verifyPbkdf2Password(password, storedHash), true);
  assert.equal(await verifyAndUpgradePassword(password, storedHash, {
    verifyLegacy: async () => { throw new Error('must not use legacy verification for tagged hashes'); },
    createCurrentHash: async () => { throw new Error('must not create a replacement'); },
    replaceStoredHash: async () => { throw new Error('must not update a tagged hash'); },
  }).then((value) => value.valid), true);
});

test('wrong legacy passwords never write; KDF or storage failures preserve verified legacy access', async () => {
  const password = 'Synthetic-Password-43';
  const legacyHash = createHash('sha256').update(password).digest('hex');
  let writes = 0;
  const dependencies = {
    verifyLegacy: async (candidate, hash) => createHash('sha256').update(candidate).digest('hex') === hash,
    createCurrentHash: async () => { writes += 1; throw new Error('synthetic KDF failure'); },
    replaceStoredHash: async () => { writes += 1; },
  };
  assert.deepEqual(await verifyAndUpgradePassword('wrong-password', legacyHash, dependencies), { valid: false, upgraded: false });
  assert.equal(writes, 0);
  assert.deepEqual(await verifyAndUpgradePassword(password, legacyHash, dependencies), { valid: true, upgraded: false });
  assert.equal(writes, 1);

  const storageFailure = await verifyAndUpgradePassword(password, legacyHash, {
    verifyLegacy: dependencies.verifyLegacy,
    createCurrentHash: async () => 'pbkdf2-sha256$600000$' + '01'.repeat(16) + '$' + '02'.repeat(32),
    replaceStoredHash: async () => { throw new Error('synthetic database failure'); },
  });
  assert.deepEqual(storageFailure, { valid: true, upgraded: false });
  assert.equal(legacyHash, createHash('sha256').update(password).digest('hex'));
});

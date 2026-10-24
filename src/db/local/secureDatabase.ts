import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { File, FileMode } from 'expo-file-system';
import { getSqliteFile } from './sqliteFile';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const DATABASE = 'finance.db';
const PENDING = 'finance.encrypted-pending.db';
const PLAINTEXT_RECOVERY = 'finance.plaintext-recovery.db';
const KEY_SLOT = 'houselog.database.encryption-key.v1';
const SQLITE_HEADER = [83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0];
let keyPromise: Promise<string> | null = null;

function dbFile(name: string): File {
  return getSqliteFile(name);
}

function hasPlainSqliteHeader(file: File): boolean {
  if (!file.exists) return false;
  const handle = file.open(FileMode.ReadOnly);
  try {
    const prefix = handle.readBytes(16);
    return prefix.length === 16 && SQLITE_HEADER.every((byte, index) => prefix[index] === byte);
  } finally { handle.close(); }
}

async function loadKey(allowCreate: boolean): Promise<string> {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    let key = await SecureStore.getItemAsync(KEY_SLOT);
    if (key !== null) {
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('The local database key is invalid. Restore from a verified backup.');
      return key.toLowerCase();
    }
    if (!allowCreate) throw new Error('The local database key is missing. Restore from a verified backup.');
    const bytes = await Crypto.getRandomBytesAsync(32);
    key = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(KEY_SLOT, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    return key;
  })();
  try { return await keyPromise; }
  catch (error) { keyPromise = null; throw error; }
}

async function openKeyed(name: string, key: string, useNewConnection = false): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(name, useNewConnection ? { useNewConnection: true } : undefined);
  try {
    await database.execAsync(`PRAGMA key = "x'${key}'";`);
    const cipher = await database.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new Error('SQLCipher is unavailable in this native app build. Update the app binary before opening financial data.');
    await database.getFirstAsync('SELECT count(*) AS count FROM sqlite_master');
    return database;
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}

export async function inspectEncryptedDatabaseContent(database: SQLite.SQLiteDatabase): Promise<string> {
  const integrity = await database.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity?.integrity_check !== 'ok') throw new Error('Database integrity check failed.');
  const foreignKeyErrors = await database.getAllAsync('PRAGMA foreign_key_check');
  if (foreignKeyErrors.length > 0) throw new Error('Database foreign-key validation failed.');
  const userVersion = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const tables = await database.getAllAsync<{ name: string; sql: string | null }>(
    "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const rows: [string, number, string][] = [];
  for (const table of tables) {
    const name = table.name.replaceAll('"', '""');
    const count = await database.getFirstAsync<{ count: number }>(`SELECT count(*) AS count FROM "${name}"`);
    const digest = sha256.create();
    for await (const row of database.getEachAsync<Record<string, unknown>>(`SELECT * FROM "${name}" ORDER BY rowid`)) {
      digest.update(utf8ToBytes(JSON.stringify(row)));
      digest.update(Uint8Array.of(10));
    }
    const fingerprint = Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    rows.push([table.name, count?.count ?? -1, fingerprint]);
  }
  return JSON.stringify({ version: userVersion?.user_version ?? 0, schema: tables.map(({ name, sql }) => [name, sql]), rows });
}

async function verifyEncryptedFile(name: string, key: string): Promise<void> {
  const database = await openKeyed(name, key, true);
  try { await database.execAsync('PRAGMA foreign_keys=ON;'); await inspectEncryptedDatabaseContent(database); }
  finally { await database.closeAsync(); }
}

async function migratePlaintext(key: string): Promise<void> {
  const sourceFile = dbFile(DATABASE);
  const pendingFile = dbFile(PENDING);
  const recoveryFile = dbFile(PLAINTEXT_RECOVERY);
  if (!sourceFile.exists) return;

  if (!hasPlainSqliteHeader(sourceFile)) throw new Error('The database is encrypted or damaged, but its key cannot open it. Existing records have been preserved.');
  if (pendingFile.exists) pendingFile.delete();
  const plain = await SQLite.openDatabaseAsync(DATABASE);
  let before: string;
  try {
    await plain.execAsync('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA foreign_keys=ON;');
    before = await inspectEncryptedDatabaseContent(plain);
    const path = pendingFile.uri.replace(/^file:\/\//, '').replaceAll("'", "''");
    await plain.execAsync(`ATTACH DATABASE '${path}' AS encrypted KEY "x'${key}'";`);
    await plain.execAsync("SELECT sqlcipher_export('encrypted');");
    const version = await plain.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    await plain.execAsync(`PRAGMA encrypted.user_version=${version?.user_version ?? 0}; DETACH DATABASE encrypted;`);
  } finally { await plain.closeAsync(); }
  for (const suffix of ['-wal', '-shm']) { const sidecar = dbFile(`${DATABASE}${suffix}`); if (sidecar.exists) sidecar.delete(); }

  await verifyEncryptedFile(PENDING, key);
  const encrypted = await openKeyed(PENDING, key, true);
  let after: string;
  try { after = await inspectEncryptedDatabaseContent(encrypted); }
  finally { await encrypted.closeAsync(); }
  if (before !== after) throw new Error('Encrypted database verification did not match. The original financial database is untouched.');

  if (recoveryFile.exists) recoveryFile.delete();
  await sourceFile.move(recoveryFile);
  try {
    await pendingFile.move(sourceFile);
    for (const suffix of ['-wal', '-shm']) { const sidecar = dbFile(`${PENDING}${suffix}`); if (sidecar.exists) sidecar.delete(); }
    await verifyEncryptedFile(DATABASE, key);
    recoveryFile.delete();
  } catch (error) {
    if (sourceFile.exists) sourceFile.delete();
    if (recoveryFile.exists) await recoveryFile.move(sourceFile);
    throw new Error('Encrypted database activation failed; the original database was restored.', { cause: error });
  }
}

async function recoverInterruptedConversion(key: string): Promise<void> {
  const main = dbFile(DATABASE);
  const pending = dbFile(PENDING);
  const recovery = dbFile(PLAINTEXT_RECOVERY);
  if (!main.exists && recovery.exists) {
    if (pending.exists) {
      try {
        await verifyEncryptedFile(PENDING, key);
        await pending.move(main);
        await verifyEncryptedFile(DATABASE, key);
        recovery.delete();
        return;
      } catch { if (main.exists) main.delete(); }
    }
    if (!main.exists) await recovery.move(main);
  } else if (main.exists && recovery.exists) {
    try { await verifyEncryptedFile(DATABASE, key); recovery.delete(); }
    catch { throw new Error('Database conversion recovery needs attention. Both the current and preserved source files remain on this device.'); }
  }
  if (pending.exists) pending.delete();
}

export async function openProtectedDatabase(name: string, useNewConnection = false): Promise<SQLite.SQLiteDatabase> {
  if (name !== DATABASE && name !== PENDING) throw new Error('Unexpected local database name.');
  const file = dbFile(DATABASE);
  if (name === PENDING) return openKeyed(name, await loadKey(false), useNewConnection);
  const isPlaintext = hasPlainSqliteHeader(file);
  const key = await loadKey(!file.exists || isPlaintext);
  await recoverInterruptedConversion(key);
  const recoveredPlaintext = hasPlainSqliteHeader(file);
  if (recoveredPlaintext) {
    if (useNewConnection) throw new Error('The local database must be encrypted before opening a write connection.');
    await migratePlaintext(key);
  }
  return openKeyed(name, key, useNewConnection);
}

export async function getDatabaseKey(): Promise<string> { return loadKey(false); }

/** Explicit restore may provision a replacement device key; normal opens never do this over an existing DB. */
export async function prepareKeyForVerifiedRestore(): Promise<string> {
  const saved = await SecureStore.getItemAsync(KEY_SLOT);
  if (saved !== null) {
    if (!/^[a-f0-9]{64}$/i.test(saved)) throw new Error('The local database key is invalid.');
    keyPromise = Promise.resolve(saved.toLowerCase());
    return keyPromise;
  }
  keyPromise = null;
  return loadKey(true);
}

export async function verifyEncryptedDatabase(name: string): Promise<void> {
  await verifyEncryptedFile(name, await loadKey(false));
}

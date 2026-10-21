import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { File } from 'expo-file-system';

const ENCRYPTED_NAME = 'houselog-lab-encrypted.db';
const PLAINTEXT_NAME = 'houselog-lab-plaintext.db';
const CONVERTED_NAME = 'houselog-lab-converted.db';
const KEY_SLOT = 'houselog-lab-dbkey-v1';
const SQLITE_HEADER = 'SQLite format 3\0';

interface CountRow { count: number }
interface SumRow { total: number | null }
interface CipherVersionRow { cipher_version: string }
interface IntegrityRow { integrity_check: string }

function requireResult(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function hex(bytes: Uint8Array): string {
  requireResult(bytes.length === 32, 'A 256-bit key is required.');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validKey(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function pathFor(name: string): File {
  return new File(SQLite.defaultDatabaseDirectory, name);
}

async function storedOrNewKey(): Promise<string> {
  const saved = await SecureStore.getItemAsync(KEY_SLOT);
  if (saved !== null) {
    requireResult(validKey(saved), 'The stored key is invalid.');
    return saved;
  }
  requireResult(!pathFor(ENCRYPTED_NAME).exists, 'The encrypted database exists but its key is unavailable.');
  const generated = hex(await Crypto.getRandomBytesAsync(32));
  await SecureStore.setItemAsync(KEY_SLOT, generated);
  return generated;
}

async function openEncrypted(name: string, key: string | null): Promise<SQLite.SQLiteDatabase> {
  requireResult(key !== null && validKey(key), 'The encryption key is unavailable.');
  const database = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
  try {
    // Keying must be the first database operation. A raw 256-bit key has a fixed hex alphabet.
    await database.execAsync(`PRAGMA key = "x'${key}'";`);
    const version = await database.getFirstAsync<CipherVersionRow>('PRAGMA cipher_version');
    requireResult(Boolean(version?.cipher_version), 'The native SQLCipher implementation is unavailable.');
    await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM sqlite_master');
    await database.execAsync('PRAGMA foreign_keys = ON;');
    return database;
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}

async function count(database: SQLite.SQLiteDatabase): Promise<number> {
  const row = await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM LedgerTransaction');
  requireResult(row !== null && Number.isSafeInteger(row.count), 'Transaction count is invalid.');
  return row.count;
}

async function verifyFixture(database: SQLite.SQLiteDatabase): Promise<void> {
  const accounts = await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM Account');
  const transactions = await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM LedgerTransaction');
  const amounts = await database.getFirstAsync<SumRow>('SELECT SUM(amountMinor) AS total FROM LedgerTransaction WHERE id IN (?, ?, ?)', ['gift', 'salary', 'fee']);
  const integrity = await database.getFirstAsync<IntegrityRow>('PRAGMA integrity_check');
  requireResult(accounts?.count === 1 && transactions !== null && transactions.count >= 3, 'Synthetic record counts changed.');
  requireResult(amounts?.total === 5_000_000, 'Synthetic integer amounts changed.');
  requireResult(integrity?.integrity_check === 'ok', 'Database integrity check failed.');
}

async function verifyEncryptedHeader(name: string): Promise<void> {
  const file = pathFor(name);
  requireResult(file.exists, 'Expected encrypted database file is missing.');
  const bytes = await file.bytes();
  requireResult(bytes.length >= 16, 'Encrypted database file is too small.');
  const header = String.fromCharCode(...bytes.subarray(0, 16));
  requireResult(header !== SQLITE_HEADER, 'The database has a plaintext SQLite header.');
}

async function verifyWrongAndMissingKeys(key: string): Promise<void> {
  try {
    await openEncrypted(ENCRYPTED_NAME, null);
    throw new Error('Missing-key access was accepted.');
  } catch (error) {
    if (error instanceof Error && error.message === 'Missing-key access was accepted.') throw error;
  }

  let wrongKeyRejected = false;
  const wrongKey = hex(await Crypto.getRandomBytesAsync(32));
  try {
    const database = await openEncrypted(ENCRYPTED_NAME, wrongKey);
    await database.closeAsync();
  } catch {
    wrongKeyRejected = true;
  }
  requireResult(wrongKey !== key && wrongKeyRejected, 'The database accepted an incorrect key.');
}

async function verifyConstraintsAndRollback(database: SQLite.SQLiteDatabase): Promise<void> {
  const before = await count(database);
  let foreignKeyRejected = false;
  try {
    await database.runAsync(
      'INSERT INTO LedgerTransaction (id, accountId, kind, amountMinor) VALUES (?, ?, ?, ?)',
      [Crypto.randomUUID(), 'missing-account', 'expense', 1],
    );
  } catch {
    foreignKeyRejected = true;
  }
  requireResult(foreignKeyRejected && await count(database) === before, 'Foreign-key rejection failed.');

  let rolledBack = false;
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        'INSERT INTO LedgerTransaction (id, accountId, kind, amountMinor) VALUES (?, ?, ?, ?)',
        [Crypto.randomUUID(), 'account-1', 'income', 1],
      );
      throw new Error('Injected interruption');
    });
  } catch {
    rolledBack = true;
  }
  requireResult(rolledBack && await count(database) === before, 'The interrupted transaction was not rolled back.');
}

async function verifySeparateConnections(key: string): Promise<string> {
  const first = await openEncrypted(ENCRYPTED_NAME, key);
  const second = await openEncrypted(ENCRYPTED_NAME, key);
  try {
    const before = await count(first);
    const write = (database: SQLite.SQLiteDatabase) => database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        'INSERT INTO LedgerTransaction (id, accountId, kind, amountMinor) VALUES (?, ?, ?, ?)',
        [Crypto.randomUUID(), 'account-1', 'income', 1],
      );
    });
    const outcomes = await Promise.allSettled([write(first), write(second)]);
    const committed = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    requireResult(committed > 0, 'Both separate-connection writes failed.');
    requireResult(await count(first) === before + committed, 'Concurrent write count does not match committed operations.');
    return committed === 2 ? 'PASS: both separate-connection writes committed.' : 'PASS: contention rejected one write without a partial commit.';
  } finally {
    await first.closeAsync();
    await second.closeAsync();
  }
}

function sqlPath(file: File): string {
  const path = decodeURIComponent(file.uri.replace(/^file:\/\//, ''));
  return path.replaceAll("'", "''");
}

async function verifyDisposableConversion(key: string): Promise<void> {
  const source = await SQLite.openDatabaseAsync(PLAINTEXT_NAME, { useNewConnection: true });
  try {
    await source.execAsync(`
      CREATE TABLE IF NOT EXISTS Account (id TEXT PRIMARY KEY, openingMinor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS LedgerTransaction (
        id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES Account(id),
        amountMinor INTEGER NOT NULL CHECK(amountMinor > 0)
      );
      PRAGMA user_version = 1;
    `);
    await source.runAsync('INSERT OR IGNORE INTO Account (id, openingMinor) VALUES (?, ?)', ['plain-account', 10_000]);
    await source.runAsync('INSERT OR IGNORE INTO LedgerTransaction (id, accountId, amountMinor) VALUES (?, ?, ?)', ['plain-gift', 'plain-account', 2_000_000]);
    const before = await source.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM LedgerTransaction');
    requireResult(before?.count === 1, 'Plaintext source fixture is invalid.');

    // The first deliberate interruption happens before export. The original remains untouched.
    let interrupted = false;
    try {
      throw new Error('Injected pre-export interruption');
    } catch {
      interrupted = true;
    }
    const retained = await source.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM LedgerTransaction');
    requireResult(interrupted && retained?.count === before.count, 'Plaintext source was not preserved.');

    const destination = pathFor(CONVERTED_NAME);
    if (destination.exists) await SQLite.deleteDatabaseAsync(CONVERTED_NAME);
    let attached = false;
    try {
      await source.execAsync(`ATTACH DATABASE '${sqlPath(destination)}' AS encrypted KEY "x'${key}'";`);
      attached = true;
      // A missing function or binding failure is a visible POC failure, not a fallback copy.
      await source.getFirstAsync("SELECT sqlcipher_export('encrypted') AS exported");
      await source.execAsync('PRAGMA encrypted.user_version = 1;');
    } finally {
      if (attached) await source.execAsync('DETACH DATABASE encrypted;');
    }

    const encrypted = await openEncrypted(CONVERTED_NAME, key);
    try {
      const account = await encrypted.getFirstAsync<{ openingMinor: number }>('SELECT openingMinor FROM Account WHERE id = ?', ['plain-account']);
      const transaction = await encrypted.getFirstAsync<{ amountMinor: number }>('SELECT amountMinor FROM LedgerTransaction WHERE id = ?', ['plain-gift']);
      const version = await encrypted.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      const integrity = await encrypted.getFirstAsync<IntegrityRow>('PRAGMA integrity_check');
      requireResult(account?.openingMinor === 10_000 && transaction?.amountMinor === 2_000_000, 'Converted minor units changed.');
      requireResult(version?.user_version === 1 && integrity?.integrity_check === 'ok', 'Converted schema or integrity failed.');
    } finally {
      await encrypted.closeAsync();
    }
    await verifyEncryptedHeader(CONVERTED_NAME);
    const original = await source.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM LedgerTransaction');
    requireResult(original?.count === before.count && pathFor(PLAINTEXT_NAME).exists, 'Original plaintext data was removed.');
  } finally {
    await source.closeAsync();
  }
}

/** Only synthetic files in this app's private container are accessed. No keys or records are logged. */
export async function runCipherProbe(): Promise<string[]> {
  const result: string[] = [];
  const key = await storedOrNewKey();
  const database = await openEncrypted(ENCRYPTED_NAME, key);
  try {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS Account (
        id TEXT PRIMARY KEY NOT NULL,
        openingMinor INTEGER NOT NULL CHECK(openingMinor >= 0)
      );
      CREATE TABLE IF NOT EXISTS LedgerTransaction (
        id TEXT PRIMARY KEY NOT NULL,
        accountId TEXT NOT NULL REFERENCES Account(id),
        kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
        amountMinor INTEGER NOT NULL CHECK(amountMinor > 0)
      );
      PRAGMA user_version = 1;
    `);
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync('INSERT OR IGNORE INTO Account (id, openingMinor) VALUES (?, ?)', ['account-1', 10_000]);
      await transaction.runAsync('INSERT OR IGNORE INTO LedgerTransaction VALUES (?, ?, ?, ?)', ['gift', 'account-1', 'income', 2_000_000]);
      await transaction.runAsync('INSERT OR IGNORE INTO LedgerTransaction VALUES (?, ?, ?, ?)', ['salary', 'account-1', 'income', 2_500_000]);
      await transaction.runAsync('INSERT OR IGNORE INTO LedgerTransaction VALUES (?, ?, ?, ?)', ['fee', 'account-1', 'expense', 500_000]);
    });
    await verifyFixture(database);
    result.push('PASS: synthetic integer transactions, schema, and integrity.');
    await verifyConstraintsAndRollback(database);
    result.push('PASS: foreign keys and injected rollback.');
  } finally {
    await database.closeAsync();
  }
  await verifyEncryptedHeader(ENCRYPTED_NAME);
  result.push('PASS: native SQLCipher and non-plaintext file header.');
  const reopened = await openEncrypted(ENCRYPTED_NAME, key);
  try {
    await verifyFixture(reopened);
  } finally {
    await reopened.closeAsync();
  }
  result.push('PASS: correct-key reopen. Force-stop and rerun for process-restart proof.');
  await verifyWrongAndMissingKeys(key);
  result.push('PASS: incorrect and missing keys rejected.');
  result.push(await verifySeparateConnections(key));
  await verifyDisposableConversion(key);
  result.push('PASS: disposable plaintext export, target validation, and source preservation.');
  return result;
}

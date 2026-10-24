import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { File, FileMode } from 'expo-file-system';

const SQLITE_HEADER = [83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0];
const PENDING_RESTART_CHECK = 'mizan.native-sqlcipher-check.v1';
let restartCheckCreatedInThisRuntime: string | null = null;

export async function hasPendingNativeSqlCipherRestartCheck(): Promise<boolean> {
  return (await SecureStore.getItemAsync(PENDING_RESTART_CHECK)) !== null;
}

export async function discardNativeSqlCipherRestartCheck(): Promise<void> {
  const directory = SQLite.defaultDatabaseDirectory;
  if (!directory) throw new Error('The native SQLite directory is unavailable.');
  const saved = await SecureStore.getItemAsync(PENDING_RESTART_CHECK);
  if (!saved) return;
  try {
    const record: unknown = JSON.parse(saved);
    if (record && typeof record === 'object' && 'databaseName' in record &&
        typeof record.databaseName === 'string' && /^mizan-sqlcipher-verification-[a-f0-9]{32}\.db$/.test(record.databaseName)) {
      await SQLite.deleteDatabaseAsync(record.databaseName, directory);
    }
  } finally {
    await SecureStore.deleteItemAsync(PENDING_RESTART_CHECK);
    restartCheckCreatedInThisRuntime = null;
  }
}

export type NativeStorageVerification = {
  cipherAvailable: true;
  encryptedAtRest: true;
  correctKeyReopens: true;
  wrongKeyRejected: true;
  integrityCheck: true;
  restartCheckPrepared: true;
};

function readFileHeader(file: File): Uint8Array {
  if (!file.exists) throw new Error('The temporary verification database was not created.');
  const handle = file.open(FileMode.ReadOnly);
  try { return handle.readBytes(16); }
  finally { handle.close(); }
}

/**
 * Exercises the native SQLCipher driver using a random, disposable SQLite file.
 * It never opens the financial database or writes a key into persistent storage.
 */
export async function prepareNativeSqlCipherVerification(): Promise<NativeStorageVerification> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error('Native SQLCipher verification requires the installed Android or iOS app.');
  }
  const directory = SQLite.defaultDatabaseDirectory;
  if (!directory) throw new Error('The native SQLite directory is unavailable.');

  const bytes = await Crypto.getRandomBytesAsync(32);
  const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const suffix = Array.from((await Crypto.getRandomBytesAsync(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const databaseName = `mizan-sqlcipher-verification-${suffix}.db`;
  const databaseFile = new File(directory, databaseName);
  let database: SQLite.SQLiteDatabase | null = null;
  let retainForRestartCheck = false;

  try {
    database = await SQLite.openDatabaseAsync(databaseName);
    await database.execAsync(`PRAGMA key = "x'${key}'"; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;`);
    const cipher = await database.getFirstAsync<{ cipher_version: string | null }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new Error('This app binary does not include SQLCipher.');

    await database.execAsync('CREATE TABLE verification (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
    await database.runAsync('INSERT INTO verification(value) VALUES (?)', 'native-encryption-ok');
    const integrity = await database.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
    const foreignKeys = await database.getAllAsync('PRAGMA foreign_key_check');
    if (integrity?.integrity_check !== 'ok' || foreignKeys.length !== 0) throw new Error('The temporary encrypted database failed its integrity checks.');
    await database.closeAsync();
    database = null;

    const fileHeader = readFileHeader(databaseFile);
    if (fileHeader.length !== 16 || SQLITE_HEADER.every((value, index) => fileHeader[index] === value)) {
      throw new Error('The temporary database file does not appear encrypted at rest.');
    }

    database = await SQLite.openDatabaseAsync(databaseName);
    await database.execAsync(`PRAGMA key = "x'${key}'";`);
    const persisted = await database.getFirstAsync<{ value: string }>('SELECT value FROM verification WHERE id=1');
    if (persisted?.value !== 'native-encryption-ok') throw new Error('The temporary encrypted database did not survive reopening with its key.');
    await database.closeAsync();
    database = null;

    let wrongKeyAccepted = false;
    let wrongKeyDatabase: SQLite.SQLiteDatabase | null = null;
    try {
      wrongKeyDatabase = await SQLite.openDatabaseAsync(databaseName);
      await wrongKeyDatabase.execAsync(`PRAGMA key = "x'${'00'.repeat(32)}'";`);
      await wrongKeyDatabase.getFirstAsync('SELECT value FROM verification WHERE id=1');
      wrongKeyAccepted = true;
    } catch {
      // SQLCipher should reject the file once a query attempts to read encrypted pages.
    } finally {
      if (wrongKeyDatabase) await wrongKeyDatabase.closeAsync();
    }
    if (wrongKeyAccepted) throw new Error('The temporary database accepted an incorrect key.');

    await SecureStore.setItemAsync(PENDING_RESTART_CHECK, JSON.stringify({ databaseName, key, runId: suffix }));
    restartCheckCreatedInThisRuntime = suffix;
    retainForRestartCheck = true;
    return {
      cipherAvailable: true,
      encryptedAtRest: true,
      correctKeyReopens: true,
      wrongKeyRejected: true,
      integrityCheck: true,
      restartCheckPrepared: true,
    };
  } finally {
    if (database) await database.closeAsync().catch(() => undefined);
    if (!retainForRestartCheck) await SQLite.deleteDatabaseAsync(databaseName, directory).catch(() => undefined);
  }
}

/** Complete the second phase after the user fully closes and relaunches the disposable app. */
export async function completeNativeSqlCipherRestartVerification(): Promise<void> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error('Native SQLCipher verification requires the installed Android or iOS app.');
  }
  const directory = SQLite.defaultDatabaseDirectory;
  if (!directory) throw new Error('The native SQLite directory is unavailable.');
  const saved = await SecureStore.getItemAsync(PENDING_RESTART_CHECK);
  if (!saved) throw new Error('No pending restart verification was found. Run the first native check before closing the app.');

  let pending: unknown;
  try { pending = JSON.parse(saved); }
  catch { throw new Error('The pending restart verification record is damaged.'); }
  if (!pending || typeof pending !== 'object') throw new Error('The pending restart verification record is invalid.');
  const record = pending as Record<string, unknown>;
  const databaseName = record.databaseName;
  const key = record.key;
  const runId = record.runId;
  if (typeof databaseName !== 'string' || !/^mizan-sqlcipher-verification-[a-f0-9]{32}\.db$/.test(databaseName) ||
      typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || typeof runId !== 'string' || !/^[a-f0-9]{32}$/.test(runId)) {
    throw new Error('The pending restart verification record is invalid.');
  }
  if (runId === restartCheckCreatedInThisRuntime) {
    throw new Error('Fully close and reopen the app before completing the restart check.');
  }

  let database: SQLite.SQLiteDatabase | null = null;
  try {
    database = await SQLite.openDatabaseAsync(databaseName);
    await database.execAsync(`PRAGMA key = "x'${key}'"; PRAGMA foreign_keys=ON;`);
    const cipher = await database.getFirstAsync<{ cipher_version: string | null }>('PRAGMA cipher_version');
    const persisted = await database.getFirstAsync<{ value: string }>('SELECT value FROM verification WHERE id=1');
    const integrity = await database.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
    const foreignKeys = await database.getAllAsync('PRAGMA foreign_key_check');
    if (!cipher?.cipher_version || persisted?.value !== 'native-encryption-ok' || integrity?.integrity_check !== 'ok' || foreignKeys.length !== 0) {
      throw new Error('The encrypted test record did not pass after restarting the app.');
    }
    await database.closeAsync();
    database = null;

    let wrongKeyAccepted = false;
    let wrongKeyDatabase: SQLite.SQLiteDatabase | null = null;
    try {
      wrongKeyDatabase = await SQLite.openDatabaseAsync(databaseName);
      await wrongKeyDatabase.execAsync(`PRAGMA key = "x'${'00'.repeat(32)}'";`);
      await wrongKeyDatabase.getFirstAsync('SELECT value FROM verification WHERE id=1');
      wrongKeyAccepted = true;
    } catch {
      // Expected: querying encrypted pages with the incorrect key must fail.
    } finally {
      if (wrongKeyDatabase) await wrongKeyDatabase.closeAsync();
    }
    if (wrongKeyAccepted) throw new Error('The temporary database accepted an incorrect key after restart.');

    await SQLite.deleteDatabaseAsync(databaseName, directory);
    await SecureStore.deleteItemAsync(PENDING_RESTART_CHECK);
    restartCheckCreatedInThisRuntime = null;
  } finally {
    if (database) await database.closeAsync().catch(() => undefined);
  }
}

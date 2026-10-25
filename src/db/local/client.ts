import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import { getSqliteFile } from './sqliteFile';
import { Platform, Share } from 'react-native';
import {
  normalizeAccountDraft,
  normalizeTransactionDraft,
  createValidatedTransaction,
  validateStoredClassification,
  isCurrencyCode,
  isPaymentMethod,
  isTaxStatus,
  isTransactionType,
  type AccountDraft,
  type CurrencyCode,
  type PaymentMethod,
  type TaxStatus,
  type ClassificationId,
  type TransactionType,
  type NormalizedTransactionDraft,
  type TransactionDraft,
} from '../../finance/domain';
import { LOCAL_DATABASE_VERSION, migrateLocalDatabase, type MigrationDatabase } from './migrations';
import { prepareBackupCandidate } from './backupCandidate';
import { createLocalWriteQueue } from './writeQueue';
import { archiveAccount as archiveAccountRecord, editAccount } from '../../finance/accountOperations';
import { assertCorrectionCanPost, resolveRefundAmount } from '../../finance/transactionOperations';
import { buildFinancialReportQuery, type FinancialReportRow } from '../../finance/reporting';
import { formatMinorUnits } from '../../finance/ledger';
import { hasSufficientFunds } from '../../finance/balances';
import { buildAccountActivitySummaryQuery, buildAccountBalanceQuery, buildRecentAccountPreferenceQuery, buildTransactionListQuery, buildTransactionPagePredicate, type TransactionFilters } from './queryBuilders';
import { createBudgetingStore, type BudgetingSql } from './budgetingStore';
import { createObligationsStore, type ObligationsSql } from './obligationsStore';
import { createAssetsInvestmentsStore, type AssetSql } from './assetsInvestmentsStore';
import { derivePasswordHash, verifyAndUpgradePassword } from '../../security/passwordHash';
import { createLoginRateLimit } from '../../security/loginRateLimit';
import { createPersistedLoginAttempts } from '../../security/persistedLoginAttempts';
import { projectTransactionActivity, type TransactionActivity } from '../../finance/transactionDisplay';
import { createProfileSetupStore } from './profileSetupStore';
import { inspectEncryptedDatabaseContent, openProtectedDatabase, prepareKeyForVerifiedRestore, verifyEncryptedDatabase } from './secureDatabase';
import { createPassphraseBackupEnvelope, openPassphraseBackupEnvelope } from '../../security/backupEnvelope';
import { expoBackupCipher } from '../../security/expoBackupCipher';
import { getLocalAuthFailureMessage, LOCAL_PROFILE_NOT_FOUND_MESSAGE } from '../../security/localAuthError';
import { activeCloudUser, assertCloudAccountType, countLocalFinancialRecords, enqueueCloudMutation, nextCloudAccountRevision, validateCloudChangePage, wakeSync, type OutboxMutation, type CloudAccountPayload, type CloudTransactionPayload } from './syncOutbox';

type SqlExecutor = Pick<SQLite.SQLiteDatabase, 'execAsync' | 'runAsync' | 'getFirstAsync' | 'getAllAsync'>;

function nullableCloudText(value: unknown): string | null { return typeof value === 'string' ? value : null; }

let expoDb: SQLite.SQLiteDatabase | null = null;
let openingDatabase: Promise<SQLite.SQLiteDatabase> | null = null;
let databaseMaintenance = false;
const runSerializedWrite = createLocalWriteQueue();
const loginRateLimit = createLoginRateLimit();

async function hashLegacyPassword(password: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, password);
}

async function hashPassword(password: string): Promise<string> {
  const salt = await Crypto.getRandomBytesAsync(16);
  return derivePasswordHash(password, salt);
}

function asMigrationDatabase(database: SQLite.SQLiteDatabase): MigrationDatabase {
  return {
    execAsync: (source) => database.execAsync(source),
    runAsync: (source, params = []) => database.runAsync(source, [...params]),
    getFirstAsync: <T>(source: string, params: readonly (string | number | null)[] = []) =>
      database.getFirstAsync<T>(source, [...params]),
    getAllAsync: <T>(source: string, params: readonly (string | number | null)[] = []) =>
      database.getAllAsync<T>(source, [...params]),
    withTransactionAsync: (task) => database.withTransactionAsync(task),
  };
}

interface AuthAttemptRow { failures: number; blockedUntil: number }

const persistedLoginAttempts = createPersistedLoginAttempts({
  read: async (key) => {
    const database=await getDb();
    return database.getFirstAsync<AuthAttemptRow>('SELECT failures,blockedUntil FROM AuthLoginAttempt WHERE attemptKey=?',[key]);
  },
  update: async (key,change) => {
    const database=await getDb();
    return withLocalWrite(database,async(transaction)=>{
      const prior=await transaction.getFirstAsync<AuthAttemptRow>('SELECT failures,blockedUntil FROM AuthLoginAttempt WHERE attemptKey=?',[key]);
      const next=change(prior);
      await transaction.runAsync('INSERT INTO AuthLoginAttempt(attemptKey,failures,blockedUntil) VALUES(?,?,?) ON CONFLICT(attemptKey) DO UPDATE SET failures=excluded.failures,blockedUntil=excluded.blockedUntil',[key,next.failures,next.blockedUntil]);
      return next;
    });
  },
  clear: async(key) => {
    const database=await getDb();
    await withLocalWrite(database,async(transaction)=>{ await transaction.runAsync('DELETE FROM AuthLoginAttempt WHERE attemptKey=?',[key]); });
  },
},loginRateLimit);

async function authAttemptKey(email: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, email.trim().toLowerCase());
}

async function recordAuthFailure(key: string): Promise<number> {
  return persistedLoginAttempts.recordFailure(key);
}

async function currentAuthDelay(key: string): Promise<number> {
  return persistedLoginAttempts.remainingDelay(key);
}

async function clearAuthFailures(key: string): Promise<void> {
  await persistedLoginAttempts.recordSuccess(key);
}

async function openAndMigrateDatabase(): Promise<SQLite.SQLiteDatabase> {
  const database = Platform.OS === 'web'
    ? await SQLite.openDatabaseAsync('finance.db')
    : await openProtectedDatabase('finance.db');
  try {
    await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    await migrateLocalDatabase(asMigrationDatabase(database));
    return database;
  } catch (error) {
    await database.closeAsync();
    throw error instanceof Error
      ? new Error(`Local database could not be safely opened: ${error.message}`, { cause: error })
      : new Error('Local database could not be safely opened.');
  }
}

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (databaseMaintenance) throw new Error('Financial records are being safely restored. Try again in a moment.');
  if (expoDb) return expoDb;
  openingDatabase ??= openAndMigrateDatabase();
  try {
    expoDb = await openingDatabase;
    return expoDb;
  } finally {
    openingDatabase = null;
  }
}

/** Serializes writes everywhere and gives native writes an FK-enabled connection before BEGIN. */
async function withLocalWrite<T>(database: SQLite.SQLiteDatabase, task: (executor: SqlExecutor) => Promise<T>): Promise<T> {
  return runSerializedWrite(async () => {
    if (Platform.OS === 'web') {
      let value!: T;
      await database.withTransactionAsync(async () => { value = await task(database); });
      return value;
    }

    // Expo's exclusive helper starts BEGIN on a fresh connection before its callback.
    // PRAGMA foreign_keys is connection-local and cannot be enabled inside that transaction.
    if (databaseMaintenance) throw new Error('Financial records are being safely restored. Try again in a moment.');
    const writeConnection = await openProtectedDatabase('finance.db', true);
    let began = false;
    try {
      await writeConnection.execAsync('PRAGMA foreign_keys = ON;');
      const foreignKeys = await writeConnection.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
      if (foreignKeys?.foreign_keys !== 1) throw new Error('SQLite foreign-key enforcement could not be enabled for this write.');
      await writeConnection.execAsync('BEGIN IMMEDIATE;');
      began = true;
      const value = await task(writeConnection);
      await writeConnection.execAsync('COMMIT;');
      began = false;
      return value;
    } catch (error) {
      if (began) {
        try { await writeConnection.execAsync('ROLLBACK;'); } catch { /* Preserve the original database failure. */ }
      }
      throw error;
    } finally {
      await writeConnection.closeAsync();
    }
  });
}

function asBudgetingSql(database: SqlExecutor): BudgetingSql {
  return {
    getFirstAsync: <T>(sql: string, params: readonly (string | number | null)[] = []) => database.getFirstAsync<T>(sql, [...params]),
    getAllAsync: <T>(sql: string, params: readonly (string | number | null)[] = []) => database.getAllAsync<T>(sql, [...params]),
    runAsync: (sql, params = []) => database.runAsync(sql, [...params]),
  };
}

function asObligationsSql(database: SqlExecutor): ObligationsSql {
  return {
    getFirstAsync: <T>(sql: string, params: readonly (string | number | null)[] = []) => database.getFirstAsync<T>(sql, [...params]),
    getAllAsync: <T>(sql: string, params: readonly (string | number | null)[] = []) => database.getAllAsync<T>(sql, [...params]),
    runAsync: (sql, params = []) => database.runAsync(sql, [...params]),
  };
}

function asAssetSql(database: SqlExecutor): AssetSql {
  return {
    getFirstAsync: <T>(sql: string, params: readonly (string | number | null)[] = []) => database.getFirstAsync<T>(sql, [...params]),
    getAllAsync: <T>(sql: string, params: readonly (string | number | null)[] = []) => database.getAllAsync<T>(sql, [...params]),
    runAsync: (sql, params = []) => database.runAsync(sql, [...params]),
  };
}

async function insertObligationCashTransaction(
  sql: ObligationsSql,
  input: { id: string; ownerId: string; amountMinor: number; type: 'Income'|'Expense'; categoryId: string; accountId: string; date: string; note: string; taxStatus?: TaxStatus },
): Promise<void> {
  if (!input.id.trim() || !input.ownerId.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('Financial posting details are invalid.');
  const date = new Date(input.date);
  if (!Number.isFinite(date.getTime())) throw new Error('Financial posting date is invalid.');
  const account = await sql.getFirstAsync<{id:string;currency:string}>('SELECT id,currency FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[input.accountId,input.ownerId]);
  if (!account) throw new Error('Choose an active account owned by this profile.');
  const existing = await sql.getFirstAsync<{ownerId:string;amountMinor:number;type:string;categoryId:string;accountId:string;date:string}>('SELECT ownerId,amountMinor,type,categoryId,accountId,date FROM "Transaction" WHERE id=?',[input.id]);
  if (existing) {
    if (existing.ownerId!==input.ownerId||existing.amountMinor!==input.amountMinor||existing.type!==input.type||existing.categoryId!==input.categoryId||existing.accountId!==input.accountId||existing.date!==date.toISOString()) throw new Error('Transaction ID was already used for different financial details.');
    return;
  }
  if (input.type === 'Expense') await assertAccountCanFund(sql, input.ownerId, input.accountId, input.amountMinor, account.currency);
  await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,toAccountId,date,note,taxStatus,taxYear,synced) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,0)',[input.id,input.ownerId,input.amountMinor/100,input.amountMinor,input.type,input.categoryId,input.categoryId,null,input.accountId,date.toISOString(),input.note.slice(0,2000),input.taxStatus ?? 'unreviewed',null]);
}

/** Enforces no-overdraft posting against the full ledger while the caller holds its write transaction. */
async function assertAccountCanFund(
  sql: Pick<ObligationsSql, 'getFirstAsync'>,
  ownerId: string,
  accountId: string,
  amountMinor: number,
  knownCurrency?: string,
): Promise<void> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Amount must be a positive integer in minor units.');
  const query = buildAccountActivitySummaryQuery(ownerId, accountId);
  const balance = await sql.getFirstAsync<{ currentBalanceMinor: number; currency?: string }>(query.sql, query.params);
  if (!balance || !Number.isSafeInteger(balance.currentBalanceMinor)) throw new Error('The account balance could not be verified. Nothing was posted.');
  if (!hasSufficientFunds(balance.currentBalanceMinor, amountMinor)) {
    const currency = knownCurrency ?? balance.currency ?? 'PKR';
    throw new Error(`Insufficient funds. Available: ${formatMinorUnits(balance.currentBalanceMinor, currency)}; required: ${formatMinorUnits(amountMinor, currency)}.`);
  }
}

async function insertObligationReversal(sql: ObligationsSql, input: { id: string; ownerId: string; originalTransactionId: string; amountMinor: number; accountId: string; date: string; note: string }): Promise<void> {
  const at=new Date(input.date);
  if(!input.id.trim()||!input.ownerId.trim()||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||!Number.isFinite(at.getTime())) throw new Error('Obligation reversal details are invalid.');
  const original=await sql.getFirstAsync<{id:string;ownerId:string;amountMinor:number;accountId:string;type:string}>('SELECT id,ownerId,amountMinor,accountId,type FROM "Transaction" WHERE id=? AND ownerId=?',[input.originalTransactionId,input.ownerId]);
  if(!original||original.amountMinor!==input.amountMinor||original.accountId!==input.accountId||!['Income','Expense'].includes(original.type)) throw new Error('The original obligation transaction cannot be reversed with these details.');
  const existing=await sql.getFirstAsync<{type:string;ownerId:string;reversalOfId:string|null;amountMinor:number}>('SELECT type,ownerId,reversalOfId,amountMinor FROM "Transaction" WHERE id=?',[input.id]);
  if(existing){if(existing.type!=='Reversal'||existing.ownerId!==input.ownerId||existing.reversalOfId!==input.originalTransactionId||existing.amountMinor!==input.amountMinor) throw new Error('Reversal ID was already used for different details.');return;}
  if(original.type==='Income') {
    const account=await sql.getFirstAsync<{currency:string}>('SELECT currency FROM Account WHERE id=? AND ownerId=?',[input.accountId,input.ownerId]);
    if(!account) throw new Error('The original income account is unavailable.');
    await assertAccountCanFund(sql,input.ownerId,input.accountId,input.amountMinor,account.currency);
  }
  await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,toAccountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,\'unreviewed\',0,?)',[input.id,input.ownerId,input.amountMinor/100,input.amountMinor,'Reversal','Obligation correction','correction_reversal',input.accountId,at.toISOString(),input.note.slice(0,2000),input.originalTransactionId]);
}

const budgetingStore = createBudgetingStore(
  async () => asBudgetingSql(await getDb()),
  async (task) => {
    const database = await getDb();
    return withLocalWrite(database, (transaction) => task(asBudgetingSql(transaction)));
  },
);

const obligationsStore = createObligationsStore(
  async () => asObligationsSql(await getDb()),
  async (task) => {
    const database = await getDb();
    return withLocalWrite(database, (transaction) => task(asObligationsSql(transaction)));
  },
);

const assetsInvestmentsStore = createAssetsInvestmentsStore(
  async () => asAssetSql(await getDb()),
  async (task) => {
    const database = await getDb();
    return withLocalWrite(database, (transaction) => task(asAssetSql(transaction)));
  },
);

const profileSetupStore = createProfileSetupStore(
  async () => asBudgetingSql(await getDb()),
  async (task) => {
    const database = await getDb();
    return withLocalWrite(database, (transaction) => task(asBudgetingSql(transaction)));
  },
);

export interface DbUser {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export type AuthResult =
  | { success: true; user: Omit<DbUser, 'passwordHash'>; passwordUpgradePending?: boolean }
  | { success: false; error: string; retryAfterSeconds?: number };

interface ExistingUserRow { id: string }
interface AccountRow {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  balanceMinor: number;
  currency: string;
  createdAt: string;
  archivedAt: string | null;
  synced: number;
}
interface TransactionRow {
  id: string;
  ownerId: string;
  amountMinor: number;
  type: string;
  categoryId: string;
  classificationId: string | null;
  accountId: string | null;
  toAccountId: string | null;
  date: string;
  note: string;
  sourceName: string | null;
  paymentMethod: string | null;
  sourceAmountMinor: number | null;
  sourceCurrency: string | null;
  exchangeRate: string | null;
  referenceNumber: string | null;
  taxStatus: string;
  taxYear: number | null;
  reversalOfId?: string | null;
  correctionOfId?: string | null;
  accountCurrency?: string | null;
  synced: number;
}

export interface LocalTransaction {
  id: string;
  ownerId: string;
  amountMinor: number;
  type: TransactionType;
  category: string;
  classificationId: string | null;
  accountId: string | null;
  toAccountId: string | null;
  date: string;
  note: string;
  sourceName: string | null;
  paymentMethod: string | null;
  sourceAmountMinor: number | null;
  sourceCurrency: string | null;
  exchangeRate: string | null;
  referenceNumber: string | null;
  taxStatus: 'unreviewed' | 'taxable' | 'non_taxable';
  taxYear: number | null;
  reversalOfId?: string | null;
  correctionOfId?: string | null;
  /** Currency of the transaction's account; null means the legacy row has no account. */
  accountCurrency: CurrencyCode | null;
  synced: boolean;
  accountName?: string | null;
  destinationName?: string | null;
  destinationCurrency?: CurrencyCode | null;
  linkedOriginalType?: TransactionType | null;
  linkedOriginalCategory?: string | null;
  linkedOriginalNote?: string | null;
  linkedOriginalId?: string | null;
  refundedMinor?: number;
  specializedContext?: string | null;
}

export interface TransactionListFilters {
  search?: string;
  types?: TransactionType[];
  startDate?: string;
  endDate?: string;
  accountId?: string;
  categoryId?: string;
  currency?: CurrencyCode;
}

export interface AccountActivitySummary {
  accountId: string;
  openingBalanceMinor: number;
  currentBalanceMinor: number;
  inflowMinor: number;
  outflowMinor: number;
  transactionCount: number;
}

function validateAccountRow(row: AccountRow): Omit<AccountRow, 'currency' | 'synced'> & { currency: CurrencyCode; synced: boolean } {
    if (!row.id || !row.ownerId || !row.name || !Number.isSafeInteger(row.balanceMinor) || row.balanceMinor < 0) {
    throw new Error('A saved account is invalid. Restore the database from a trusted backup or contact support.');
  }
  if (!isCurrencyCode(row.currency)) throw new Error(`Account ${row.id} has an unsupported currency.`);
  if (typeof row.type !== 'string' || !row.type.trim() || row.type.length > 80) throw new Error(`Account ${row.id} has an invalid type.`);
  if (row.synced !== 0 && row.synced !== 1) throw new Error(`Account ${row.id} has an invalid sync state.`);
  return { ...row, currency: row.currency, synced: row.synced === 1 };
}

type ValidatedTransactionRow = Omit<TransactionRow, 'type' | 'classificationId' | 'paymentMethod' | 'taxStatus' | 'synced'> & {
  type: TransactionType;
  classificationId: ClassificationId | null;
  paymentMethod: PaymentMethod | null;
  taxStatus: TaxStatus;
  synced: boolean;
};

function validateTransactionRow(row: TransactionRow): ValidatedTransactionRow {
  if (!row.id || !row.ownerId || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) {
    throw new Error('A saved transaction is invalid. Restore the database from a trusted backup or contact support.');
  }
  if (!Number.isFinite(new Date(row.date).getTime())) throw new Error(`Transaction ${row.id} has an invalid date.`);
  if (!isTransactionType(row.type)) {
    throw new Error(`Transaction ${row.id} has an unsupported type.`);
  }
  if (typeof row.categoryId !== 'string' || !row.categoryId.trim()) throw new Error(`Transaction ${row.id} has no category.`);
  if (row.synced !== 0 && row.synced !== 1) throw new Error(`Transaction ${row.id} has an invalid sync state.`);
  if (!isTaxStatus(row.taxStatus)) throw new Error(`Transaction ${row.id} has an invalid tax status.`);
  if (row.paymentMethod !== null && !isPaymentMethod(row.paymentMethod)) throw new Error(`Transaction ${row.id} has an invalid payment method.`);
  const classificationId = validateStoredClassification(row.type, row.classificationId);
  if (row.sourceAmountMinor !== null && (!Number.isSafeInteger(row.sourceAmountMinor) || row.sourceAmountMinor <= 0)) {
    throw new Error(`Transaction ${row.id} has an invalid original-currency amount.`);
  }
  if (row.sourceCurrency !== null && !isCurrencyCode(row.sourceCurrency)) {
    throw new Error(`Transaction ${row.id} has an unsupported original currency.`);
  }
  return {
    ...row,
    type: row.type,
    classificationId,
    paymentMethod: row.paymentMethod,
    taxStatus: row.taxStatus,
    synced: row.synced === 1,
  };
}

function accountMatchesDraft(row: AccountRow, data: ReturnType<typeof normalizeAccountDraft>): boolean {
  return row.ownerId === data.ownerId && row.name === data.name && row.type === data.type &&
    row.balanceMinor === data.balanceMinor && row.currency === data.currency;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    output += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)];
    output += index + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
    output += index + 2 < bytes.length ? alphabet[c & 63] : '=';
  }
  return output;
}

function recoveryFile(name: string): File {
  return getSqliteFile(name);
}

async function validateBackupDatabase(bytes: Uint8Array, expectedProfileId: string, envelopeSchemaVersion: number): Promise<SQLite.SQLiteDatabase> {
  const candidate = await SQLite.deserializeDatabaseAsync(bytes);
  try {
    await prepareBackupCandidate(asMigrationDatabase(candidate), expectedProfileId, envelopeSchemaVersion);
    return candidate;
  } catch (error) {
    await candidate.closeAsync();
    throw error;
  }
}

async function exportEncryptedBackup(ownerId: string, passphrase: string): Promise<void> {
  if (Platform.OS === 'web') throw new Error('Encrypted portable backups are available in the installed Android or iOS app.');
  const database = await getDb();
  const profile = await database.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [ownerId]);
  if (!profile) throw new Error('Unlock a valid local profile before creating a backup.');
  const { snapshot, version } = await runSerializedWrite(async () => {
    databaseMaintenance = true;
    try {
      await database.execAsync('PRAGMA wal_checkpoint(FULL);');
      return {
        snapshot: await database.serializeAsync(),
        version: await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version'),
      };
    } finally { databaseMaintenance = false; }
  });
  const envelope = await createPassphraseBackupEnvelope(
    expoBackupCipher,
    passphrase,
    ownerId,
    version?.user_version ?? 0,
    snapshot,
    async (count) => Crypto.getRandomBytesAsync(count),
  );
  const destination = new File(Paths.cache, `leverage-${new Date().toISOString().slice(0, 10)}.hlbk`);
  destination.create({ overwrite: true });
  destination.write(envelope);
  try {
    if (Platform.OS === 'android') {
      const selected = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!selected.granted) throw new Error('Backup export was cancelled.');
      const uri = await FileSystem.StorageAccessFramework.createFileAsync(selected.directoryUri, `Leverage-${new Date().toISOString().slice(0, 10)}`, 'application/octet-stream');
      await FileSystem.writeAsStringAsync(uri, bytesToBase64(envelope), { encoding: FileSystem.EncodingType.Base64 });
      return;
    }
    const result = await Share.share({ title: 'Leverage encrypted backup', url: destination.uri });
    if (result.action === Share.dismissedAction) throw new Error('Backup sharing was cancelled.');
  } finally {
    if (destination.exists) destination.delete();
  }
}

async function importEncryptedBackup(envelope: Uint8Array, passphrase: string, expectedProfileId: string | null): Promise<string> {
  if (Platform.OS === 'web') throw new Error('Encrypted portable restore is available in the installed Android or iOS app.');
  return runSerializedWrite(async () => {
    databaseMaintenance = true;
    try {
      const opened = await openPassphraseBackupEnvelope(expoBackupCipher, passphrase, expectedProfileId, LOCAL_DATABASE_VERSION, envelope);
      const candidate = await validateBackupDatabase(opened.database, opened.profileId, opened.schemaVersion);
      const expectedSignature = await inspectEncryptedDatabaseContent(candidate);
      await prepareKeyForVerifiedRestore();
      const pending = recoveryFile('finance.encrypted-pending.db');
      const active = recoveryFile('finance.db');
      const prior = recoveryFile('finance.pre-restore.db');
      try {
        if (pending.exists) pending.delete();
        const target = await openProtectedDatabase('finance.encrypted-pending.db');
        try {
          await SQLite.backupDatabaseAsync({ sourceDatabase: candidate, destDatabase: target });
          await target.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
        }
        finally { await target.closeAsync(); }
        await verifyEncryptedDatabase('finance.encrypted-pending.db');
        const staged = await openProtectedDatabase('finance.encrypted-pending.db', true);
        try {
          const actualSignature = await inspectEncryptedDatabaseContent(staged);
          const integrity = await staged.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
          const foreignKeys = await staged.getAllAsync('PRAGMA foreign_key_check');
          const user = await staged.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [opened.profileId]);
          if (actualSignature !== expectedSignature || integrity?.integrity_check !== 'ok' || foreignKeys.length !== 0 || !user) throw new Error('The encrypted restore verification failed.');
        } finally { await staged.closeAsync(); }
        for (const suffix of ['-wal', '-shm']) { const sidecar = recoveryFile(`finance.encrypted-pending.db${suffix}`); if (sidecar.exists) sidecar.delete(); }
      } finally { await candidate.closeAsync(); }

      if (expoDb) { await expoDb.execAsync('PRAGMA wal_checkpoint(TRUNCATE);'); await expoDb.closeAsync(); expoDb = null; }
      for (const suffix of ['-wal', '-shm']) { const sidecar = recoveryFile(`finance.db${suffix}`); if (sidecar.exists) sidecar.delete(); }
      if (prior.exists) prior.delete();
      if (active.exists) await active.move(prior);
      try {
        await pending.move(active);
        for (const suffix of ['-wal', '-shm']) { const sidecar = recoveryFile(`finance.db${suffix}`); if (sidecar.exists) sidecar.delete(); }
        await verifyEncryptedDatabase('finance.db');
        if (prior.exists) prior.delete();
      } catch (error) {
        if (active.exists) active.delete();
        for (const suffix of ['-wal', '-shm']) { const sidecar = recoveryFile(`finance.db${suffix}`); if (sidecar.exists) sidecar.delete(); }
        if (prior.exists) await prior.move(active);
        throw new Error('Restore could not be safely activated. The previous database has been preserved.', { cause: error });
      }
      return opened.profileId;
    } finally { databaseMaintenance = false; }
  });
}

export const localDb = {
  cloudIdentity: {
    /** Link an authenticated cloud profile and queue its existing cash accounts and ledger entries for idempotent import. */
    linkProfileAndQueueCoreImport: async ({ ownerId, cloudUserId }: { ownerId: string; cloudUserId: string }): Promise<{ unsupportedRecords: number }> => {
      if (!ownerId.trim() || !cloudUserId.trim() || cloudUserId.length > 200) throw new Error('A valid local profile and cloud identity are required.');
      const database = await getDb();
      const result = await withLocalWrite(database, async (transaction) => {
        const prior = await transaction.getFirstAsync<{ cloudUserId: string }>('SELECT cloudUserId FROM CloudIdentity WHERE ownerId=?', [ownerId]);
        if (prior) {
          if (prior.cloudUserId !== cloudUserId) throw new Error('This local profile is already linked to a different cloud identity.');
        }
        const user = await transaction.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [ownerId]);
        if (!user) throw new Error('The local profile was not found.');
        const now = new Date().toISOString();
        if (!prior) await transaction.runAsync('INSERT INTO CloudIdentity(ownerId,cloudUserId,linkedAt,syncEnabled) VALUES(?,?,?,1)', [ownerId,cloudUserId,now]);
        // SyncCursor is one row per local profile, keyed by ownerId alone.
        await transaction.runAsync('INSERT INTO SyncCursor(ownerId,cloudUserId,cursor,lastSuccessfulAt) VALUES(?,?,\'0\',NULL) ON CONFLICT(ownerId) DO NOTHING', [ownerId,cloudUserId]);
        const accounts = await transaction.getAllAsync<AccountRow>(`SELECT id,ownerId,name,type,balanceMinor,currency,createdAt,archivedAt,synced
          FROM Account WHERE ownerId=? ORDER BY createdAt,id`, [ownerId]);
        const accountIds = new Set(accounts.map((account) => account.id));
        for (const account of accounts) {
          const type = account.type.toLowerCase();
          if (!['cash','bank','wallet','savings'].includes(type) || !isCurrencyCode(account.currency) || !Number.isSafeInteger(account.balanceMinor)) {
            throw new Error(`Account “${account.name}” cannot be safely imported to cloud. Fix its account type or balance first.`);
          }
          const payload: CloudAccountPayload = { id: account.id, name: account.name, type: type as CloudAccountPayload['type'], currency: account.currency as CurrencyCode, openingBalanceMinor: String(account.balanceMinor) };
          const mapped = await transaction.getFirstAsync<{localId:string}>("SELECT localId FROM CloudEntityMap WHERE ownerId=? AND entityType='account' AND localId=?",[ownerId,account.id]);
          if (mapped) continue;
          const queued = await transaction.getFirstAsync<{mutationId:string}>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='account' AND entityId=? AND operation='account.create' AND status IN ('pending','in_flight','confirmed') LIMIT 1",[ownerId,account.id]);
          if (queued) continue;
          await enqueueCloudMutation(transaction, { mutationId: `import.account.create:${account.id}`, ownerId, cloudUserId, entityType: 'account', entityId: account.id, operation: 'account.create', payload, now });
          if (account.archivedAt) await enqueueCloudMutation(transaction, { mutationId: `import.account.archive:${account.id}`, ownerId, cloudUserId, entityType: 'account', entityId: account.id, operation: 'account.archive', payload: { id: account.id }, now });
        }
        const entries = await transaction.getAllAsync<{
          id:string;type:string;amountMinor:number;category:string|null;categoryId:string|null;classificationId:string|null;accountId:string|null;toAccountId:string|null;date:string;note:string|null;sourceName:string|null;paymentMethod:string|null;sourceAmountMinor:number|null;sourceCurrency:string|null;exchangeRate:string|null;referenceNumber:string|null;taxStatus:string;taxYear:number|null;reversalOfId:string|null;correctionOfId:string|null;currency:string|null;
        }>(`SELECT t.id,t.type,t.amountMinor,t.category,t.categoryId,t.classificationId,t.accountId,t.toAccountId,t.date,t.note,t.sourceName,t.paymentMethod,t.sourceAmountMinor,t.sourceCurrency,t.exchangeRate,t.referenceNumber,t.taxStatus,t.taxYear,t.reversalOfId,t.correctionOfId,a.currency
          FROM "Transaction" t LEFT JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId WHERE t.ownerId=? ORDER BY t.date,t.id`, [ownerId]);
        for (const entry of entries) {
          const types: Record<string, CloudTransactionPayload['type']> = { Income:'income', Expense:'expense', Transfer:'transfer', Refund:'refund', Reversal:'reversal' };
          const type = types[entry.type];
          if (!type || !entry.accountId || !accountIds.has(entry.accountId) || !entry.currency || !isCurrencyCode(entry.currency) || !Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0 || !isTaxStatus(entry.taxStatus) || (entry.paymentMethod !== null && !isPaymentMethod(entry.paymentMethod)) || (entry.toAccountId && !accountIds.has(entry.toAccountId))) {
            throw new Error(`Transaction ${entry.id} cannot be safely imported to cloud because its account, type, currency, or amount is invalid.`);
          }
          const payload: CloudTransactionPayload = {
            id: entry.id, type, amountMinor: String(entry.amountMinor), currency: entry.currency as CurrencyCode,
            classificationId: entry.classificationId ?? (type === 'transfer' ? 'internal_transfer' : entry.categoryId ?? 'other_expense'),
            categoryLabel: entry.category ?? entry.categoryId ?? 'Other', accountId: entry.accountId,
            ...(entry.toAccountId ? { toAccountId: entry.toAccountId } : {}), occurredAt: entry.date, note: entry.note,
            paymentMethod: entry.paymentMethod as PaymentMethod | null, sourceName: entry.sourceName,
            sourceAmountMinor: entry.sourceAmountMinor == null ? null : String(entry.sourceAmountMinor), sourceCurrency: entry.sourceCurrency,
            exchangeRate: entry.exchangeRate, referenceNumber: entry.referenceNumber, taxStatus: entry.taxStatus as TaxStatus, taxYear: entry.taxYear,
            ...(type === 'refund' && entry.reversalOfId ? { refundOfId: entry.reversalOfId } : {}),
            ...(type === 'reversal' && entry.reversalOfId ? { reversalOfId: entry.reversalOfId } : {}),
            ...(entry.correctionOfId ? { correctionOfId: entry.correctionOfId } : {}),
          };
          const mapped = await transaction.getFirstAsync<{localId:string}>("SELECT localId FROM CloudEntityMap WHERE ownerId=? AND entityType='transaction' AND localId=?",[ownerId,entry.id]);
          if (mapped) continue;
          const queued = await transaction.getFirstAsync<{mutationId:string}>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='transaction' AND entityId=? AND operation='transaction.create' AND status IN ('pending','in_flight','confirmed') LIMIT 1",[ownerId,entry.id]);
          if (queued) continue;
          await enqueueCloudMutation(transaction, { mutationId: `import.transaction.create:${entry.id}`, ownerId, cloudUserId, entityType: 'transaction', entityId: entry.id, operation: 'transaction.create', payload, dependencyEntityId: entry.reversalOfId ?? entry.correctionOfId ?? entry.accountId, now });
        }
        // Existing schedules are not automatically captured by the write triggers
        // when a profile is linked after those rows were created. Queue them here
        // before domain children; the uploader waits for their account/bill FKs.
        const schedules = await transaction.getAllAsync<{
          id:string;scheduleType:string;name:string;amountMinor:number;currency:string;classificationId:string|null;accountId:string;toAccountId:string|null;billId:string|null;frequency:string;startDate:string;endDate:string|null;nextDueDate:string;status:string;createdAt:string;updatedAt:string;
        }>('SELECT id,scheduleType,name,amountMinor,currency,classificationId,accountId,toAccountId,billId,frequency,startDate,endDate,nextDueDate,status,createdAt,updatedAt FROM RecurringSchedule WHERE ownerId=? ORDER BY createdAt,id',[ownerId]);
        let importedScheduleRecords = 0;
        for (const schedule of schedules) {
          importedScheduleRecords++;
          if (!accountIds.has(schedule.accountId) || (schedule.toAccountId && !accountIds.has(schedule.toAccountId))) {
            throw new Error(`Recurring schedule ${schedule.id} cannot be safely imported because an account is missing.`);
          }
          const mapped = await transaction.getFirstAsync<{localId:string}>("SELECT localId FROM CloudEntityMap WHERE ownerId=? AND entityType='recurring_schedule' AND localId=?",[ownerId,schedule.id]);
          if (mapped) continue;
          const queued = await transaction.getFirstAsync<{mutationId:string}>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='recurring_schedule' AND entityId=? AND operation='recurring.schedule.create' AND status IN ('pending','in_flight','confirmed') LIMIT 1",[ownerId,schedule.id]);
          if (queued) continue;
          const payload = {
            id:schedule.id,scheduleType:schedule.scheduleType,name:schedule.name,amountMinor:String(schedule.amountMinor),currency:schedule.currency,
            classificationId:schedule.classificationId,accountId:schedule.accountId,toAccountId:schedule.toAccountId,billId:schedule.billId,
            frequency:schedule.frequency,startDate:schedule.startDate,endDate:schedule.endDate,nextDueDate:schedule.nextDueDate,status:schedule.status,
            createdAt:schedule.createdAt,updatedAt:schedule.updatedAt,
          };
          await enqueueCloudMutation(transaction,{mutationId:`import.recurring.schedule.create:${schedule.id}`,ownerId,cloudUserId,entityType:'recurring_schedule',entityId:schedule.id,operation:'recurring.schedule.create',payload,dependencyEntityId:schedule.billId ?? schedule.accountId,now});
        }
        const occurrences = await transaction.getAllAsync<{
          id:string;scheduleId:string;occurrenceDate:string;status:string;transactionId:string|null;createdAt:string;resolvedAt:string|null;
        }>('SELECT id,scheduleId,occurrenceDate,status,transactionId,createdAt,resolvedAt FROM ScheduleOccurrence WHERE ownerId=? ORDER BY occurrenceDate,id',[ownerId]);
        let importedOccurrenceRecords = 0;
        for (const occurrence of occurrences) {
          importedOccurrenceRecords++;
          if (occurrence.status === 'posted' && !occurrence.transactionId) throw new Error(`Posted occurrence ${occurrence.id} has no linked transaction.`);
          const mapped = await transaction.getFirstAsync<{localId:string}>("SELECT localId FROM CloudEntityMap WHERE ownerId=? AND entityType='schedule_occurrence' AND localId=?",[ownerId,occurrence.id]);
          if (mapped) continue;
          const queued = await transaction.getFirstAsync<{mutationId:string}>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='schedule_occurrence' AND entityId=? AND operation='schedule.occurrence.create' AND status IN ('pending','in_flight','confirmed') LIMIT 1",[ownerId,occurrence.id]);
          if (queued) continue;
          await enqueueCloudMutation(transaction,{mutationId:`import.schedule.occurrence.create:${occurrence.id}`,ownerId,cloudUserId,entityType:'schedule_occurrence',entityId:occurrence.id,operation:'schedule.occurrence.create',payload:{id:occurrence.id,scheduleId:occurrence.scheduleId,occurrenceDate:occurrence.occurrenceDate,status:'pending',createdAt:occurrence.createdAt},dependencyEntityId:occurrence.scheduleId,now});
          if (occurrence.status !== 'pending') {
            await enqueueCloudMutation(transaction,{mutationId:`import.schedule.occurrence.resolve:${occurrence.id}`,ownerId,cloudUserId,entityType:'schedule_occurrence',entityId:occurrence.id,operation:'schedule.occurrence.resolve',payload:{id:occurrence.id,scheduleId:occurrence.scheduleId,status:occurrence.status,transactionId:occurrence.transactionId,resolvedAt:occurrence.resolvedAt,expectedRevision:1},dependencyEntityId:occurrence.scheduleId,now});
          }
        }
        const domainSpecs: {table:string;type:OutboxMutation['entityType'];columns:string[];parentType?:string;parentColumn?:string;accountColumn?:string;transactionColumn?:string;scheduleColumn?:string}[] = [
          {table:'Bill',type:'bill',columns:['id','name','categoryId','amountMinor','currency','dueDate','accountId','scheduleId','status','reminderId','createdAt','updatedAt'],accountColumn:'accountId',scheduleColumn:'scheduleId'},
          {table:'Debt',type:'debt',columns:['id','direction','counterparty','principalMinor','currency','accountId','interestRateBps','openedAt','dueDate','status','createdAt','updatedAt'],accountColumn:'accountId'},
          {table:'Asset',type:'asset',columns:['id','name','category','currency','purchaseValueMinor','purchaseDate','ownershipBps','notes','createdAt']},
          {table:'InvestmentPortfolio',type:'investment_portfolio',columns:['id','name','currency','cashAccountId','createdAt'],accountColumn:'cashAccountId'},
          {table:'BillPayment',type:'bill_payment',columns:['id','billId','amountMinor','transactionId','paidAt','idempotencyKey','createdAt'],parentType:'bill',parentColumn:'billId',transactionColumn:'transactionId'},
          {table:'BillPaymentCorrection',type:'bill_payment_correction',columns:['id','billId','originalPaymentId','reversalTransactionId','replacementPaymentId','reason','createdAt'],parentType:'bill',parentColumn:'billId',transactionColumn:'reversalTransactionId'},
          {table:'DebtEvent',type:'debt_event',columns:['id','debtId','eventType','principalMinor','interestMinor','accountId','transactionId','eventDate','idempotencyKey','note','createdAt'],parentType:'debt',parentColumn:'debtId',accountColumn:'accountId',transactionColumn:'transactionId'},
          {table:'DebtInterestEvent',type:'debt_interest_event',columns:['id','debtId','eventType','amountMinor','reversalOfEventId','eventDate','idempotencyKey','note','createdAt'],parentType:'debt',parentColumn:'debtId'},
          {table:'DebtEventCorrection',type:'debt_event_correction',columns:['id','debtId','originalEventId','reversalTransactionId','replacementEventId','reason','createdAt'],parentType:'debt',parentColumn:'debtId',transactionColumn:'reversalTransactionId'},
          {table:'DebtRepaymentSchedule',type:'debt_repayment_schedule',columns:['id','debtId','frequency','firstDueDate','installmentAmountMinor','interestMethod','rateBps','installmentCount','status','createdAt','updatedAt'],parentType:'debt',parentColumn:'debtId'},
          {table:'AssetValuation',type:'asset_valuation',columns:['id','assetId','valueMinor','valuationDate','source','idempotencyKey','createdAt'],parentType:'asset',parentColumn:'assetId'},
          {table:'AssetActivity',type:'asset_activity',columns:['id','assetId','eventType','ownershipBps','costBasisMinor','proceedsMinor','accountId','transactionId','eventDate','idempotencyKey','createdAt'],parentType:'asset',parentColumn:'assetId',accountColumn:'accountId',transactionColumn:'transactionId'},
          {table:'InvestmentHolding',type:'investment_holding',columns:['id','portfolioId','symbol','name','category','currency','createdAt'],parentType:'investment_portfolio',parentColumn:'portfolioId'},
          {table:'InvestmentEvent',type:'investment_event',columns:['id','holdingId','eventType','quantityMicros','unitPriceMinor','feeMinor','amountMinor','splitNumerator','splitDenominator','transactionId','eventDate','idempotencyKey','createdAt'],parentType:'investment_holding',parentColumn:'holdingId',transactionColumn:'transactionId'},
          {table:'InvestmentPrice',type:'investment_price',columns:['id','holdingId','unitPriceMinor','priceDate','source','idempotencyKey','createdAt'],parentType:'investment_holding',parentColumn:'holdingId'},
        ];
        let importedDomainRecords = 0;
        for (const spec of domainSpecs) {
          const rows = await transaction.getAllAsync<Record<string,unknown>>(`SELECT ${spec.columns.map((column)=>`"${column}"`).join(',')} FROM "${spec.table}" WHERE ownerId=? ORDER BY id`,[ownerId]);
          for (const row of rows) {
            const id = String(row.id ?? '');
            if (!id) throw new Error(`A local ${spec.type} record has no stable ID.`);
            // Count recognized domain rows even when already mapped/queued so the
            // legacy unsupported-record report does not misclassify synced data.
            importedDomainRecords++;
            const mapped = await transaction.getFirstAsync<{localId:string}>('SELECT localId FROM CloudEntityMap WHERE ownerId=? AND entityType=? AND localId=?',[ownerId,spec.type,id]);
            if (mapped) continue;
            const queued = await transaction.getFirstAsync<{mutationId:string}>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType=? AND entityId=? AND operation IN ('domain.create','domain.update') AND status IN ('pending','in_flight','confirmed') LIMIT 1",[ownerId,spec.type,id]);
            if (queued) continue;
            const data = Object.fromEntries(spec.columns.map((column)=>[column,row[column] ?? null]));
            // A bill and its recurring schedule reference each other. Post the
            // bill first without the FK, then apply a revisioned link after the
            // schedule is confirmed, avoiding an impossible import dependency cycle.
            if (spec.type === 'bill' && typeof row.scheduleId === 'string') data.scheduleId = null;
            const payload: Record<string,unknown> = {
              entityType:spec.type,id,
              parentType:spec.parentType ?? null,
              parentId:spec.parentColumn ? row[spec.parentColumn] ?? null : null,
              accountId:spec.accountColumn ? row[spec.accountColumn] ?? null : null,
              transactionId:spec.transactionColumn ? row[spec.transactionColumn] ?? null : null,
              scheduleId:spec.scheduleColumn && spec.type !== 'bill' ? row[spec.scheduleColumn] ?? null : null,
              data,
            };
            await enqueueCloudMutation(transaction,{mutationId:`import.domain:${spec.type}:${id}`,ownerId,cloudUserId,entityType:spec.type,entityId:id,operation:'domain.create',payload,dependencyEntityId:(payload.parentId ?? payload.accountId ?? payload.transactionId ?? payload.scheduleId) as string|null,now});
            if (spec.type === 'bill' && typeof row.scheduleId === 'string') {
              await enqueueCloudMutation(transaction,{mutationId:`import.domain.bill.schedule-link:${id}`,ownerId,cloudUserId,entityType:'bill',entityId:id,operation:'domain.update',payload:{...payload,scheduleId:row.scheduleId,data:{...data,scheduleId:row.scheduleId},expectedRevision:1},dependencyEntityId:row.scheduleId,now});
            }
          }
        }
        const total = await countLocalFinancialRecords(transaction, ownerId);
        const correctionLinks = await transaction.getFirstAsync<{count:number}>(`SELECT
          (SELECT COUNT(*) FROM BillPaymentCorrectionReplacement r JOIN BillPaymentCorrection c ON c.id=r.correctionId WHERE c.ownerId=?) +
          (SELECT COUNT(*) FROM DebtEventCorrectionReplacement r JOIN DebtEventCorrection c ON c.id=r.correctionId WHERE c.ownerId=?) AS count`,[ownerId,ownerId]);
        const importedCore = accounts.length + entries.length;
        return { unsupportedRecords: Math.max(0, total - importedCore - importedScheduleRecords - importedOccurrenceRecords - importedDomainRecords - (correctionLinks?.count ?? 0)) };
      });
      wakeSync(ownerId);
      return result;
    },
    get: async (ownerId: string): Promise<{ cloudUserId: string; linkedAt: string; syncEnabled: boolean } | null> => {
      const database = await getDb();
      const row = await database.getFirstAsync<{ cloudUserId: string; linkedAt: string; syncEnabled: number }>(
        'SELECT cloudUserId,linkedAt,syncEnabled FROM CloudIdentity WHERE ownerId=?', [ownerId],
      );
      return row ? { ...row, syncEnabled: row.syncEnabled === 1 } : null;
    },
  },
  syncOutbox: {
    pendingCount: async (ownerId: string): Promise<number> => {
      const database = await getDb();
      const row = await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM SyncOutbox WHERE ownerId=? AND status IN ('pending','in_flight')", [ownerId]);
      return row?.count ?? 0;
    },
    rejectedCount: async (ownerId: string): Promise<number> => {
      const database = await getDb();
      const row = await database.getFirstAsync<{count:number}>("SELECT COUNT(*) AS count FROM SyncOutbox WHERE ownerId=? AND status='rejected'", [ownerId]);
      return row?.count ?? 0;
    },
    rejectedItems: async (ownerId: string): Promise<{ mutationId:string;entityType:string;entityId:string;operation:string;errorCategory:string|null;createdAt:string }[]> => {
      const database = await getDb();
      return database.getAllAsync('SELECT mutationId,entityType,entityId,operation,lastErrorCategory AS errorCategory,createdAt FROM SyncOutbox WHERE ownerId=? AND status=\'rejected\' ORDER BY updatedAt DESC,mutationId LIMIT 5', [ownerId]);
    },
    claimNext: async ({ ownerId, cloudUserId, now = Date.now(), leaseMs = 60_000 }: { ownerId: string; cloudUserId: string; now?: number; leaseMs?: number }) => {
      const database = await getDb();
      return withLocalWrite(database, async (transaction) => {
        const identity = await transaction.getFirstAsync<{ cloudUserId: string }>('SELECT cloudUserId FROM CloudIdentity WHERE ownerId=? AND syncEnabled=1', [ownerId]);
        if (identity?.cloudUserId !== cloudUserId) throw new Error('Cloud profile changed; pending records were not uploaded.');
        const nowIso = new Date(now).toISOString();
        await transaction.runAsync("UPDATE SyncOutbox SET status='pending',leaseUntil=NULL,updatedAt=? WHERE ownerId=? AND cloudUserId=? AND status='in_flight' AND leaseUntil<=?", [nowIso,ownerId,cloudUserId,nowIso]);
        const row = await transaction.getFirstAsync<{ mutationId:string;ownerId:string;cloudUserId:string;entityType:OutboxMutation['entityType'];entityId:string;operation:OutboxMutation['operation'];payloadJson:string;dependencyEntityId:string|null;attemptCount:number }>(`SELECT mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadJson,dependencyEntityId,attemptCount
          FROM SyncOutbox WHERE ownerId=? AND cloudUserId=? AND status='pending' AND nextAttemptAt<=? AND attemptCount<20
          ORDER BY CASE
            WHEN operation='account.create' THEN 0
            WHEN operation IN ('budget.create','saving.goal.create','emergency.config.save') THEN 1
            WHEN operation='recurring.schedule.create' AND json_extract(payloadJson,'$.scheduleType')!='bill' THEN 1
            WHEN operation='transaction.create' AND json_extract(payloadJson,'$.correctionOfId') IS NULL AND json_extract(payloadJson,'$.type') NOT IN ('refund','reversal') THEN 2
            WHEN operation='transaction.create' AND json_extract(payloadJson,'$.correctionOfId') IS NULL THEN 3
            WHEN operation='domain.create' AND entityType IN ('bill','debt','asset','investment_portfolio') THEN 4
            WHEN operation='recurring.schedule.create' THEN 5
            WHEN operation='transaction.create' THEN 5
            WHEN operation='domain.create' AND entityType IN ('bill_payment','debt_event','debt_interest_event','debt_repayment_schedule','asset_valuation','asset_activity','investment_holding') THEN 6
            WHEN operation='domain.create' THEN 7 WHEN operation='domain.update' THEN 8
            WHEN operation='schedule.occurrence.create' THEN 9 ELSE 10 END,createdAt,mutationId LIMIT 1`, [ownerId,cloudUserId,now]);
        if (!row) return null;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(row.payloadJson) as Record<string, unknown>; }
        catch { await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory='invalid_local_payload',updatedAt=? WHERE mutationId=?", [nowIso,row.mutationId]); return null; }
        if (row.operation === 'transaction.create') {
          const accountIds = [payload.accountId, payload.toAccountId].filter((id): id is string => typeof id === 'string');
          for (const accountId of accountIds) {
            const mapped = await transaction.getFirstAsync<{ cloudId:string }>("SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType='account' AND localId=?", [ownerId,accountId]);
            const pendingCreate = await transaction.getFirstAsync<{ mutationId:string }>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='account' AND entityId=? AND operation='account.create' AND status IN ('pending','in_flight')", [ownerId,accountId]);
            if (!mapped && !pendingCreate) {
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory='account_dependency_missing',updatedAt=? WHERE mutationId=?", [nowIso,row.mutationId]);
              return null;
            }
            if (!mapped) return null;
          }
          if (payload.type === 'refund' && typeof payload.refundOfId === 'string') {
            const originalMap = await transaction.getFirstAsync<{ cloudId: string }>("SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType='transaction' AND localId=?", [ownerId,payload.refundOfId]);
            if (!originalMap) {
              const originalPending = await transaction.getFirstAsync<{ mutationId: string }>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='transaction' AND entityId=? AND operation='transaction.create' AND status IN ('pending','in_flight')", [ownerId,payload.refundOfId]);
              if (originalPending) return null;
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory='refund_dependency_missing',updatedAt=? WHERE mutationId=?", [nowIso,row.mutationId]);
              return null;
            }
          }
          if (payload.type === 'reversal' && typeof payload.reversalOfId === 'string') {
            const originalMap = await transaction.getFirstAsync<{ cloudId:string }>("SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType='transaction' AND localId=?", [ownerId,payload.reversalOfId]);
            if (!originalMap) {
              const originalPending = await transaction.getFirstAsync<{ mutationId:string }>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='transaction' AND entityId=? AND operation='transaction.create' AND status IN ('pending','in_flight')", [ownerId,payload.reversalOfId]);
              if (originalPending) return null;
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory='reversal_dependency_missing',updatedAt=? WHERE mutationId=?", [nowIso,row.mutationId]);
              return null;
            }
          }
          if (typeof payload.correctionOfId === 'string') {
            const originalMap = await transaction.getFirstAsync<{ cloudId:string }>("SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType='transaction' AND localId=?", [ownerId,payload.correctionOfId]);
            const reversal = await transaction.getFirstAsync<{ id:string }>("SELECT id FROM \"Transaction\" WHERE ownerId=? AND type='Reversal' AND reversalOfId=?", [ownerId,payload.correctionOfId]);
            const reversalMap = reversal ? await transaction.getFirstAsync<{ cloudId:string }>("SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType='transaction' AND localId=?", [ownerId,reversal.id]) : null;
            const reversalPending = reversal && await transaction.getFirstAsync<{ mutationId:string }>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='transaction' AND entityId=? AND operation='transaction.create' AND status IN ('pending','in_flight')", [ownerId,reversal.id]);
            if (!originalMap || !reversalMap) {
              if (reversalPending || (!reversal && originalMap)) return null;
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory='correction_dependency_missing',updatedAt=? WHERE mutationId=?", [nowIso,row.mutationId]);
              return null;
            }
          }
        }
        if (row.operation === 'budget.revise' && typeof payload.budgetId === 'string') {
          const originalMap = await transaction.getFirstAsync<{cloudId:string}>("SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType='budget' AND localId=?", [ownerId,payload.budgetId]);
          if (!originalMap) {
            const originalPending = await transaction.getFirstAsync<{mutationId:string}>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='budget' AND entityId=? AND operation='budget.create' AND status IN ('pending','in_flight')", [ownerId,payload.budgetId]);
            if (originalPending) return null;
            await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory='budget_dependency_missing',updatedAt=? WHERE mutationId=?", [nowIso,row.mutationId]);
            return null;
          }
        }
        if (row.operation === 'budget.archive') {
          const mapped = await transaction.getFirstAsync<{cloudId:string}>("SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType='budget' AND localId=?", [ownerId,row.entityId]);
          if (!mapped) {
            const pendingCreate = await transaction.getFirstAsync<{mutationId:string}>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType='budget' AND entityId=? AND operation IN ('budget.create','budget.revise') AND status IN ('pending','in_flight')", [ownerId,row.entityId]);
            if (pendingCreate) return null;
            await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory='budget_dependency_missing',updatedAt=? WHERE mutationId=?", [nowIso,row.mutationId]);
            return null;
          }
        }
        const dependencyChecks: { entityType: string; id: unknown; error: string }[] = [];
        if (row.operation === 'recurring.schedule.create' || row.operation === 'recurring.schedule.update') {
          dependencyChecks.push({ entityType: 'account', id: payload.accountId, error: 'account_dependency_missing' });
          if (typeof payload.toAccountId === 'string') dependencyChecks.push({ entityType: 'account', id: payload.toAccountId, error: 'account_dependency_missing' });
          if (typeof payload.billId === 'string') dependencyChecks.push({ entityType: 'bill', id: payload.billId, error: 'bill_dependency_missing' });
          if (row.operation === 'recurring.schedule.update') dependencyChecks.push({ entityType: 'recurring_schedule', id: row.entityId, error: 'recurring_schedule_dependency_missing' });
        }
        if (row.operation === 'schedule.occurrence.create' || row.operation === 'schedule.occurrence.resolve') {
          dependencyChecks.push({ entityType: 'recurring_schedule', id: payload.scheduleId, error: 'recurring_schedule_dependency_missing' });
        }
        if (row.operation === 'schedule.occurrence.resolve') {
          dependencyChecks.push({ entityType: 'schedule_occurrence', id: row.entityId, error: 'schedule_occurrence_dependency_missing' });
          if (typeof payload.transactionId === 'string') dependencyChecks.push({ entityType: 'transaction', id: payload.transactionId, error: 'transaction_dependency_missing' });
        }
        if (row.operation === 'saving.goal.update' || row.operation === 'saving.goal.event') {
          dependencyChecks.push({ entityType: 'savings_goal', id: row.operation === 'saving.goal.event' ? payload.goalId : row.entityId, error: 'saving_goal_dependency_missing' });
        }
        if (row.operation === 'emergency.event') dependencyChecks.push({ entityType: 'emergency_config', id: ownerId, error: 'emergency_config_dependency_missing' });
        if (row.operation === 'domain.create' || row.operation === 'domain.update') {
          if (typeof payload.parentType === 'string' && typeof payload.parentId === 'string') dependencyChecks.push({ entityType: payload.parentType, id: payload.parentId, error: 'domain_parent_dependency_missing' });
          if (typeof payload.accountId === 'string') dependencyChecks.push({ entityType: 'account', id: payload.accountId, error: 'account_dependency_missing' });
          if (typeof payload.transactionId === 'string') dependencyChecks.push({ entityType: 'transaction', id: payload.transactionId, error: 'transaction_dependency_missing' });
          if (typeof payload.scheduleId === 'string') dependencyChecks.push({ entityType: 'recurring_schedule', id: payload.scheduleId, error: 'schedule_dependency_missing' });
          const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string,unknown> : {};
          if (row.entityType === 'bill_payment_correction') {
            if (typeof data.originalPaymentId === 'string') dependencyChecks.push({ entityType: 'bill_payment', id: data.originalPaymentId, error: 'bill_payment_dependency_missing' });
            if (typeof data.replacementPaymentId === 'string') dependencyChecks.push({ entityType: 'bill_payment', id: data.replacementPaymentId, error: 'bill_payment_dependency_missing' });
          }
          if (row.entityType === 'debt_event_correction') {
            if (typeof data.originalEventId === 'string') dependencyChecks.push({ entityType: 'debt_event', id: data.originalEventId, error: 'debt_event_dependency_missing' });
            if (typeof data.replacementEventId === 'string') dependencyChecks.push({ entityType: 'debt_event', id: data.replacementEventId, error: 'debt_event_dependency_missing' });
          }
        }
        if (row.operation === 'saving.goal.event' || row.operation === 'emergency.event') {
          for (const key of ['accountId','sourceAccountId','destinationAccountId']) {
            if (typeof payload[key] === 'string') dependencyChecks.push({ entityType: 'account', id: payload[key], error: 'account_dependency_missing' });
          }
        }
        for (const dependency of dependencyChecks) {
          const id = typeof dependency.id === 'string' ? dependency.id : '';
          if (!id) continue;
          const mapping = await transaction.getFirstAsync<{ cloudId: string }>('SELECT cloudId FROM CloudEntityMap WHERE ownerId=? AND entityType=? AND localId=?', [ownerId,dependency.entityType,id]);
          if (mapping) continue;
          const pending = await transaction.getFirstAsync<{ mutationId: string }>("SELECT mutationId FROM SyncOutbox WHERE ownerId=? AND entityType=? AND entityId=? AND status IN ('pending','in_flight') LIMIT 1", [ownerId,dependency.entityType,id]);
          if (pending) return null;
          await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',lastErrorCategory=?,updatedAt=? WHERE mutationId=?", [dependency.error,nowIso,row.mutationId]);
          return null;
        }
        const leaseUntil = new Date(now + leaseMs).toISOString();
        await transaction.runAsync("UPDATE SyncOutbox SET status='in_flight',leaseUntil=?,attemptCount=attemptCount+1,updatedAt=? WHERE mutationId=? AND status='pending'", [leaseUntil,nowIso,row.mutationId]);
        return { ...row, payload, attemptCount: row.attemptCount + 1 };
      });
    },
    acknowledge: async ({ ownerId, cloudUserId, mutationId, response, now = new Date().toISOString() }: { ownerId:string;cloudUserId:string;mutationId:string;response:Record<string,unknown>;now?:string }): Promise<void> => {
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const identity = await transaction.getFirstAsync<{cloudUserId:string}>('SELECT cloudUserId FROM CloudIdentity WHERE ownerId=? AND syncEnabled=1', [ownerId]);
        if (identity?.cloudUserId !== cloudUserId) throw new Error('Cloud profile changed during upload; acknowledgment was not applied.');
        const row = await transaction.getFirstAsync<{entityType:string;entityId:string;operation:string;status:string}>('SELECT entityType,entityId,operation,status FROM SyncOutbox WHERE mutationId=? AND ownerId=? AND cloudUserId=?', [mutationId,ownerId,cloudUserId]);
        if (!row) throw new Error('The pending synchronization operation no longer exists.');
        if (row.status === 'confirmed') return;
        const data = response.data && typeof response.data === 'object' ? response.data as Record<string,unknown> : response;
        const cloudId = typeof data.id === 'string' ? data.id : row.entityId;
        const revision = Number.isSafeInteger(data.revision) ? Number(data.revision) : null;
        await transaction.runAsync(`UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,serverAckJson=?,updatedAt=? WHERE mutationId=? AND ownerId=?`, [JSON.stringify(response),now,mutationId,ownerId]);
        await transaction.runAsync(`INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,?,?,?,?)
          ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=COALESCE(excluded.serverRevision,CloudEntityMap.serverRevision)`, [ownerId,row.entityType,row.entityId,cloudId,revision]);
        if (row.entityType === 'account') await transaction.runAsync('UPDATE Account SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
        if (row.entityType === 'transaction') await transaction.runAsync('UPDATE "Transaction" SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
        if (row.entityType === 'budget') await transaction.runAsync('UPDATE Budget SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
        if (row.entityType === 'savings_goal') await transaction.runAsync('UPDATE SavingsGoal SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
        if (row.entityType === 'savings_goal_event') await transaction.runAsync('UPDATE SavingsGoalEvent SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
        if (row.entityType === 'emergency_config') await transaction.runAsync('UPDATE EmergencyFundConfig SET synced=1 WHERE ownerId=?', [ownerId]);
        if (row.entityType === 'emergency_event') await transaction.runAsync('UPDATE EmergencyFundEvent SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
        if (row.entityType === 'recurring_schedule') await transaction.runAsync('UPDATE RecurringSchedule SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
        if (row.entityType === 'schedule_occurrence') await transaction.runAsync('UPDATE ScheduleOccurrence SET synced=1 WHERE id=? AND ownerId=?', [row.entityId,ownerId]);
      });
    },
    fail: async ({ ownerId, mutationId, category, retryAt, permanent = false, now = new Date().toISOString() }: { ownerId:string;mutationId:string;category:string;retryAt?:number;permanent?:boolean;now?:string }): Promise<void> => {
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const row = await transaction.getFirstAsync<{attemptCount:number}>('SELECT attemptCount FROM SyncOutbox WHERE ownerId=? AND mutationId=?', [ownerId,mutationId]);
        if (!row) return;
        const reject = permanent || row.attemptCount >= 20;
        await transaction.runAsync(`UPDATE SyncOutbox SET status=?,leaseUntil=NULL,lastErrorCategory=?,nextAttemptAt=?,updatedAt=? WHERE ownerId=? AND mutationId=? AND status!='confirmed'`, [reject?'rejected':'pending',category.slice(0,80),retryAt ?? 0,now,ownerId,mutationId]);
      });
    },
    cursor: async ({ ownerId, cloudUserId }: { ownerId:string;cloudUserId:string }): Promise<string> => {
      const database = await getDb();
      const row = await database.getFirstAsync<{cursor:string}>('SELECT cursor FROM SyncCursor WHERE ownerId=? AND cloudUserId=?', [ownerId,cloudUserId]);
      if (!row) throw new Error('This local profile is not linked to the authenticated cloud identity.');
      return row.cursor;
    },
    lastSuccessfulAt: async (ownerId: string): Promise<string | null> => {
      const database = await getDb();
      const row = await database.getFirstAsync<{ lastSuccessfulAt: string | null }>('SELECT lastSuccessfulAt FROM SyncCursor WHERE ownerId=?', [ownerId]);
      return row?.lastSuccessfulAt ?? null;
    },
    markSuccessful: async ({ ownerId, cloudUserId, now = new Date().toISOString() }: { ownerId:string;cloudUserId:string;now?:string }): Promise<void> => {
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const identity = await transaction.getFirstAsync<{cloudUserId:string}>('SELECT cloudUserId FROM CloudIdentity WHERE ownerId=? AND syncEnabled=1', [ownerId]);
        if (identity?.cloudUserId !== cloudUserId) throw new Error('Cloud profile changed before sync completion could be recorded.');
        await transaction.runAsync('UPDATE SyncCursor SET lastSuccessfulAt=? WHERE ownerId=? AND cloudUserId=?', [now,ownerId,cloudUserId]);
      });
    },
    applyChanges: async ({ ownerId, cloudUserId, changes, nextCursor, now = new Date().toISOString() }: { ownerId:string;cloudUserId:string;changes:Record<string,unknown>[];nextCursor:string;now?:string }): Promise<void> => {
      if (!/^(0|[1-9]\d{0,18})$/.test(nextCursor)) throw new Error('The cloud synchronization cursor is invalid.');
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const identity = await transaction.getFirstAsync<{cloudUserId:string}>('SELECT cloudUserId FROM CloudIdentity WHERE ownerId=? AND syncEnabled=1', [ownerId]);
        if (identity?.cloudUserId !== cloudUserId) throw new Error('Cloud profile changed while downloading records.');
        const cursor = await transaction.getFirstAsync<{cursor:string}>('SELECT cursor FROM SyncCursor WHERE ownerId=? AND cloudUserId=?', [ownerId,cloudUserId]);
        if (!cursor) throw new Error('The synchronization cursor is unavailable.');
        validateCloudChangePage(cursor.cursor,nextCursor,changes);
        for (const change of changes) {
          const serverRevision=typeof change.revision==='number'&&Number.isSafeInteger(change.revision)&&change.revision>0?change.revision:null;
          if(serverRevision===null)throw new Error('A cloud change has an invalid server revision.');
          if (change.entityType === 'account') {
            if (!change.payload || typeof change.payload !== 'object' || Array.isArray(change.payload)) throw new Error('A cloud account change has an invalid payload.');
            const p = change.payload as Record<string,unknown>;
            const id = String(p.id ?? change.entityId ?? '');
            if (!id || id !== change.entityId) throw new Error('A cloud account change is missing its stable ID.');
            const existing = await transaction.getFirstAsync<{ownerId:string;name:string;type:string;currency:string;balanceMinor:number;archivedAt:string|null;synced:number}>('SELECT ownerId,name,type,currency,balanceMinor,archivedAt,synced FROM Account WHERE id=?', [id]);
            if (p.archivedAt !== undefined && p.name === undefined) {
              if (existing?.ownerId === ownerId) await transaction.runAsync('UPDATE Account SET archivedAt=?,synced=1 WHERE id=? AND ownerId=?', [nullableCloudText(p.archivedAt),id,ownerId]);
            } else {
              const name = String(p.name ?? ''); const type = String(p.type ?? ''); const currency = String(p.currency ?? '');
              const opening = Number(p.openingBalanceMinor);
              if (!name || !['cash','bank','wallet','savings'].includes(type) || !isCurrencyCode(currency) || !Number.isSafeInteger(opening)) throw new Error('A cloud account change contains unsupported financial data.');
              if (existing && existing.ownerId !== ownerId) throw new Error('A cloud account ID collides with another local profile.');
              if (existing && existing.synced === 0 && (existing.name !== name || existing.type !== type || existing.currency !== currency || existing.balanceMinor !== opening)) {
                await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',leaseUntil=NULL,lastErrorCategory='server_local_conflict',updatedAt=? WHERE ownerId=? AND entityType='account' AND entityId=? AND status!='confirmed'", [now,ownerId,id]);
                continue;
              }
              if (!existing) await transaction.runAsync('INSERT INTO Account(id,ownerId,name,type,balance,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,?,1)', [id,ownerId,name,type,opening/100,opening,currency,String(p.createdAt ?? now)]);
              else await transaction.runAsync('UPDATE Account SET name=?,type=?,archivedAt=?,synced=1 WHERE id=? AND ownerId=?', [name,type,p.archivedAt == null ? null : String(p.archivedAt),id,ownerId]);
            }
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'account',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision", [ownerId,id,id,Number.isSafeInteger(p.revision)?Number(p.revision):null]);
          } else if (change.entityType === 'transaction') {
            if (!change.payload || typeof change.payload !== 'object' || Array.isArray(change.payload)) throw new Error('A cloud transaction change has an invalid payload.');
            const p = change.payload as Record<string,unknown>;
            const id = String(p.id ?? change.entityId ?? '');
            const amount = Number(p.amountMinor);
            const type = p.type === 'income' ? 'Income' : p.type === 'expense' ? 'Expense' : p.type === 'transfer' ? 'Transfer' : p.type === 'refund' ? 'Refund' : p.type === 'reversal' ? 'Reversal' : '';
            const currency = String(p.currency ?? '');
            if (!id || id !== change.entityId || !type || !Number.isSafeInteger(amount) || amount <= 0 || !isCurrencyCode(currency) || typeof p.accountId !== 'string' || typeof p.occurredAt !== 'string' || !Number.isFinite(Date.parse(p.occurredAt))) throw new Error('A cloud transaction change contains unsupported financial data.');
            const sourceAccountId = p.accountId;
            const existing = await transaction.getFirstAsync<{ownerId:string;amountMinor:number;type:string;accountId:string|null;toAccountId:string|null;date:string;categoryId:string;category:string;note:string|null;paymentMethod:string|null;sourceName:string|null;sourceAmountMinor:number|null;sourceCurrency:string|null;exchangeRate:string|null;referenceNumber:string|null;taxStatus:string;taxYear:number|null;reversalOfId:string|null;correctionOfId:string|null;synced:number}>('SELECT ownerId,amountMinor,type,accountId,toAccountId,date,categoryId,category,note,paymentMethod,sourceName,sourceAmountMinor,sourceCurrency,exchangeRate,referenceNumber,taxStatus,taxYear,reversalOfId,correctionOfId,synced FROM "Transaction" WHERE id=?', [id]);
            if (existing && existing.ownerId !== ownerId) throw new Error('A cloud transaction ID collides with another local profile.');
            const categoryId = String(p.classificationId ?? ''); const categoryLabel = String(p.categoryLabel ?? categoryId);
            const toAccountId = typeof p.toAccountId === 'string' ? p.toAccountId : null;
            if ((type === 'Income' || type === 'Expense') && !validateStoredClassification(type, categoryId)) throw new Error('A cloud transaction classification is unsupported.');
            if ((type === 'Transfer' && categoryId !== 'internal_transfer') || (type === 'Refund' && (categoryId !== 'expense_refund' || typeof p.refundOfId !== 'string')) || (type === 'Reversal' && (categoryId !== 'correction_reversal' || typeof p.reversalOfId !== 'string'))) throw new Error('A cloud transaction classification is unsupported.');
            const sourceAccount = await transaction.getFirstAsync<{currency:string}>('SELECT currency FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[sourceAccountId,ownerId]);
            const destinationAccount = toAccountId ? await transaction.getFirstAsync<{currency:string}>('SELECT currency FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[toAccountId,ownerId]) : null;
            const hasTransferDestination=type==='Transfer'||(type==='Reversal'&&toAccountId!==null);
            if (!sourceAccount || sourceAccount.currency !== currency || (hasTransferDestination && (!destinationAccount || destinationAccount.currency !== currency)) || (!hasTransferDestination && toAccountId)) throw new Error('A cloud transaction references an unavailable account or currency.');
            if (type === 'Refund') {
              const original = await transaction.getFirstAsync<{type:string;accountId:string|null;amountMinor:number;currency:string}>('SELECT t.type,t.accountId,t.amountMinor,a.currency FROM "Transaction" t JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId WHERE t.id=? AND t.ownerId=?', [p.refundOfId as string,ownerId]);
              if (!original || original.type !== 'Expense' || original.currency !== currency || !original.accountId) throw new Error('A cloud refund refers to an unavailable expense.');
            }
            if (type === 'Reversal') {
              const original = await transaction.getFirstAsync<{type:string;accountId:string|null;toAccountId:string|null;amountMinor:number;currency:string}>('SELECT t.type,t.accountId,t.toAccountId,t.amountMinor,a.currency FROM "Transaction" t JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId WHERE t.id=? AND t.ownerId=?', [p.reversalOfId as string,ownerId]);
              if (!original || !['Income','Expense','Transfer'].includes(original.type) || original.accountId !== sourceAccountId || original.toAccountId !== toAccountId || original.amountMinor !== amount || original.currency !== currency) throw new Error('A cloud reversal does not match an available original transaction.');
            }
            if (typeof p.correctionOfId === 'string') {
              const original = await transaction.getFirstAsync<{type:string}>('SELECT type FROM "Transaction" WHERE id=? AND ownerId=?', [p.correctionOfId,ownerId]);
              const reversal = await transaction.getFirstAsync<{id:string}>('SELECT id FROM "Transaction" WHERE ownerId=? AND type=\'Reversal\' AND reversalOfId=?', [ownerId,p.correctionOfId]);
              if (!original || !['Income','Expense','Transfer'].includes(original.type) || !reversal) throw new Error('A cloud correction replacement arrived without its original reversal.');
            }
            const sourceAmountMinor = p.sourceAmountMinor == null ? null : Number(p.sourceAmountMinor);
            if (sourceAmountMinor !== null && (!Number.isSafeInteger(sourceAmountMinor) || sourceAmountMinor <= 0)) throw new Error('Cloud transaction source amount is invalid.');
            const taxStatus = p.taxStatus === 'taxable' || p.taxStatus === 'non_taxable' ? p.taxStatus : 'unreviewed';
            const taxYear = p.taxYear == null ? null : Number(p.taxYear);
            if (taxYear !== null && (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2200)) throw new Error('Cloud transaction tax year is invalid.');
            const nullableString = (value: unknown): string | null => value == null ? null : typeof value === 'string' ? value : null;
            if (existing && existing.synced === 0 && (
              existing.amountMinor !== amount || existing.type !== type || existing.accountId !== sourceAccountId || existing.toAccountId !== toAccountId ||
              existing.date !== p.occurredAt || existing.categoryId !== categoryId || existing.category !== categoryLabel ||
              existing.note !== nullableString(p.note) || existing.paymentMethod !== nullableString(p.paymentMethod) ||
              existing.sourceName !== nullableString(p.sourceName) || existing.sourceAmountMinor !== sourceAmountMinor ||
              existing.sourceCurrency !== nullableString(p.sourceCurrency) || existing.exchangeRate !== nullableString(p.exchangeRate) ||
              existing.referenceNumber !== nullableString(p.referenceNumber) || existing.taxStatus !== taxStatus || existing.taxYear !== taxYear
              || existing.reversalOfId !== (type === 'Refund' ? String(p.refundOfId) : type === 'Reversal' ? String(p.reversalOfId) : null)
              || existing.correctionOfId !== (typeof p.correctionOfId === 'string' ? p.correctionOfId : null)
            )) {
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',leaseUntil=NULL,lastErrorCategory='server_local_conflict',updatedAt=? WHERE ownerId=? AND entityType='transaction' AND entityId=? AND status!='confirmed'", [now,ownerId,id]);
              continue;
            }
            if (!existing) await transaction.runAsync(`INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,toAccountId,date,note,sourceName,paymentMethod,sourceAmountMinor,sourceCurrency,exchangeRate,referenceNumber,taxStatus,taxYear,reversalOfId,correctionOfId,synced)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, [id,ownerId,amount/100,amount,type,categoryLabel,categoryId,type === 'Transfer' ? null : categoryId,sourceAccountId,toAccountId,p.occurredAt,nullableCloudText(p.note),nullableCloudText(p.sourceName),nullableCloudText(p.paymentMethod),sourceAmountMinor,nullableCloudText(p.sourceCurrency),nullableCloudText(p.exchangeRate),nullableCloudText(p.referenceNumber),taxStatus,taxYear,type === 'Refund' ? p.refundOfId as string : type === 'Reversal' ? p.reversalOfId as string : null,typeof p.correctionOfId === 'string' ? p.correctionOfId : null]);
            else await transaction.runAsync('UPDATE "Transaction" SET synced=1 WHERE id=? AND ownerId=?', [id,ownerId]);
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'transaction',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision", [ownerId,id,id,Number.isSafeInteger(change.revision)?Number(change.revision):null]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='transaction' AND entityId=? AND cloudUserId=? AND status!='confirmed'", [now,ownerId,id,cloudUserId]);
          } else if (change.entityType === 'recurring_schedule') {
            if (!change.payload || typeof change.payload !== 'object' || Array.isArray(change.payload)) throw new Error('A cloud recurring schedule has an invalid payload.');
            const p=change.payload as Record<string,unknown>, id=String(p.id??change.entityId??'');
            const scheduleType=String(p.scheduleType??''), name=String(p.name??''), amount=Number(p.amountMinor), currency=String(p.currency??'');
            const accountId=String(p.accountId??''), toAccountId=typeof p.toAccountId==='string'?p.toAccountId:null;
            const billId=typeof p.billId==='string'?p.billId:null;
            const frequency=String(p.frequency??''), startDate=String(p.startDate??''), endDate=nullableCloudText(p.endDate), nextDueDate=String(p.nextDueDate??'');
            const status=String(p.status??''), classificationId=typeof p.classificationId==='string'?p.classificationId:null;
            const createdAt=typeof p.createdAt==='string'?p.createdAt:now, updatedAt=typeof p.updatedAt==='string'?p.updatedAt:now;
            const dateOnly=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
            if(!id||id!==change.entityId||!['income','expense','transfer','bill'].includes(scheduleType)||!name.trim()||name.length>120||!Number.isSafeInteger(amount)||amount<=0||!isCurrencyCode(currency)||!accountId||
              (scheduleType==='transfer' ? (!toAccountId||toAccountId===accountId||classificationId!=='internal_transfer') : Boolean(toAccountId))||
              (scheduleType==='bill'?!billId:Boolean(billId))||
              (scheduleType==='income'&&!['salary','freelance','business_revenue','family_gift','foreign_remittance','investment_return','rental_income','other_income'].includes(classificationId??'other_income'))||
              (scheduleType==='expense'&&!['food','transport','bills','shopping','health','bank_fee','housing','other_expense'].includes(classificationId??'other_expense'))||
              !['daily','weekly','monthly','yearly'].includes(frequency)||!dateOnly(startDate)||!dateOnly(nextDueDate)||(endDate!==null&&!dateOnly(endDate))||(endDate!==null&&endDate<startDate)||
              !['active','paused','cancelled'].includes(status)||!Number.isFinite(Date.parse(createdAt))||!Number.isFinite(Date.parse(updatedAt))) throw new Error('A cloud recurring schedule contains unsupported data.');
            const accounts=await transaction.getAllAsync<{id:string;currency:string}>('SELECT id,currency FROM Account WHERE ownerId=? AND id IN (?,?)',[ownerId,accountId,toAccountId??accountId]);
            const source=accounts.find((a)=>a.id===accountId), destination=toAccountId?accounts.find((a)=>a.id===toAccountId):null;
            if(!source||source.currency!==currency||(scheduleType==='transfer'&&(!destination||destination.currency!==currency)))throw new Error('A cloud recurring schedule references an unavailable account or currency.');
            if(scheduleType==='bill') {
              const template=await transaction.getFirstAsync<{ownerId:string;accountId:string;currency:string}>('SELECT ownerId,accountId,currency FROM Bill WHERE id=?',[billId]);
              if(!template||template.ownerId!==ownerId||template.accountId!==accountId||template.currency!==currency)throw new Error('A cloud bill schedule references an unavailable or mismatched bill.');
            }
            const existing=await transaction.getFirstAsync<{ownerId:string;scheduleType:string;name:string;amountMinor:number;currency:string;classificationId:string|null;accountId:string;toAccountId:string|null;billId:string|null;frequency:string;startDate:string;endDate:string|null;nextDueDate:string;status:string;createdAt:string;updatedAt:string;synced:number}>('SELECT ownerId,scheduleType,name,amountMinor,currency,classificationId,accountId,toAccountId,billId,frequency,startDate,endDate,nextDueDate,status,createdAt,updatedAt,synced FROM RecurringSchedule WHERE id=?',[id]);
            if(existing&&existing.ownerId!==ownerId)throw new Error('A cloud recurring schedule ID collides with another local profile.');
            const same=existing&&existing.scheduleType===scheduleType&&existing.name===name&&existing.amountMinor===amount&&existing.currency===currency&&existing.classificationId===classificationId&&existing.accountId===accountId&&existing.toAccountId===toAccountId&&existing.billId===billId&&existing.frequency===frequency&&existing.startDate===startDate&&existing.endDate===endDate&&existing.nextDueDate===nextDueDate&&existing.status===status;
            if(existing&&existing.synced===0&&!same){
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',leaseUntil=NULL,lastErrorCategory='server_local_conflict',updatedAt=? WHERE ownerId=? AND entityType='recurring_schedule' AND entityId=? AND status!='confirmed'",[now,ownerId,id]);
              continue;
            }
            if(!existing) await transaction.runAsync('INSERT INTO RecurringSchedule(id,ownerId,scheduleType,name,amountMinor,currency,classificationId,accountId,toAccountId,billId,frequency,startDate,endDate,nextDueDate,status,createdAt,updatedAt,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',[id,ownerId,scheduleType,name,amount,currency,classificationId,accountId,toAccountId,billId,frequency,startDate,endDate,nextDueDate,status,createdAt,updatedAt]);
            else await transaction.runAsync('UPDATE RecurringSchedule SET name=?,amountMinor=?,currency=?,classificationId=?,accountId=?,toAccountId=?,billId=?,frequency=?,startDate=?,endDate=?,nextDueDate=?,status=?,updatedAt=?,synced=1 WHERE id=? AND ownerId=?',[name,amount,currency,classificationId,accountId,toAccountId,billId,frequency,startDate,endDate,nextDueDate,status,updatedAt,id,ownerId]);
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'recurring_schedule',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision",[ownerId,id,id,serverRevision]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='recurring_schedule' AND entityId=? AND cloudUserId=? AND status!='confirmed'",[now,ownerId,id,cloudUserId]);
          } else if (change.entityType === 'schedule_occurrence') {
            if(!change.payload||typeof change.payload!=='object'||Array.isArray(change.payload))throw new Error('A cloud schedule occurrence has an invalid payload.');
            const p=change.payload as Record<string,unknown>,id=String(p.id??change.entityId??''),scheduleId=String(p.scheduleId??''),occurrenceDate=String(p.occurrenceDate??''),status=String(p.status??'');
            const transactionId=typeof p.transactionId==='string'?p.transactionId:null,resolvedAt=nullableCloudText(p.resolvedAt),createdAt=typeof p.createdAt==='string'?p.createdAt:now;
            if(!id||id!==change.entityId||!scheduleId||!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)||!Number.isFinite(Date.parse(`${occurrenceDate}T00:00:00.000Z`))||!['pending','posted','skipped'].includes(status)||!Number.isFinite(Date.parse(createdAt))||
              (status==='pending'&&(transactionId!==null||resolvedAt!==null))||(status==='posted'&&(!transactionId||!resolvedAt))||(status==='skipped'&&(transactionId!==null||!resolvedAt)))throw new Error('A cloud schedule occurrence contains unsupported data.');
            const schedule=await transaction.getFirstAsync<{scheduleType:string;amountMinor:number;currency:string;accountId:string;toAccountId:string|null;startDate:string;endDate:string|null}>('SELECT scheduleType,amountMinor,currency,accountId,toAccountId,startDate,endDate FROM RecurringSchedule WHERE id=? AND ownerId=?',[scheduleId,ownerId]);
            if(!schedule||occurrenceDate<schedule.startDate||(schedule.endDate!==null&&occurrenceDate>schedule.endDate))throw new Error('A cloud schedule occurrence references an unavailable schedule or date.');
            if(status==='posted'){
              const posted=await transaction.getFirstAsync<{type:string;amountMinor:number;currency:string;accountId:string|null;toAccountId:string|null}>('SELECT t.type,t.amountMinor,a.currency,t.accountId,t.toAccountId FROM "Transaction" t JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId WHERE t.id=? AND t.ownerId=?',[transactionId!,ownerId]);
              const expectedType=schedule.scheduleType==='income'?'Income':schedule.scheduleType==='expense'?'Expense':'Transfer';
              if(!posted||posted.type!==expectedType||posted.amountMinor!==schedule.amountMinor||posted.currency!==schedule.currency||posted.accountId!==schedule.accountId||posted.toAccountId!==schedule.toAccountId)throw new Error('A cloud occurrence is linked to a transaction that does not match its schedule.');
            }
            const existing=await transaction.getFirstAsync<{ownerId:string;scheduleId:string;occurrenceDate:string;status:string;transactionId:string|null;resolvedAt:string|null;synced:number}>('SELECT ownerId,scheduleId,occurrenceDate,status,transactionId,resolvedAt,synced FROM ScheduleOccurrence WHERE id=?',[id]);
            if(existing&&existing.ownerId!==ownerId)throw new Error('A cloud schedule occurrence ID collides with another local profile.');
            const same=existing&&existing.scheduleId===scheduleId&&existing.occurrenceDate===occurrenceDate&&existing.status===status&&existing.transactionId===transactionId&&existing.resolvedAt===resolvedAt;
            if(existing&&existing.synced===0&&!same){
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',leaseUntil=NULL,lastErrorCategory='server_local_conflict',updatedAt=? WHERE ownerId=? AND entityType='schedule_occurrence' AND entityId=? AND status!='confirmed'",[now,ownerId,id]);
              continue;
            }
            if(!existing)await transaction.runAsync('INSERT INTO ScheduleOccurrence(id,ownerId,scheduleId,occurrenceDate,status,transactionId,resolvedAt,createdAt,synced) VALUES(?,?,?,?,?,?,?,?,1)',[id,ownerId,scheduleId,occurrenceDate,status,transactionId,resolvedAt,createdAt]);
            else await transaction.runAsync('UPDATE ScheduleOccurrence SET status=?,transactionId=?,resolvedAt=?,synced=1 WHERE id=? AND ownerId=?',[status,transactionId,resolvedAt,id,ownerId]);
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'schedule_occurrence',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision",[ownerId,id,id,serverRevision]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='schedule_occurrence' AND entityId=? AND cloudUserId=? AND status!='confirmed'",[now,ownerId,id,cloudUserId]);
          } else if (change.entityType === 'budget') {
            if (!change.payload || typeof change.payload !== 'object' || Array.isArray(change.payload)) throw new Error('A cloud budget change has an invalid payload.');
            const p = change.payload as Record<string,unknown>;
            const id = String(p.id ?? change.entityId ?? '');
            if (!id || id !== change.entityId) throw new Error('A cloud budget change is missing its stable ID.');
            if (p.archivedAt !== undefined && typeof p.categoryId !== 'string') {
              await transaction.runAsync('UPDATE Budget SET archivedAt=?,synced=1 WHERE id=? AND ownerId=?', [nullableCloudText(p.archivedAt),id,ownerId]);
            } else {
              const amountMinor = Number(p.amountMinor);
              const categoryId = typeof p.categoryId === 'string' ? p.categoryId : '';
              const currency = typeof p.currency === 'string' ? p.currency : '';
              const periodStart = typeof p.periodStart === 'string' ? p.periodStart : '';
              const periodEnd = typeof p.periodEnd === 'string' ? p.periodEnd : '';
              const rolloverPolicy = typeof p.rolloverPolicy === 'string' ? p.rolloverPolicy : '';
              const revision = Number(p.revision);
              const supersedesId = typeof p.supersedesId === 'string' ? p.supersedesId : null;
              const createdAt = typeof p.createdAt === 'string' ? p.createdAt : now;
              if (!categoryId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !isCurrencyCode(currency) ||
                !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodStart >= periodEnd ||
                !['reset','carry_unused'].includes(rolloverPolicy) || !Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(Date.parse(createdAt))) {
                throw new Error('A cloud budget change contains unsupported financial data.');
              }
              const existing = await transaction.getFirstAsync<{ownerId:string;categoryId:string;amountMinor:number;currency:string;periodStart:string;periodEnd:string;rolloverPolicy:string;revision:number;supersedesId:string|null;synced:number}>(
                'SELECT ownerId,categoryId,amountMinor,currency,periodStart,periodEnd,rolloverPolicy,revision,supersedesId,synced FROM Budget WHERE id=?', [id]);
              if (existing && existing.ownerId !== ownerId) throw new Error('A cloud budget ID collides with another local profile.');
              if (existing && existing.synced === 0 && (existing.categoryId !== categoryId || existing.amountMinor !== amountMinor || existing.currency !== currency ||
                existing.periodStart !== periodStart || existing.periodEnd !== periodEnd || existing.rolloverPolicy !== rolloverPolicy || existing.revision !== revision || existing.supersedesId !== supersedesId)) {
                await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',leaseUntil=NULL,lastErrorCategory='server_local_conflict',updatedAt=? WHERE ownerId=? AND entityType='budget' AND entityId=? AND status!='confirmed'", [now,ownerId,id]);
                continue;
              }
              if (!existing) {
                if (supersedesId) await transaction.runAsync('UPDATE Budget SET supersededAt=COALESCE(supersededAt,?),synced=1 WHERE id=? AND ownerId=?', [createdAt,supersedesId,ownerId]);
                await transaction.runAsync('INSERT INTO Budget(id,ownerId,categoryId,amountMinor,currency,periodStart,periodEnd,rolloverPolicy,revision,supersedesId,createdAt,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',
                  [id,ownerId,categoryId,amountMinor,currency,periodStart,periodEnd,rolloverPolicy,revision,supersedesId,createdAt]);
              } else await transaction.runAsync('UPDATE Budget SET synced=1 WHERE id=? AND ownerId=?', [id,ownerId]);
            }
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'budget',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision", [ownerId,id,id,Number.isSafeInteger(change.revision)?Number(change.revision):null]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='budget' AND entityId=? AND cloudUserId=? AND status!='confirmed'", [now,ownerId,id,cloudUserId]);
          } else if (change.entityType === 'savings_goal') {
            if (!change.payload || typeof change.payload !== 'object' || Array.isArray(change.payload)) throw new Error('A cloud savings-goal change has an invalid payload.');
            const p=change.payload as Record<string,unknown>, id=String(p.id??change.entityId??''), target=Number(p.targetMinor);
            const currency=String(p.currency??''), name=String(p.name??''), status=String(p.status??'active');
            const createdAt=typeof p.createdAt==='string'?p.createdAt:now, updatedAt=typeof p.updatedAt==='string'?p.updatedAt:now;
            const targetDate=p.targetDate==null?null:String(p.targetDate);
            if(!id||id!==change.entityId||!name||name.trim().length>100||!Number.isSafeInteger(target)||target<=0||!isCurrencyCode(currency)||!['active','completed','archived'].includes(status)||!Number.isFinite(Date.parse(createdAt))||!Number.isFinite(Date.parse(updatedAt))||(targetDate!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)||!Number.isFinite(Date.parse(`${targetDate}T00:00:00.000Z`))))) throw new Error('A cloud savings-goal change contains unsupported financial data.');
            const existing=await transaction.getFirstAsync<{ownerId:string;name:string;targetMinor:number;currency:string;targetDate:string|null;status:string;synced:number}>('SELECT ownerId,name,targetMinor,currency,targetDate,status,synced FROM SavingsGoal WHERE id=?',[id]);
            if(existing&&existing.ownerId!==ownerId)throw new Error('A cloud savings-goal ID collides with another local profile.');
            if(existing&&existing.synced===0&&change.revision===1&&(existing.name!==name||existing.targetMinor!==target||existing.currency!==currency||existing.targetDate!==targetDate)){
              await transaction.runAsync("UPDATE SyncOutbox SET status='rejected',leaseUntil=NULL,lastErrorCategory='server_local_conflict',updatedAt=? WHERE ownerId=? AND entityType='savings_goal' AND entityId=? AND status!='confirmed'",[now,ownerId,id]);continue;
            }
            const completedAt=nullableCloudText(p.completedAt),archivedAt=nullableCloudText(p.archivedAt);
            if(!existing)await transaction.runAsync('INSERT INTO SavingsGoal(id,ownerId,name,targetMinor,currency,targetDate,status,completedAt,archivedAt,createdAt,updatedAt,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',[id,ownerId,name,target,currency,targetDate,status,completedAt,archivedAt,createdAt,updatedAt]);
            else await transaction.runAsync('UPDATE SavingsGoal SET name=?,targetMinor=?,targetDate=?,status=?,completedAt=?,archivedAt=?,updatedAt=?,synced=1 WHERE id=? AND ownerId=?',[name,target,targetDate,status,completedAt,archivedAt,updatedAt,id,ownerId]);
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'savings_goal',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision",[ownerId,id,id,serverRevision]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='savings_goal' AND entityId=? AND cloudUserId=? AND status!='confirmed'",[now,ownerId,id,cloudUserId]);
          } else if (change.entityType === 'savings_goal_event') {
            if(!change.payload||typeof change.payload!=='object'||Array.isArray(change.payload))throw new Error('A cloud savings event has an invalid payload.');
            const p=change.payload as Record<string,unknown>,id=String(p.id??change.entityId??''),goalId=String(p.goalId??''),amount=Number(p.amountMinor),currency=String(p.currency??''),eventType=String(p.eventType??'');
            const eventDate=String(p.eventDate??''),createdAt=typeof p.createdAt==='string'?p.createdAt:now,note=typeof p.note==='string'?p.note:'';
            const accountId=typeof p.accountId==='string'?p.accountId:null,transactionId=typeof p.transactionId==='string'?p.transactionId:null,key=String(p.idempotencyKey??id);
            if(!id||id!==change.entityId||!goalId||!Number.isSafeInteger(amount)||amount<=0||!isCurrencyCode(currency)||!['planned','allocate','release','transfer_in','transfer_out'].includes(eventType)||!Number.isFinite(Date.parse(eventDate))||!Number.isFinite(Date.parse(createdAt))||note.length>1000)throw new Error('A cloud savings event contains unsupported data.');
            const old=await transaction.getFirstAsync<{ownerId:string;goalId:string;eventType:string;amountMinor:number;currency:string;accountId:string|null;transactionId:string|null;eventDate:string;note:string}>('SELECT ownerId,goalId,eventType,amountMinor,currency,accountId,transactionId,eventDate,note FROM SavingsGoalEvent WHERE id=?',[id]);
            if(old&&old.ownerId!==ownerId)throw new Error('A cloud savings event ID collides with another local profile.');
            if(old&&(old.goalId!==goalId||old.eventType!==eventType||old.amountMinor!==amount||old.currency!==currency||old.accountId!==accountId||old.transactionId!==transactionId||old.eventDate!==eventDate||old.note!==note))throw new Error('A cloud savings event conflicts with existing immutable history.');
            if(!old)await transaction.runAsync('INSERT INTO SavingsGoalEvent(id,ownerId,goalId,eventType,amountMinor,currency,accountId,transactionId,idempotencyKey,eventDate,note,createdAt,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)',[id,ownerId,goalId,eventType,amount,currency,accountId,transactionId,key,eventDate,note,createdAt]);
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'savings_goal_event',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision",[ownerId,id,id,serverRevision]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='savings_goal_event' AND entityId=? AND cloudUserId=? AND status!='confirmed'",[now,ownerId,id,cloudUserId]);
          } else if (change.entityType === 'emergency_config') {
            if(!change.payload||typeof change.payload!=='object'||Array.isArray(change.payload))throw new Error('A cloud emergency-fund config has an invalid payload.');
            const p=change.payload as Record<string,unknown>,currency=String(p.currency??''),months=Number(p.coverageMonths),essential=Number(p.essentialMonthlyMinor),updatedAt=typeof p.updatedAt==='string'?p.updatedAt:now;
            if(!isCurrencyCode(currency)||!Number.isInteger(months)||months<1||months>60||!Number.isSafeInteger(essential)||essential<0||!Number.isFinite(Date.parse(updatedAt)))throw new Error('A cloud emergency-fund config contains unsupported data.');
            const old=await transaction.getFirstAsync<{currency:string;coverageMonths:number;essentialMonthlyMinor:number}>('SELECT currency,coverageMonths,essentialMonthlyMinor FROM EmergencyFundConfig WHERE ownerId=?',[ownerId]);
            if(old&&old.currency!==currency){const events=await transaction.getFirstAsync<{n:number}>('SELECT COUNT(*) AS n FROM EmergencyFundEvent WHERE ownerId=?',[ownerId]);if((events?.n??0)>0)throw new Error('A cloud emergency-fund currency conflicts with local event history.');}
            await transaction.runAsync('INSERT INTO EmergencyFundConfig(ownerId,currency,coverageMonths,essentialMonthlyMinor,updatedAt,synced) VALUES(?,?,?,?,?,1) ON CONFLICT(ownerId) DO UPDATE SET currency=excluded.currency,coverageMonths=excluded.coverageMonths,essentialMonthlyMinor=excluded.essentialMonthlyMinor,updatedAt=excluded.updatedAt,synced=1',[ownerId,currency,months,essential,updatedAt]);
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'emergency_config',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision",[ownerId,ownerId,ownerId,serverRevision]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='emergency_config' AND cloudUserId=? AND status!='confirmed'",[now,ownerId,cloudUserId]);
          } else if (change.entityType === 'emergency_event') {
            if(!change.payload||typeof change.payload!=='object'||Array.isArray(change.payload))throw new Error('A cloud emergency-fund event has an invalid payload.');
            const p=change.payload as Record<string,unknown>,id=String(p.id??change.entityId??''),amount=Number(p.amountMinor),currency=String(p.currency??''),eventType=String(p.eventType??''),accountId=String(p.accountId??''),transactionId=typeof p.transactionId==='string'?p.transactionId:null,eventDate=String(p.eventDate??''),note=typeof p.note==='string'?p.note:'',createdAt=typeof p.createdAt==='string'?p.createdAt:now,key=String(p.idempotencyKey??id);
            if(!id||id!==change.entityId||!Number.isSafeInteger(amount)||amount<=0||!isCurrencyCode(currency)||!['allocate','release','transfer_in','transfer_out'].includes(eventType)||!accountId||!Number.isFinite(Date.parse(eventDate))||!Number.isFinite(Date.parse(createdAt))||note.length>1000)throw new Error('A cloud emergency-fund event contains unsupported data.');
            const old=await transaction.getFirstAsync<{ownerId:string;eventType:string;amountMinor:number;currency:string;accountId:string;transactionId:string|null;eventDate:string;note:string}>('SELECT ownerId,eventType,amountMinor,currency,accountId,transactionId,eventDate,note FROM EmergencyFundEvent WHERE id=?',[id]);
            if(old&&old.ownerId!==ownerId)throw new Error('A cloud emergency-fund event ID collides with another local profile.');
            if(old&&(old.eventType!==eventType||old.amountMinor!==amount||old.currency!==currency||old.accountId!==accountId||old.transactionId!==transactionId||old.eventDate!==eventDate||old.note!==note))throw new Error('A cloud emergency-fund event conflicts with immutable local history.');
            if(!old)await transaction.runAsync('INSERT INTO EmergencyFundEvent(id,ownerId,eventType,amountMinor,currency,accountId,transactionId,idempotencyKey,eventDate,note,createdAt,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',[id,ownerId,eventType,amount,currency,accountId,transactionId,key,eventDate,note,createdAt]);
            await transaction.runAsync("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'emergency_event',?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision",[ownerId,id,id,serverRevision]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType='emergency_event' AND entityId=? AND cloudUserId=? AND status!='confirmed'",[now,ownerId,id,cloudUserId]);
          } else if (typeof change.entityType === 'string' && ['bill','bill_payment','bill_payment_correction','debt','debt_event','debt_interest_event','debt_event_correction','debt_repayment_schedule','asset','asset_valuation','asset_activity','investment_portfolio','investment_holding','investment_event','investment_price'].includes(change.entityType)) {
            if (!change.payload || typeof change.payload !== 'object' || Array.isArray(change.payload)) throw new Error('A cloud finance-domain change has an invalid payload.');
            const p = change.payload as Record<string, unknown>;
            const id = String(p.id ?? change.entityId ?? ''), type = change.entityType;
            const data = p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? p.data as Record<string, unknown> : null;
            if (!id || id !== change.entityId || p.entityType !== type || !data || data.id !== id) throw new Error('A cloud finance-domain record is missing its stable identity or data.');
            const tableByType: Record<string, {table:string;columns:string[];parentColumn?:string;mutable?:boolean}> = {
              bill:{table:'Bill',columns:['name','categoryId','amountMinor','currency','dueDate','accountId','scheduleId','status','reminderId','createdAt','updatedAt'],mutable:true},
              bill_payment:{table:'BillPayment',columns:['billId','amountMinor','transactionId','paidAt','idempotencyKey','createdAt'],parentColumn:'billId'},
              bill_payment_correction:{table:'BillPaymentCorrection',columns:['billId','originalPaymentId','reversalTransactionId','replacementPaymentId','reason','createdAt'],parentColumn:'billId'},
              debt:{table:'Debt',columns:['direction','counterparty','principalMinor','currency','accountId','interestRateBps','openedAt','dueDate','status','createdAt','updatedAt'],mutable:true},
              debt_event:{table:'DebtEvent',columns:['debtId','eventType','principalMinor','interestMinor','accountId','transactionId','eventDate','idempotencyKey','note','createdAt'],parentColumn:'debtId'},
              debt_interest_event:{table:'DebtInterestEvent',columns:['debtId','eventType','amountMinor','reversalOfEventId','eventDate','idempotencyKey','note','createdAt'],parentColumn:'debtId'},
              debt_event_correction:{table:'DebtEventCorrection',columns:['debtId','originalEventId','reversalTransactionId','replacementEventId','reason','createdAt'],parentColumn:'debtId'},
              debt_repayment_schedule:{table:'DebtRepaymentSchedule',columns:['debtId','frequency','firstDueDate','installmentAmountMinor','interestMethod','rateBps','installmentCount','status','createdAt','updatedAt'],parentColumn:'debtId',mutable:true},
              asset:{table:'Asset',columns:['name','category','currency','purchaseValueMinor','purchaseDate','ownershipBps','notes','createdAt']},
              asset_valuation:{table:'AssetValuation',columns:['assetId','valueMinor','valuationDate','source','idempotencyKey','createdAt'],parentColumn:'assetId'},
              asset_activity:{table:'AssetActivity',columns:['assetId','eventType','ownershipBps','costBasisMinor','proceedsMinor','accountId','transactionId','eventDate','idempotencyKey','createdAt'],parentColumn:'assetId'},
              investment_portfolio:{table:'InvestmentPortfolio',columns:['name','currency','cashAccountId','createdAt']},
              investment_holding:{table:'InvestmentHolding',columns:['portfolioId','symbol','name','category','currency','createdAt'],parentColumn:'portfolioId'},
              investment_event:{table:'InvestmentEvent',columns:['holdingId','eventType','quantityMicros','unitPriceMinor','feeMinor','amountMinor','splitNumerator','splitDenominator','transactionId','eventDate','idempotencyKey','createdAt'],parentColumn:'holdingId'},
              investment_price:{table:'InvestmentPrice',columns:['holdingId','unitPriceMinor','priceDate','source','idempotencyKey','createdAt'],parentColumn:'holdingId'},
            };
            const spec = tableByType[type];
            if (!spec) throw new Error('A cloud finance-domain change uses an unsupported entity type.');
            const values = spec.columns.map((column) => {
              const value = data[column];
              if (value === undefined) throw new Error(`A cloud ${type} record is missing ${column}.`);
              if (value === null || typeof value === 'string' || typeof value === 'number') return value;
              throw new Error(`A cloud ${type} record has invalid ${column}.`);
            });
            const existing = await transaction.getFirstAsync<{ownerId:string}>(`SELECT ownerId FROM "${spec.table}" WHERE id=?`,[id]);
            if(existing && existing.ownerId!==ownerId)throw new Error('A cloud finance-domain ID collides with another local profile.');
            if(existing && !spec.mutable){
              const current=await transaction.getFirstAsync<Record<string,unknown>>(`SELECT ${spec.columns.map((c)=>`"${c}"`).join(',')} FROM "${spec.table}" WHERE id=? AND ownerId=?`,[id,ownerId]);
              if(!current||spec.columns.some((column,index)=>String(current[column]??'')!==String(values[index]??'')))throw new Error('A cloud append-only finance record conflicts with existing local history.');
            } else if(!existing){
              const columns=['id','ownerId',...spec.columns,'synced'];
              await transaction.runAsync(`INSERT INTO "${spec.table}"(${columns.map((c)=>`"${c}"`).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,[id,ownerId,...values,1]);
            } else if(spec.mutable){
              await transaction.runAsync(`UPDATE "${spec.table}" SET ${spec.columns.map((c)=>`"${c}"=?`).join(',')},synced=1 WHERE id=? AND ownerId=?`,[...values,id,ownerId]);
            }
            if (type === 'bill_payment_correction' && typeof data.replacementPaymentId === 'string') {
              await transaction.runAsync('INSERT OR IGNORE INTO BillPaymentCorrectionReplacement(correctionId,replacementPaymentId) VALUES(?,?)',[id,data.replacementPaymentId]);
            }
            if (type === 'debt_event_correction' && typeof data.replacementEventId === 'string') {
              await transaction.runAsync('INSERT OR IGNORE INTO DebtEventCorrectionReplacement(correctionId,replacementEventId) VALUES(?,?)',[id,data.replacementEventId]);
            }
            await transaction.runAsync('INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,?,?,?,?) ON CONFLICT(ownerId,entityType,localId) DO UPDATE SET cloudId=excluded.cloudId,serverRevision=excluded.serverRevision',[ownerId,type,id,id,serverRevision]);
            await transaction.runAsync("UPDATE SyncOutbox SET status='confirmed',leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=? WHERE ownerId=? AND entityType=? AND entityId=? AND cloudUserId=? AND status!='confirmed'",[now,ownerId,type,id,cloudUserId]);
          } else throw new Error('The cloud change feed contains an unsupported entity type.');
        }
        await transaction.runAsync('UPDATE SyncCursor SET cursor=? WHERE ownerId=? AND cloudUserId=?', [nextCursor,ownerId,cloudUserId]);
      });
    },
  },
  recovery: {
    exportEncryptedBackup,
    importEncryptedBackup,
    pickEncryptedBackup: async (): Promise<Uint8Array | null> => {
      if (Platform.OS === 'web') throw new Error('Encrypted portable restore is available in the installed Android or iOS app.');
      const selection = await File.pickFileAsync({ mimeTypes: ['application/octet-stream', '*/*'] });
      if (selection.canceled || !selection.result) return null;
      const selected = selection.result;
      if (selected.size !== null && selected.size > 32 * 1024 * 1024 + 1024) throw new Error('The selected backup exceeds the supported size.');
      return selected.bytes();
    },
  },
  assets: assetsInvestmentsStore.asset,
  portfolios: assetsInvestmentsStore.portfolio,
  holdings: assetsInvestmentsStore.holding,
  netWorth: { historyData: assetsInvestmentsStore.historyData },
  budget: budgetingStore.budget,
  savings: budgetingStore.savings,
  emergencyFund: budgetingStore.emergency,
  obligations: {
    schedules: obligationsStore.schedule,
    bills: obligationsStore.bill,
    debts: obligationsStore.debt,
    postOccurrence: async ({ownerId,id,transactionId}:{ownerId:string;id:string;transactionId:string}) => obligationsStore.schedule.postOccurrence(ownerId,id,transactionId,async(sql,schedule,occurrence)=>{
      if(schedule.scheduleType==='bill') throw new Error('A scheduled bill is a payable reminder; record an explicit bill payment to post cash.');
      if(schedule.scheduleType==='transfer') {
        const source=await sql.getFirstAsync<{currency:string}>('SELECT currency FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[schedule.accountId,ownerId]);
        const destination=await sql.getFirstAsync<{currency:string}>('SELECT currency FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[schedule.toAccountId!,ownerId]);
        if(!source||!destination||source.currency!==destination.currency||source.currency!==schedule.currency) throw new Error('Transfer schedule accounts must be active, profile-owned and in the same currency.');
        await assertAccountCanFund(sql,ownerId,schedule.accountId,schedule.amountMinor,source.currency);
        const date=new Date(`${occurrence.occurrenceDate}T12:00:00.000Z`).toISOString();
        await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,toAccountId,date,note,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)',[transactionId,ownerId,schedule.amountMinor/100,schedule.amountMinor,'Transfer','Scheduled transfer','scheduled_transfer',null,schedule.accountId,schedule.toAccountId!,date,schedule.name,'unreviewed']);
        return;
      }
      await insertObligationCashTransaction(sql,{id:transactionId,ownerId,amountMinor:schedule.amountMinor,type:schedule.scheduleType==='income'?'Income':'Expense',categoryId:schedule.classificationId ?? (schedule.scheduleType==='income'?'other_income':'other_expense'),accountId:schedule.accountId,date:new Date(`${occurrence.occurrenceDate}T12:00:00.000Z`).toISOString(),note:schedule.name});
      if(schedule.scheduleType==='expense') await budgetingStore.validatePostTransaction(sql as BudgetingSql,ownerId,schedule.accountId);
    }),
    skipOccurrence: (ownerId:string,id:string) => obligationsStore.schedule.skipOccurrence(ownerId,id),
    createRecurringBill: (input:Parameters<typeof obligationsStore.bill.createRecurring>[0]) => obligationsStore.bill.createRecurring(input),
    setBillReminder: obligationsStore.bill.setReminder,
    setBillStatus: obligationsStore.bill.setStatus,
    cancelBill: obligationsStore.bill.cancel,
    createBillPayment: async(input:{id:string;ownerId:string;billId:string;amountMinor:number;transactionId:string;idempotencyKey:string;paidAt:string})=>{
      return obligationsStore.bill.recordPayment(input,async(sql)=>{
        const bill=await sql.getFirstAsync<{accountId:string;categoryId:string}>('SELECT accountId,categoryId FROM Bill WHERE id=? AND ownerId=?',[input.billId,input.ownerId]);
        if(!bill) throw new Error('Bill is not available.');
        await insertObligationCashTransaction(sql,{id:input.transactionId,ownerId:input.ownerId,amountMinor:input.amountMinor,type:'Expense',categoryId:bill.categoryId,accountId:bill.accountId,date:input.paidAt,note:`Bill payment ${input.billId}`});
        await budgetingStore.validatePostTransaction(sql as BudgetingSql,input.ownerId,bill.accountId);
      });
    },
    correctBillPayment: (input:{id:string;ownerId:string;billId:string;paymentId:string;reversalTransactionId:string;reason:string;replacement?:{id:string;transactionId:string;amountMinor:number;accountId?:string;idempotencyKey:string;paidAt:string}})=>obligationsStore.bill.correctPayment(input,async(sql,payment)=>{
      await insertObligationReversal(sql,{id:input.reversalTransactionId,ownerId:input.ownerId,originalTransactionId:payment.transactionId,amountMinor:payment.amountMinor,accountId:payment.accountId,date:new Date().toISOString(),note:`Bill payment correction: ${input.reason}`});
    },async(sql,bill,replacement)=>{
      const accountId=replacement.accountId??bill.accountId;
      await insertObligationCashTransaction(sql,{id:replacement.transactionId,ownerId:input.ownerId,amountMinor:replacement.amountMinor,type:'Expense',categoryId:bill.categoryId,accountId,date:replacement.paidAt,note:`Corrected bill payment ${input.billId}`});
      await budgetingStore.validatePostTransaction(sql as BudgetingSql,input.ownerId,accountId);
    }),
    createDebt: async(input:{id:string;ownerId:string;direction:'borrowed'|'lent';counterparty:string;principalMinor:number;currency:string;accountId:string;interestRateBps?:number;openedAt:string;dueDate?:string|null;transactionId:string;idempotencyKey:string})=>obligationsStore.debt.create({...input,eventId:`${input.id}:opening`,idempotencyKey:input.idempotencyKey},async(sql)=>{
      await insertObligationCashTransaction(sql,{id:input.transactionId,ownerId:input.ownerId,amountMinor:input.principalMinor,type:input.direction==='borrowed'?'Income':'Expense',categoryId:input.direction==='borrowed'?'debt_borrowing':'debt_lending',accountId:input.accountId,date:input.openedAt,note:`${input.direction==='borrowed'?'Borrowed from':'Lent to'} ${input.counterparty}`});
    }),
    recordDebtEvent: async(input:{id:string;ownerId:string;debtId:string;eventType:'principal_repayment'|'receivable_payment'|'interest'|'settlement';principalMinor:number;interestMinor:number;accountId:string;transactionId:string;eventDate:string;idempotencyKey:string;note?:string})=>obligationsStore.debt.recordEvent(input,async(sql)=>{
      const debt=await sql.getFirstAsync<{direction:string;counterparty:string}>('SELECT direction,counterparty FROM Debt WHERE id=? AND ownerId=?',[input.debtId,input.ownerId]);
      if(!debt) throw new Error('Debt is unavailable.');
      const isInterest=input.eventType==='interest';
      const isInflow=input.eventType==='receivable_payment'||(input.eventType==='settlement'&&debt.direction==='lent');
      const categoryId=isInterest?'debt_interest':input.eventType==='principal_repayment'?'debt_principal_repayment':input.eventType==='settlement'?'debt_settlement':'debt_receivable_payment';
      await insertObligationCashTransaction(sql,{id:input.transactionId,ownerId:input.ownerId,amountMinor:input.principalMinor+input.interestMinor,type:isInflow?'Income':'Expense',categoryId,accountId:input.accountId,date:input.eventDate,note:input.note?.trim()||`Debt payment · ${debt.counterparty}`});
    }),
    correctDebtEvent: (input:{id:string;ownerId:string;debtId:string;eventId:string;reversalTransactionId:string;reason:string;replacement?:{id:string;eventType:'borrow'|'lend'|'principal_repayment'|'receivable_payment'|'interest'|'settlement';principalMinor:number;interestMinor:number;accountId:string;transactionId:string;eventDate:string;idempotencyKey:string;note?:string}})=>obligationsStore.debt.correctEvent(input,async(sql,event)=>{
      await insertObligationReversal(sql,{id:input.reversalTransactionId,ownerId:input.ownerId,originalTransactionId:event.transactionId,amountMinor:event.principalMinor+event.interestMinor,accountId:event.accountId,date:new Date().toISOString(),note:`Debt event correction: ${input.reason}`});
    },async(sql,replacement)=>{
      const debt=await sql.getFirstAsync<{direction:string;counterparty:string}>('SELECT direction,counterparty FROM Debt WHERE id=? AND ownerId=?',[input.debtId,input.ownerId]);
      if(!debt) throw new Error('Debt is unavailable.');
      let type:'Income'|'Expense'; let categoryId:string;
      switch(replacement.eventType){
        case 'borrow': type='Income'; categoryId='debt_borrowing'; break;
        case 'lend': type='Expense'; categoryId='debt_lending'; break;
        case 'receivable_payment': type='Income'; categoryId='debt_receivable_payment'; break;
        case 'principal_repayment': type='Expense'; categoryId='debt_principal_repayment'; break;
        case 'interest': type='Expense'; categoryId='debt_interest'; break;
        default: type=debt.direction==='borrowed'?'Expense':'Income'; categoryId='debt_settlement';
      }
      await insertObligationCashTransaction(sql,{id:replacement.transactionId,ownerId:input.ownerId,amountMinor:replacement.principalMinor+replacement.interestMinor,type,categoryId,accountId:replacement.accountId,date:replacement.eventDate,note:replacement.note?.trim()||`Corrected debt event · ${debt.counterparty}`});
    }),
  },

  user: {
    register: async (fullName: string, email: string, password: string, profileId?: string): Promise<AuthResult> => {
      const normalizedName = fullName.trim();
      const normalizedEmail = email.trim().toLocaleLowerCase('en-US');
      if (normalizedName.length < 2 || normalizedName.length > 60) return { success: false, error: 'Enter a valid full name.' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return { success: false, error: 'Enter a valid email address.' };
      if (password.length < 12 || password.length > 1024 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return { success: false, error: 'Password does not meet the Leverage password requirements.' };
      }
      const id = profileId ?? Crypto.randomUUID();
      const createdAt = new Date().toISOString();

      try {
        const passwordHash = await hashPassword(password);
        const database = await getDb();
        await withLocalWrite(database, async (transaction) => {
          const existing = await transaction.getFirstAsync<ExistingUserRow>(
            'SELECT id FROM User WHERE email = ? COLLATE NOCASE', [normalizedEmail],
          );
          if (existing) throw new Error('An account with this email already exists.');
          await transaction.runAsync(
            'INSERT INTO User (id, fullName, email, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)',
            [id, normalizedName, normalizedEmail, passwordHash, createdAt],
          );
          return undefined;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/unique constraint failed:\s*user\.email/i.test(message) || message === 'An account with this email already exists.') {
          return { success: false, error: 'An account with this email already exists.' };
        }
        return { success: false, error: getLocalAuthFailureMessage(error, 'sign-up') };
      }
      return { success: true, user: { id, fullName: normalizedName, email: normalizedEmail, createdAt } };
    },

    signIn: async (email: string, password: string): Promise<AuthResult> => {
      try {
        const attemptKey = await authAttemptKey(email);
        const database = await getDb();
        const persistedDelay = await currentAuthDelay(attemptKey);
        if (persistedDelay > 0) return { success: false, error: `Invalid email or password. Try again in ${Math.ceil(persistedDelay / 1000)} seconds.`, retryAfterSeconds: Math.ceil(persistedDelay / 1000) };
        const user = await database.getFirstAsync<DbUser>(
          'SELECT id, fullName, email, passwordHash, createdAt FROM User WHERE email = ? COLLATE NOCASE',
          [email.trim().toLocaleLowerCase('en-US')],
        );
        if (!user) {
          if (password.length > 0 && password.length <= 1024) await derivePasswordHash(password, new Uint8Array(16));
          const delay = await recordAuthFailure(attemptKey);
          return { success: false, error: delay > 0 ? `Invalid email or password. Try again in ${Math.ceil(delay / 1000)} seconds.` : LOCAL_PROFILE_NOT_FOUND_MESSAGE, ...(delay > 0 ? { retryAfterSeconds: Math.ceil(delay / 1000) } : {}) };
        }
        const verification = await verifyAndUpgradePassword(password, user.passwordHash, {
          verifyLegacy: async (candidate, legacyHash) => (await hashLegacyPassword(candidate)) === legacyHash,
          createCurrentHash: hashPassword,
          replaceStoredHash: async (legacyHash, currentHash) => {
            await withLocalWrite(database, async (transaction) => {
              await transaction.runAsync('UPDATE User SET passwordHash = ? WHERE id = ? AND passwordHash = ?',
                [currentHash, user.id, legacyHash]);
              return undefined;
            });
          },
        });
        if (!verification.valid) {
          const delay = await recordAuthFailure(attemptKey);
          return { success: false, error: delay > 0 ? `Invalid email or password. Try again in ${Math.ceil(delay / 1000)} seconds.` : 'Invalid email or password.', ...(delay > 0 ? { retryAfterSeconds: Math.ceil(delay / 1000) } : {}) };
        }
        await clearAuthFailures(attemptKey);
        return {
          success: true,
          user: { id: user.id, fullName: user.fullName, email: user.email, createdAt: user.createdAt },
          passwordUpgradePending: !user.passwordHash.startsWith('pbkdf2-sha256$') && !verification.upgraded,
        };
      } catch (error) {
        return { success: false, error: getLocalAuthFailureMessage(error, 'sign-in') };
      }
    },

    findByEmail: async (email: string): Promise<Omit<DbUser, 'passwordHash'> | null> => {
      const normalizedEmail = email.trim().toLocaleLowerCase('en-US');
      if (!normalizedEmail) return null;
      const database = await getDb();
      return database.getFirstAsync<Omit<DbUser, 'passwordHash'>>(
        'SELECT id,fullName,email,createdAt FROM User WHERE email=? COLLATE NOCASE', [normalizedEmail],
      );
    },

    /** Re-hash a password only after the matching cloud identity has authenticated it. */
    setPasswordAfterCloudAuthentication: async ({ ownerId, cloudUserId, email, password }: { ownerId:string;cloudUserId:string;email:string;password:string }): Promise<void> => {
      if (!ownerId.trim() || !cloudUserId.trim() || !email.trim()) throw new Error('The authenticated cloud profile is incomplete.');
      const passwordHash = await hashPassword(password);
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const profile = await transaction.getFirstAsync<{ email:string }>('SELECT email FROM User WHERE id=?',[ownerId]);
        if (!profile || profile.email.toLocaleLowerCase('en-US') !== email.trim().toLocaleLowerCase('en-US')) throw new Error('The cloud account does not match this device profile.');
        const identity = await transaction.getFirstAsync<{ cloudUserId:string }>('SELECT cloudUserId FROM CloudIdentity WHERE ownerId=?',[ownerId]);
        if (identity && identity.cloudUserId !== cloudUserId) throw new Error('This device profile is linked to a different cloud account.');
        await transaction.runAsync('UPDATE User SET passwordHash=? WHERE id=?',[passwordHash,ownerId]);
      });
    },

    /** Remove only a newly-created, unlinked shell profile when remote authentication fails. */
    discardUnlinkedEmptyProfile: async (ownerId: string): Promise<void> => {
      if (!ownerId.trim()) return;
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const identity = await transaction.getFirstAsync<{ ownerId:string }>('SELECT ownerId FROM CloudIdentity WHERE ownerId=?',[ownerId]);
        if (identity || await countLocalFinancialRecords(transaction,ownerId) !== 0) return;
        await transaction.runAsync('DELETE FROM User WHERE id=?',[ownerId]);
      });
    },

    verifyPassword: async (ownerId: string, password: string): Promise<{ success: boolean; retryAfterSeconds?: number }> => {
      if (!ownerId.trim()) return { success: false };
      try {
        const database = await getDb();
        const user = await database.getFirstAsync<DbUser>('SELECT id,fullName,email,passwordHash,createdAt FROM User WHERE id=?',[ownerId]);
        if (!user) return { success: false };
        // Login and app-lock share the same persisted per-identity backoff state.
        const attemptKey = await authAttemptKey(user.email);
        const persistedDelay = await currentAuthDelay(attemptKey);
        if (persistedDelay > 0) return { success: false, retryAfterSeconds: Math.ceil(persistedDelay / 1000) };
        const result = await verifyAndUpgradePassword(password, user.passwordHash, {
          verifyLegacy: async (candidate, legacyHash) => (await hashLegacyPassword(candidate)) === legacyHash,
          createCurrentHash: hashPassword,
          replaceStoredHash: async (legacyHash, currentHash) => {
            await withLocalWrite(database, async (transaction) => {
              await transaction.runAsync('UPDATE User SET passwordHash=? WHERE id=? AND passwordHash=?',[currentHash,ownerId,legacyHash]);
            });
          },
        });
        if (!result.valid) {
          const delay = await recordAuthFailure(attemptKey);
          return { success: false, ...(delay > 0 ? { retryAfterSeconds: Math.ceil(delay / 1000) } : {}) };
        }
        await clearAuthFailures(attemptKey);
        return { success: true };
      } catch {
        return { success: false };
      }
    },

    changePassword: async (ownerId: string, currentPassword: string, newPassword: string): Promise<void> => {
      if (!ownerId.trim()) throw new Error('Your local profile is unavailable. Sign in again.');
      if (newPassword.length < 10 || newPassword.length > 1024 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        throw new Error('The new password does not meet the Leverage password requirements.');
      }
      try {
        const database = await getDb();
        const user = await database.getFirstAsync<DbUser>('SELECT id,fullName,email,passwordHash,createdAt FROM User WHERE id=?',[ownerId]);
        if (!user) throw new Error('Your local profile is unavailable. Sign in again.');
        const verified = await verifyAndUpgradePassword(currentPassword, user.passwordHash, {
          verifyLegacy: async (candidate, legacyHash) => (await hashLegacyPassword(candidate)) === legacyHash,
          createCurrentHash: hashPassword,
          replaceStoredHash: async (legacyHash, currentHash) => {
            await withLocalWrite(database, async (transaction) => {
              await transaction.runAsync('UPDATE User SET passwordHash=? WHERE id=? AND passwordHash=?',[currentHash,ownerId,legacyHash]);
            });
          },
        });
        if (!verified.valid) throw new Error('Current password is incorrect.');
        if (currentPassword === newPassword) throw new Error('Choose a password different from your current one.');
        const current = await database.getFirstAsync<{passwordHash:string}>('SELECT passwordHash FROM User WHERE id=?',[ownerId]);
        if (!current) throw new Error('Your local profile is unavailable. Sign in again.');
        const replacement = await hashPassword(newPassword);
        await withLocalWrite(database, async (transaction) => {
          await transaction.runAsync('UPDATE User SET passwordHash=? WHERE id=? AND passwordHash=?',[replacement,ownerId,current.passwordHash]);
          const saved = await transaction.getFirstAsync<{passwordHash:string}>('SELECT passwordHash FROM User WHERE id=?',[ownerId]);
          if (saved?.passwordHash !== replacement) throw new Error('Password was not changed. Please try again.');
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'Current password is incorrect.' || message.startsWith('Choose a password') || message.startsWith('The new password') || message.startsWith('Your local profile') || message.startsWith('Password was not changed.')) throw error;
        throw new Error('Password could not be changed. Check device storage and try again.');
      }
    },

    findMany: async (): Promise<Omit<DbUser, 'passwordHash'>[]> => {
      const database = await getDb();
      return database.getAllAsync<Omit<DbUser, 'passwordHash'>>('SELECT id,fullName,email,createdAt FROM User ORDER BY createdAt ASC,id ASC');
    },

    updateProfileName: async (ownerId: string, fullName: string): Promise<void> => {
      const normalizedName = fullName.trim();
      if (normalizedName.length < 2 || normalizedName.length > 60) throw new Error('Name must be between 2 and 60 characters.');
      try {
        const database = await getDb();
        await withLocalWrite(database, async (transaction) => {
          await transaction.runAsync('UPDATE User SET fullName=? WHERE id=?',[normalizedName,ownerId]);
          const updated = await transaction.getFirstAsync<{id:string}>('SELECT id FROM User WHERE id=?',[ownerId]);
          if (!updated) throw new Error('Your local profile is unavailable. Sign in again.');
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'Your local profile is unavailable. Sign in again.') throw error;
        throw new Error('Your display name could not be saved. Check device storage and try again.');
      }
    },

    onboardingComplete: profileSetupStore.isComplete,
    completeOnboarding: profileSetupStore.complete,

    findById: async (id: string): Promise<Omit<DbUser, 'passwordHash'> | null> => {
      if (!id.trim()) return null;
      const database = await getDb();
      return database.getFirstAsync<Omit<DbUser, 'passwordHash'>>(
        'SELECT id, fullName, email, createdAt FROM User WHERE id = ?', [id],
      );
    },

    claimLegacyData: async (ownerId: string): Promise<void> => {
      if (!ownerId.trim()) throw new Error('A profile is required to claim existing records.');
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const userCount = await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM User');
        if (userCount?.count !== 1) return;
        await transaction.runAsync('UPDATE Account SET ownerId = ? WHERE ownerId IS NULL', [ownerId]);
        await transaction.runAsync('UPDATE "Transaction" SET ownerId = ? WHERE ownerId IS NULL', [ownerId]);
        await transaction.runAsync(`INSERT OR IGNORE INTO ProfileSetup(ownerId,completedAt,firstAccountId)
          SELECT ?,COALESCE(MIN(createdAt),?),(
            SELECT id FROM Account WHERE ownerId=? ORDER BY createdAt ASC,id ASC LIMIT 1
          ) FROM Account WHERE ownerId=? HAVING COUNT(*)>0`, [ownerId,new Date().toISOString(),ownerId,ownerId]);
      });
    },
  },

  account: {
    getEditConstraints: async (ownerId: string, accountId: string): Promise<{ transactionCount: number; cloudSyncEnabled: boolean }> => {
      if (!ownerId.trim() || !accountId.trim()) throw new Error('A profile and account are required.');
      const database = await getDb();
      const row = await database.getFirstAsync<{ transactionCount: number; cloudSyncEnabled: number }>(
        `SELECT (SELECT COUNT(*) FROM "Transaction" WHERE ownerId = ? AND (accountId = ? OR toAccountId = ?)) AS transactionCount,
          EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId = ? AND syncEnabled = 1) AS cloudSyncEnabled
          FROM Account WHERE ownerId = ? AND id = ? AND archivedAt IS NULL`,
        [ownerId, accountId, accountId, ownerId, ownerId, accountId],
      );
      if (!row) throw new Error('This account is not available to this profile.');
      return { transactionCount: row.transactionCount, cloudSyncEnabled: row.cloudSyncEnabled === 1 };
    },

    count: async (ownerId: string): Promise<number> => {
      if (!ownerId.trim()) throw new Error('A profile is required to count accounts.');
      const database = await getDb();
      const result = await database.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) AS count FROM Account WHERE ownerId = ? AND archivedAt IS NULL', [ownerId],
      );
      return result?.count ?? 0;
    },

    create: async ({ data }: { data: AccountDraft }): Promise<ReturnType<typeof normalizeAccountDraft> & { createdAt: string; synced: false }> => {
      const normalized = normalizeAccountDraft(data);
      const id = normalized.id ?? Crypto.randomUUID();
      const database = await getDb();
      const created = await withLocalWrite(database, async (transaction) => {
        await assertCloudAccountType(transaction, normalized.ownerId, normalized.type);
        const existing = await transaction.getFirstAsync<AccountRow>(
          'SELECT id, ownerId, name, type, balanceMinor, currency, createdAt, archivedAt, synced FROM Account WHERE id = ?', [id],
        );
        if (existing) {
          if (existing.archivedAt) throw new Error('This account ID belongs to an archived account.');
          if (!accountMatchesDraft(existing, normalized)) throw new Error('This account ID was already used for different account details.');
          return { ...normalized, id, createdAt: existing.createdAt, synced: false as const };
        }
        const createdAt = new Date().toISOString();
        const cloudUserId = await activeCloudUser(transaction, normalized.ownerId);
        if (cloudUserId) {
          const payload: CloudAccountPayload = { id, name: normalized.name, type: normalized.type as CloudAccountPayload['type'], currency: normalized.currency, openingBalanceMinor: String(normalized.balanceMinor) };
          await enqueueCloudMutation(transaction, { mutationId: Crypto.randomUUID(), ownerId: normalized.ownerId, cloudUserId,
            entityType: 'account', entityId: id, operation: 'account.create', payload });
        }
        await transaction.runAsync(
          'INSERT INTO Account (id, ownerId, name, type, balance, balanceMinor, currency, createdAt, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
          [id, normalized.ownerId, normalized.name, normalized.type, normalized.balanceMinor / 100, normalized.balanceMinor, normalized.currency, createdAt],
        );
        return { ...normalized, id, createdAt, synced: false as const };
      });
      wakeSync(normalized.ownerId);
      return created;
    },

    update: async ({ ownerId, accountId, changes }: { ownerId: string; accountId: string; changes: Partial<Pick<AccountDraft, 'name' | 'type' | 'balanceMinor' | 'currency'>> }) => {
      if (!ownerId.trim() || !accountId.trim()) throw new Error('A profile and account are required.');
      const database = await getDb();
      const updated = await withLocalWrite(database, async (transaction) => {
        const cloudUserId = await activeCloudUser(transaction, ownerId);
        if (cloudUserId && (changes.balanceMinor !== undefined || changes.currency !== undefined)) {
          throw new Error('Opening balance and currency changes are not supported while cloud sync is enabled.');
        }
        if (cloudUserId) {
          const current = await transaction.getFirstAsync<{name:string;type:string}>('SELECT name,type FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[accountId,ownerId]);
          if (!current) throw new Error('The account is unavailable.');
          await assertCloudAccountType(transaction,ownerId,changes.type ?? current.type);
          const expectedRevision = await nextCloudAccountRevision(transaction,ownerId,accountId);
          await enqueueCloudMutation(transaction,{mutationId:Crypto.randomUUID(),ownerId,cloudUserId,entityType:'account',entityId:accountId,operation:'account.update',payload:{id:accountId,name:changes.name?.trim() ?? current.name,type:changes.type ?? current.type,expectedRevision}});
        }
        const account = await editAccount(ownerId, accountId, changes, {
          findAccount: async (profileId, id) => transaction.getFirstAsync<AccountRow>('SELECT id, ownerId, name, type, balanceMinor, currency, createdAt, archivedAt, synced FROM Account WHERE id = ? AND ownerId = ?', [id, profileId]),
          countTransactions: async (profileId, id) => (await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM "Transaction" WHERE ownerId = ? AND (accountId = ? OR toAccountId = ?)', [profileId, id, id]))?.count ?? 0,
          updateAccount: async (candidate) => { await transaction.runAsync('UPDATE Account SET name = ?, type = ?, balanceMinor = ?, balance = ?, currency = ?, synced = 0 WHERE id = ? AND ownerId = ? AND archivedAt IS NULL', [candidate.name, candidate.type, candidate.balanceMinor, candidate.balanceMinor / 100, candidate.currency, accountId, ownerId]); },
          archiveAccount: async () => { throw new Error('Unexpected archive call during account edit.'); },
        });
        return { ...account, synced: false };
      });
      wakeSync(ownerId);
      return updated;
    },

    archive: async ({ ownerId, accountId }: { ownerId: string; accountId: string }): Promise<void> => {
      if (!ownerId.trim() || !accountId.trim()) throw new Error('A profile and account are required.');
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        const cloudUserId = await activeCloudUser(transaction,ownerId);
        const before = cloudUserId ? await transaction.getFirstAsync<{archivedAt:string|null}>('SELECT archivedAt FROM Account WHERE id=? AND ownerId=?',[accountId,ownerId]) : null;
        if (cloudUserId && before?.archivedAt == null) await enqueueCloudMutation(transaction,{mutationId:Crypto.randomUUID(),ownerId,cloudUserId,entityType:'account',entityId:accountId,operation:'account.archive',payload:{id:accountId}});
        await archiveAccountRecord(ownerId, accountId, {
          findAccount: async (profileId, id) => transaction.getFirstAsync<AccountRow>('SELECT id, ownerId, name, type, balanceMinor, currency, createdAt, archivedAt, synced FROM Account WHERE id = ? AND ownerId = ?', [id, profileId]),
          countTransactions: async () => 0,
          updateAccount: async () => { throw new Error('Unexpected edit call during account archive.'); },
          archiveAccount: async (profileId, id, archivedAt) => { await transaction.runAsync('UPDATE Account SET archivedAt = COALESCE(archivedAt, ?), synced = 0 WHERE id = ? AND ownerId = ?', [archivedAt, id, profileId]); },
        });
      });
      wakeSync(ownerId);
    },

    findMany: async (ownerId: string, options: { includeArchived?: boolean } = {}): Promise<(Omit<AccountRow, 'synced'> & { synced: boolean })[]> => {
      if (!ownerId.trim()) throw new Error('A profile is required to read accounts.');
      const database = await getDb();
      const rows = await database.getAllAsync<AccountRow>(
        `SELECT id, ownerId, name, type, balanceMinor, currency, createdAt, archivedAt, synced FROM Account WHERE ownerId = ?${options.includeArchived ? '' : ' AND archivedAt IS NULL'} ORDER BY createdAt ASC, id ASC`,
        [ownerId],
      );
      return rows.map(validateAccountRow);
    },

    findManyWithBalances: async (ownerId: string, options: { includeArchived?: boolean } = {}): Promise<(Omit<AccountRow, 'synced'> & { synced: boolean })[]> => {
      const database = await getDb();
      const query = buildAccountBalanceQuery(ownerId, options.includeArchived === true);
      const rows = await database.getAllAsync<AccountRow & { openingBalanceMinor: number; currentBalanceMinor: number }>(query.sql, query.params);
      return rows.map((row) => {
        const account = validateAccountRow({ ...row, balanceMinor: row.openingBalanceMinor });
        if (!Number.isSafeInteger(row.currentBalanceMinor)) throw new Error(`Account ${row.id} balance is outside the supported range.`);
        return { ...account, balanceMinor: row.currentBalanceMinor };
      });
    },
  },

  transaction: {
    findAccountSummary: async (ownerId: string, accountId: string): Promise<AccountActivitySummary | null> => {
      const database = await getDb();
      const query = buildAccountActivitySummaryQuery(ownerId, accountId);
      const row = await database.getFirstAsync<AccountActivitySummary>(query.sql, query.params);
      if (!row) return null;
      for (const field of ['openingBalanceMinor', 'currentBalanceMinor', 'inflowMinor', 'outflowMinor', 'transactionCount'] as const) {
        if (!Number.isSafeInteger(row[field]) || row[field] < 0) throw new Error(`Account ${accountId} has an invalid ${field} summary.`);
      }
      return row;
    },

    findRecentAccountId: async (ownerId: string, type: 'Expense' | 'Income' | 'Transfer'): Promise<string | null> => {
      const database = await getDb();
      const query = buildRecentAccountPreferenceQuery(ownerId, type);
      const row = await database.getFirstAsync<{ accountId: string | null }>(query.sql, query.params);
      return row?.accountId ?? null;
    },

    findReportRows: async ({ ownerId, startDate, endDate }: {
      ownerId: string; startDate: string; endDate: string;
    }): Promise<FinancialReportRow[]> => {
      const database = await getDb();
      const query = buildFinancialReportQuery(ownerId, startDate, endDate);
      const rows = await database.getAllAsync<FinancialReportRow>(query.sql, query.params);
      return rows;
    },

    findRecentActivity: async (ownerId: string, limit = 5): Promise<TransactionActivity[]> => {
      if (!ownerId.trim()) throw new Error('A profile is required to read recent activity.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Recent activity limit must be between 1 and 10.');
      const database = await getDb();
      const rows = await database.getAllAsync<{
        id: string; ownerId: string; amountMinor: number; type: string; categoryId: string; accountId: string | null;
        toAccountId: string | null; date: string; note: string; sourceName: string | null; taxStatus: string; synced: number;
        reversalOfId: string | null; accountCurrency: string | null; destinationCurrency: string | null;
        linkedOriginalType: string | null; linkedOriginalCategoryId: string | null; linkedCurrency: string | null;
        linkedDestinationCurrency: string | null; linkedRootType: string | null; linkedRootCategoryId: string | null;
        linkedRootCurrency: string | null;
      }>(`SELECT t.id,t.ownerId,t.amountMinor,t.type,t.categoryId,t.accountId,t.toAccountId,t.date,COALESCE(t.note,'') AS note,
          t.sourceName,t.taxStatus,t.synced,t.reversalOfId,a.currency AS accountCurrency,destination.currency AS destinationCurrency,
          original.type AS linkedOriginalType,original.categoryId AS linkedOriginalCategoryId,originalAccount.currency AS linkedCurrency,
          originalDestination.currency AS linkedDestinationCurrency,rootOriginal.type AS linkedRootType,rootOriginal.categoryId AS linkedRootCategoryId,
          rootAccount.currency AS linkedRootCurrency
        FROM "Transaction" t
        LEFT JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId
        LEFT JOIN Account destination ON destination.id=t.toAccountId AND destination.ownerId=t.ownerId
        LEFT JOIN "Transaction" original ON original.id=t.reversalOfId AND original.ownerId=t.ownerId
        LEFT JOIN Account originalAccount ON originalAccount.id=original.accountId AND originalAccount.ownerId=original.ownerId
        LEFT JOIN Account originalDestination ON originalDestination.id=original.toAccountId AND originalDestination.ownerId=original.ownerId
        LEFT JOIN "Transaction" rootOriginal ON rootOriginal.id=original.reversalOfId AND rootOriginal.ownerId=original.ownerId
        LEFT JOIN Account rootAccount ON rootAccount.id=rootOriginal.accountId AND rootAccount.ownerId=rootOriginal.ownerId
        WHERE t.ownerId=? ORDER BY t.date DESC,t.id DESC LIMIT ?`, [ownerId, limit]);
      return rows.map((row) => {
        if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0 || !isTransactionType(row.type) ||
          !isTaxStatus(row.taxStatus) || (row.synced !== 0 && row.synced !== 1)) {
          throw new Error(`Transaction ${row.id} is invalid and cannot be displayed.`);
        }
        const linkedOriginalType = row.linkedOriginalType !== null && isTransactionType(row.linkedOriginalType) ? row.linkedOriginalType : null;
        const linkedCategoryId = linkedOriginalType === 'Refund' ? row.linkedRootCategoryId : row.linkedOriginalCategoryId;
        const sourceCurrency = row.type === 'Reversal' && linkedOriginalType === 'Refund' ? row.linkedRootCurrency : row.linkedCurrency;
        if ((row.type === 'Refund' || row.type === 'Reversal') &&
          (linkedOriginalType === null || row.accountCurrency !== sourceCurrency ||
            (linkedOriginalType === 'Transfer' && row.destinationCurrency !== row.linkedDestinationCurrency))) {
          throw new Error(`Transaction ${row.id} has inconsistent linked currency data.`);
        }
        return projectTransactionActivity({
          id: row.id, type: row.type, categoryId: row.categoryId, amountMinor: row.amountMinor,
          accountCurrency: row.accountCurrency, destinationCurrency: row.destinationCurrency,
          sourceName: row.sourceName, note: row.note, date: row.date,
          linkedOriginalType, linkedCategoryId,
        });
      });
    },

    findPage: async ({ ownerId, limit = 50, cursor, filters }: {
      ownerId: string; limit?: number; cursor?: { date: string; id: string }; filters?: TransactionFilters;
    }): Promise<{ items: LocalTransaction[]; nextCursor: { date: string; id: string } | null }> => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Transaction page size must be between 1 and 100.');
      const database = await getDb();
      const query = buildTransactionListQuery({ ownerId, limit, cursor, filters });
      const rows = await database.getAllAsync<TransactionRow & {
        accountName: string | null; destinationName: string | null; destinationCurrency: string | null;
        linkedOriginalType: string | null; linkedOriginalCategory: string | null; linkedOriginalNote: string | null;
        linkedOriginalId: string | null; refundedMinor: number | null;
        specializedContext: string | null;
      }>(query.sql, query.params);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items.at(-1);
      const mapped = items.map((row) => {
        const valid = validateTransactionRow(row);
        const accountCurrency: CurrencyCode | null = row.accountCurrency == null ? null : isCurrencyCode(row.accountCurrency) ? row.accountCurrency : null;
        const linkedOriginalType = row.linkedOriginalType !== null && isTransactionType(row.linkedOriginalType) ? row.linkedOriginalType : null;
        return {
          ...mapTransactionRow({ ...valid, accountCurrency: row.accountCurrency }),
          accountName: row.accountName,
          destinationName: row.destinationName,
          destinationCurrency: row.destinationCurrency && isCurrencyCode(row.destinationCurrency) ? row.destinationCurrency : null,
          accountCurrency,
          linkedOriginalType,
          linkedOriginalCategory: row.linkedOriginalCategory,
          linkedOriginalNote: row.linkedOriginalNote,
          linkedOriginalId: row.linkedOriginalId,
          refundedMinor: row.refundedMinor ?? 0,
          specializedContext: row.specializedContext,
        };
      });
      return { items: mapped, nextCursor: hasMore && last ? { date: last.date, id: last.id } : null };
    },

    findById: async (ownerId: string, id: string): Promise<LocalTransaction | null> => {
      if (!ownerId.trim() || !id.trim()) throw new Error('A profile and transaction are required.');
      const database = await getDb();
      const row = await database.getFirstAsync<TransactionRow & { accountName: string | null; destinationName: string | null; destinationCurrency: string | null; linkedOriginalId: string | null; linkedOriginalType: string | null; linkedOriginalCategory: string | null; linkedOriginalNote: string | null; refundedMinor: number | null; specializedContext: string | null }>(`SELECT t.*,a.currency AS accountCurrency,a.name AS accountName,destination.currency AS destinationCurrency,destination.name AS destinationName,linked.id AS linkedOriginalId,linked.type AS linkedOriginalType,COALESCE(linkedRoot.categoryId,linked.categoryId) AS linkedOriginalCategory,COALESCE(linkedRoot.note,linked.note) AS linkedOriginalNote,COALESCE('Bill · '||bill.name,'Debt · '||debt.counterparty,'Asset · '||asset.name,'Investment · '||holding.name) AS specializedContext,(SELECT COALESCE(SUM(refund.amountMinor),0) FROM "Transaction" refund WHERE refund.ownerId=t.ownerId AND refund.type='Refund' AND refund.reversalOfId=t.id) AS refundedMinor FROM "Transaction" t LEFT JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId LEFT JOIN Account destination ON destination.id=t.toAccountId AND destination.ownerId=t.ownerId LEFT JOIN "Transaction" linked ON linked.id=COALESCE(t.reversalOfId,t.correctionOfId) AND linked.ownerId=t.ownerId LEFT JOIN "Transaction" linkedRoot ON linkedRoot.id=linked.reversalOfId AND linkedRoot.ownerId=linked.ownerId LEFT JOIN BillPayment billPayment ON billPayment.ownerId=t.ownerId AND billPayment.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END LEFT JOIN Bill bill ON bill.id=billPayment.billId AND bill.ownerId=billPayment.ownerId LEFT JOIN DebtEvent debtEvent ON debtEvent.ownerId=t.ownerId AND debtEvent.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END LEFT JOIN Debt debt ON debt.id=debtEvent.debtId AND debt.ownerId=debtEvent.ownerId LEFT JOIN AssetActivity assetActivity ON assetActivity.ownerId=t.ownerId AND assetActivity.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END LEFT JOIN Asset asset ON asset.id=assetActivity.assetId AND asset.ownerId=assetActivity.ownerId LEFT JOIN InvestmentEvent investmentEvent ON investmentEvent.ownerId=t.ownerId AND investmentEvent.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END LEFT JOIN InvestmentHolding holding ON holding.id=investmentEvent.holdingId AND holding.ownerId=investmentEvent.ownerId WHERE t.ownerId=? AND t.id=?`, [ownerId, id]);
      if (!row) return null;
      const valid = validateTransactionRow(row);
      return { ...mapTransactionRow({ ...valid, accountCurrency: row.accountCurrency }), accountName: row.accountName, destinationName: row.destinationName, destinationCurrency: row.destinationCurrency && isCurrencyCode(row.destinationCurrency) ? row.destinationCurrency : null, linkedOriginalType: row.linkedOriginalType !== null && isTransactionType(row.linkedOriginalType) ? row.linkedOriginalType : null, linkedOriginalCategory: row.linkedOriginalCategory, linkedOriginalNote: row.linkedOriginalNote, linkedOriginalId: row.linkedOriginalId, refundedMinor: row.refundedMinor ?? 0, specializedContext: row.specializedContext };
    },

    findCorrectionLinks: async (ownerId: string, originalId: string): Promise<{ reversalId: string | null; replacementId: string | null }> => {
      if (!ownerId.trim() || !originalId.trim()) throw new Error('A profile and original transaction are required.');
      const database = await getDb();
      const [reversal, replacement] = await Promise.all([
        database.getFirstAsync<{ id: string }>('SELECT id FROM "Transaction" WHERE ownerId=? AND type=? AND reversalOfId=? LIMIT 1', [ownerId, 'Reversal', originalId]),
        database.getFirstAsync<{ id: string }>('SELECT id FROM "Transaction" WHERE ownerId=? AND correctionOfId=? LIMIT 1', [ownerId, originalId]),
      ]);
      return { reversalId: reversal?.id ?? null, replacementId: replacement?.id ?? null };
    },

    findMany: async ({
      where,
      ownerId,
      orderBy,
      take,
      cursor,
    }: {
      where?: { synced?: boolean };
      ownerId: string;
      orderBy?: { date?: 'asc' | 'desc' };
      take?: number;
      cursor?: { date: string; id: string };
    }): Promise<LocalTransaction[]> => {
      const database = await getDb();
      const page = buildTransactionPagePredicate({
        ownerId,
        order: orderBy?.date,
        cursor,
        synced: where?.synced,
        take,
      });
      const query = `SELECT t.id, t.ownerId, t.amountMinor, t.type, t.categoryId, t.classificationId, t.accountId, t.toAccountId, t.date, t.note, t.sourceName, t.paymentMethod, t.sourceAmountMinor, t.sourceCurrency, t.exchangeRate, t.referenceNumber, t.taxStatus, t.taxYear, t.synced, t.reversalOfId, t.correctionOfId, a.currency AS accountCurrency FROM "Transaction" t LEFT JOIN Account a ON a.id = t.accountId AND a.ownerId = t.ownerId WHERE ${page.whereSql} ORDER BY ${page.orderSql}${page.limitSql}`;
      const rows = await database.getAllAsync<TransactionRow>(query, page.params);
      return rows.map(validateTransactionRow).map((row) => {
        const accountCurrency: CurrencyCode | null = row.accountCurrency == null
          ? null
          : isCurrencyCode(row.accountCurrency)
            ? row.accountCurrency
            : (() => { throw new Error(`Transaction ${row.id} refers to an account with an unsupported currency.`); })();
        return {
        id: row.id,
        ownerId: row.ownerId,
        amountMinor: row.amountMinor,
        type: row.type,
        category: row.categoryId,
        classificationId: row.classificationId,
        accountId: row.accountId,
        toAccountId: row.toAccountId,
        date: row.date,
        note: row.note,
        sourceName: row.sourceName,
        paymentMethod: row.paymentMethod,
        sourceAmountMinor: row.sourceAmountMinor,
        sourceCurrency: row.sourceCurrency,
        exchangeRate: row.exchangeRate,
        referenceNumber: row.referenceNumber,
        taxStatus: row.taxStatus,
        taxYear: row.taxYear,
        synced: row.synced,
        reversalOfId: row.reversalOfId ?? null,
        correctionOfId: row.correctionOfId ?? null,
        accountCurrency,
      };
      });
    },

    create: async ({ data }: { data: TransactionDraft }): Promise<NormalizedTransactionDraft> => {
      if (data.type === 'Refund' || data.type === 'Reversal') throw new Error('Use the linked refund or correction operation for this transaction type.');
      const transactionId = data.id ?? Crypto.randomUUID();
      const database = await getDb();
      const created = await withLocalWrite(database, (transaction) => createValidatedTransaction(data, transactionId, {
        findAccount: async (id, ownerId) => {
          const row = await transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string }>(
            'SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ? AND archivedAt IS NULL', [id, ownerId],
          );
          return row ?? null;
        },
        findTransaction: async (id, ownerId) => {
          const row = await transaction.getFirstAsync<TransactionRow>(
            'SELECT id, ownerId, amountMinor, type, categoryId, classificationId, accountId, toAccountId, date, note, sourceName, paymentMethod, sourceAmountMinor, sourceCurrency, exchangeRate, referenceNumber, taxStatus, taxYear, synced FROM "Transaction" WHERE id = ? AND ownerId = ?',
            [id, ownerId],
          );
          if (!row) return null;
          const validated = validateTransactionRow(row);
          if (!validated.accountId) throw new Error(`Transaction ${validated.id} has no source account and cannot be used as an idempotency match.`);
          const sourceAccount = await transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string }>(
            'SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ?',
            [validated.accountId, validated.ownerId],
          );
          if (!sourceAccount) throw new Error(`Transaction ${validated.id} refers to a missing account.`);
          const destinationAccount = validated.toAccountId
            ? await transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string }>(
              'SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ?',
              [validated.toAccountId, validated.ownerId],
            )
            : null;
          if (validated.toAccountId && !destinationAccount) throw new Error(`Transaction ${validated.id} refers to a missing destination account.`);
          return normalizeTransactionDraft({
            id: validated.id,
            ownerId: validated.ownerId,
            amountMinor: validated.amountMinor,
            type: validated.type,
            classificationId: validated.type === 'Transfer'
              ? undefined
              : validated.classificationId ?? validated.categoryId,
            accountId: validated.accountId,
            toAccountId: validated.toAccountId ?? undefined,
            date: validated.date,
            note: validated.note,
            sourceName: validated.sourceName ?? undefined,
            paymentMethod: validated.paymentMethod ?? undefined,
            sourceAmountMinor: validated.sourceAmountMinor ?? undefined,
            sourceCurrency: validated.sourceCurrency ?? undefined,
            exchangeRate: validated.exchangeRate ?? undefined,
            referenceNumber: validated.referenceNumber ?? undefined,
            taxStatus: validated.taxStatus,
            taxYear: validated.taxYear ?? undefined,
          }, sourceAccount, destinationAccount ?? undefined);
        },
        insertTransaction: async (record) => {
          const cloudUserId = await activeCloudUser(transaction, record.ownerId);
          const source = await transaction.getFirstAsync<{ currency: string; type: string }>(
            'SELECT currency,type FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL', [record.accountId,record.ownerId],
          );
          if (!source) throw new Error('The transaction account is unavailable.');
          if (record.type === 'Expense' || record.type === 'Transfer') {
            await assertAccountCanFund(asObligationsSql(transaction), record.ownerId, record.accountId, record.amountMinor, source.currency);
          }
          if (cloudUserId) {
            const type = record.type === 'Income' ? 'income' : record.type === 'Expense' ? 'expense' : 'transfer';
            const payload: CloudTransactionPayload = {
              id: record.id, type, amountMinor: String(record.amountMinor), currency: source.currency as CloudTransactionPayload['currency'],
              classificationId: record.classificationId ?? 'internal_transfer', categoryLabel: record.categoryLabel,
              accountId: record.accountId, ...(record.toAccountId ? { toAccountId: record.toAccountId } : {}),
              occurredAt: record.date, note: record.note ?? null, paymentMethod: record.paymentMethod ?? null,
              sourceName: record.sourceName ?? null, sourceAmountMinor: record.sourceAmountMinor == null ? null : String(record.sourceAmountMinor),
              sourceCurrency: record.sourceCurrency ?? null, exchangeRate: record.exchangeRate ?? null,
              referenceNumber: record.referenceNumber ?? null, taxStatus: record.taxStatus, taxYear: record.taxYear ?? null,
            };
            await enqueueCloudMutation(transaction, { mutationId: Crypto.randomUUID(), ownerId: record.ownerId, cloudUserId,
              entityType: 'transaction', entityId: record.id, operation: 'transaction.create', payload,
              dependencyEntityId: record.accountId });
          }
          await transaction.runAsync(
            'INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, toAccountId, date, note, sourceName, paymentMethod, sourceAmountMinor, sourceCurrency, exchangeRate, referenceNumber, taxStatus, taxYear, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
            [record.id, record.ownerId, record.amountMinor / 100, record.amountMinor, record.type, record.categoryLabel, record.categoryLabel, record.classificationId, record.accountId, record.toAccountId, record.date, record.note, record.sourceName, record.paymentMethod, record.sourceAmountMinor, record.sourceCurrency, record.exchangeRate, record.referenceNumber, record.taxStatus, record.taxYear],
          );
          await budgetingStore.validatePostTransaction(asBudgetingSql(transaction), record.ownerId, record.accountId);
        },
      }));
      wakeSync(data.ownerId);
      return created;
    },

    refund: async ({ id, ownerId, originalTransactionId, accountId, amountMinor, refundRemaining = false, date = new Date(), note = '' }: {
      id: string; ownerId: string; originalTransactionId: string; accountId: string; amountMinor?: number; refundRemaining?: boolean; date?: Date | string; note?: string;
    }): Promise<LocalTransaction> => {
      if (!id.trim() || !ownerId.trim() || !originalTransactionId.trim()) throw new Error('A refund ID, profile, and original transaction are required.');
      if (!refundRemaining && (!Number.isSafeInteger(amountMinor) || amountMinor! <= 0)) throw new Error('Refund amount must be a positive integer in minor units.');
      const at = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
      if (!Number.isFinite(new Date(at).getTime())) throw new Error('Refund date is invalid.');
      if (note.length > 2000) throw new Error('Note must be 2,000 characters or fewer.');
      const database = await getDb();
      return withLocalWrite(database, async (transaction) => {
        const existing = await transaction.getFirstAsync<TransactionRow>('SELECT * FROM "Transaction" WHERE id = ? AND ownerId = ?', [id, ownerId]);
        if (existing) {
          if (existing.type !== 'Refund' || existing.reversalOfId !== originalTransactionId || existing.accountId !== accountId || (!refundRemaining && existing.amountMinor !== amountMinor) || existing.date !== at || existing.note !== note.trim()) throw new Error('This refund ID was already used for different financial details.');
          return mapTransactionRow(validateTransactionRow(existing));
        }
        const original = await transaction.getFirstAsync<TransactionRow>('SELECT * FROM "Transaction" WHERE id = ? AND ownerId = ?', [originalTransactionId, ownerId]);
        if (!original || original.type !== 'Expense' || !original.accountId) throw new Error('Only a recorded expense can be refunded.');
        const obligationLink=await transaction.getFirstAsync<{kind:string}>("SELECT 'bill' AS kind FROM BillPayment WHERE ownerId=? AND transactionId=? UNION ALL SELECT 'debt' AS kind FROM DebtEvent WHERE ownerId=? AND transactionId=? LIMIT 1",[ownerId,originalTransactionId,ownerId,originalTransactionId]);
        if(obligationLink) throw new Error('This bill or debt cash entry must be corrected through its obligation history.');
        const assetOrInvestmentLink=await transaction.getFirstAsync<{kind:string}>("SELECT 'asset' AS kind FROM AssetActivity WHERE ownerId=? AND transactionId=? UNION ALL SELECT 'investment' AS kind FROM InvestmentEvent WHERE ownerId=? AND transactionId=? LIMIT 1",[ownerId,originalTransactionId,ownerId,originalTransactionId]);
        if(assetOrInvestmentLink) throw new Error('This asset or investment cash entry must be corrected through its dedicated history.');
        validateTransactionRow(original);
        const alreadyCorrected = await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM "Transaction" WHERE ownerId = ? AND type = ? AND reversalOfId = ?', [ownerId, 'Reversal', originalTransactionId]);
        if (alreadyCorrected?.count) throw new Error('A corrected expense cannot receive another refund.');
        const account = await transaction.getFirstAsync<{ id: string; ownerId: string; currency: string }>('SELECT id, ownerId, currency FROM Account WHERE id = ? AND ownerId = ? AND archivedAt IS NULL', [accountId, ownerId]);
        const originalAccount = await transaction.getFirstAsync<{ currency: string }>('SELECT currency FROM Account WHERE id = ? AND ownerId = ?', [original.accountId, ownerId]);
        if (!account || !originalAccount || account.currency !== originalAccount.currency) throw new Error('Refund account must belong to this profile and use the expense currency.');
        const refunded = await transaction.getFirstAsync<{ amount: number | null }>('SELECT SUM(amountMinor) AS amount FROM "Transaction" WHERE ownerId = ? AND type = ? AND reversalOfId = ?', [ownerId, 'Refund', originalTransactionId]);
        const refundAmount = resolveRefundAmount({
          originalAmountMinor: original.amountMinor,
          alreadyRefundedMinor: refunded?.amount ?? 0,
          amountMinor,
          refundRemaining,
        });
        const cloudUserId = await activeCloudUser(transaction, ownerId);
        if (cloudUserId) {
          const accountType = await transaction.getFirstAsync<{type:string}>('SELECT type FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL', [accountId,ownerId]);
          if (!accountType || !['cash','bank','wallet','savings'].includes(accountType.type)) throw new Error('This refund account type is not supported by cloud sync yet. The refund was not saved.');
          const payload: CloudTransactionPayload = {
            id, type: 'refund', amountMinor: String(refundAmount), currency: account.currency as CurrencyCode,
            classificationId: 'expense_refund', categoryLabel: 'Expense refund', accountId, refundOfId: originalTransactionId,
            occurredAt: at, note: note.trim() || null, paymentMethod: null, sourceName: null, sourceAmountMinor: null,
            sourceCurrency: null, exchangeRate: null, referenceNumber: null, taxStatus: 'unreviewed', taxYear: null,
          };
          await enqueueCloudMutation(transaction, { mutationId: Crypto.randomUUID(), ownerId, cloudUserId,
            entityType: 'transaction', entityId: id, operation: 'transaction.create', payload, dependencyEntityId: originalTransactionId });
        }
        await transaction.runAsync('INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, toAccountId, date, note, taxStatus, synced, reversalOfId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)', [id, ownerId, refundAmount / 100, refundAmount, 'Refund', 'Expense refund', 'expense_refund', 'expense_refund', accountId, at, note.trim(), 'unreviewed', originalTransactionId]);
        return mapTransactionRow(validateTransactionRow({
          id, ownerId, amountMinor: refundAmount, type: 'Refund', categoryId: 'expense_refund', classificationId: 'expense_refund', accountId, toAccountId: null,
          date: at, note: note.trim(), sourceName: null, paymentMethod: null, sourceAmountMinor: null, sourceCurrency: null, exchangeRate: null,
          referenceNumber: null, taxStatus: 'unreviewed', taxYear: null, synced: 0, reversalOfId: originalTransactionId,
        }));
      });
    },

    correct: async ({ ownerId, originalTransactionId, replacement }: { ownerId: string; originalTransactionId: string; replacement: TransactionDraft }): Promise<NormalizedTransactionDraft> => {
      const replacementId = replacement.id;
      if (!ownerId.trim() || !originalTransactionId.trim() || !replacementId?.trim()) throw new Error('A profile, original transaction, and stable replacement ID are required.');
      if (replacement.ownerId !== ownerId || replacement.type === 'Refund' || replacement.type === 'Reversal') throw new Error('Correction replacement must be a standard transaction for the same profile.');
      const reversalId = `correction:${replacementId}:reversal`;
      const database = await getDb();
      const corrected = await withLocalWrite(database, async (transaction) => {
        const original = await transaction.getFirstAsync<TransactionRow>('SELECT * FROM "Transaction" WHERE id = ? AND ownerId = ?', [originalTransactionId, ownerId]);
        if (!original || original.type === 'Refund' || original.type === 'Reversal' || !original.accountId) throw new Error('This transaction cannot be corrected.');
        const obligationLink=await transaction.getFirstAsync<{kind:string}>("SELECT 'bill' AS kind FROM BillPayment WHERE ownerId=? AND transactionId=? UNION ALL SELECT 'debt' AS kind FROM DebtEvent WHERE ownerId=? AND transactionId=? LIMIT 1",[ownerId,originalTransactionId,ownerId,originalTransactionId]);
        if(obligationLink) throw new Error('This bill or debt cash entry must be corrected through its obligation history.');
        const assetOrInvestmentLink=await transaction.getFirstAsync<{kind:string}>("SELECT 'asset' AS kind FROM AssetActivity WHERE ownerId=? AND transactionId=? UNION ALL SELECT 'investment' AS kind FROM InvestmentEvent WHERE ownerId=? AND transactionId=? LIMIT 1",[ownerId,originalTransactionId,ownerId,originalTransactionId]);
        if(assetOrInvestmentLink) throw new Error('This asset or investment cash entry must be corrected through its dedicated history.');
        const priorRefund = await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM "Transaction" WHERE ownerId = ? AND type = ? AND reversalOfId = ?', [ownerId, 'Refund', originalTransactionId]);
        const existingReversal = await transaction.getFirstAsync<{ id: string }>('SELECT id FROM "Transaction" WHERE ownerId = ? AND type = ? AND reversalOfId = ?', [ownerId, 'Reversal', originalTransactionId]);
        const existingReplacement = await transaction.getFirstAsync<TransactionRow>('SELECT * FROM "Transaction" WHERE id = ? AND ownerId = ?', [replacementId, ownerId]);
        assertCorrectionCanPost({
          originalTransactionId,
          stableReversalId: reversalId,
          existingReversalId: existingReversal?.id ?? null,
          priorRefundCount: priorRefund?.count ?? 0,
          replacementAlreadyExists: !!existingReplacement,
          existingReplacementCorrectionOfId: existingReplacement?.correctionOfId ?? null,
        });
        const accounts = await Promise.all([original.accountId, original.toAccountId].filter((value): value is string => !!value).map(async (accountId) => transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string; archivedAt:string|null }>('SELECT id, ownerId, currency, type, archivedAt FROM Account WHERE id = ? AND ownerId = ?', [accountId, ownerId])));
        if (accounts.some((account) => !account)) throw new Error('Original transaction refers to a missing account.');
        const existingReversalById = await transaction.getFirstAsync<{ type: string; ownerId: string; reversalOfId: string | null }>('SELECT type, ownerId, reversalOfId FROM "Transaction" WHERE id = ?', [reversalId]);
        if (existingReversalById && (existingReversalById.type !== 'Reversal' || existingReversalById.ownerId !== ownerId || existingReversalById.reversalOfId !== originalTransactionId)) throw new Error('Correction ID conflicts with an existing financial record.');
        if (original.type === 'Income') {
          const account = accounts.find((candidate) => candidate?.id === original.accountId);
          if (!account) throw new Error('The original income account is unavailable.');
          await assertAccountCanFund(asObligationsSql(transaction), ownerId, original.accountId, original.amountMinor, account.currency);
        } else if (original.type === 'Transfer' && original.toAccountId) {
          const destination = accounts.find((candidate) => candidate?.id === original.toAccountId);
          if (!destination) throw new Error('The original transfer destination is unavailable.');
          await assertAccountCanFund(asObligationsSql(transaction), ownerId, original.toAccountId, original.amountMinor, destination.currency);
        }
        const cloudUserId = await activeCloudUser(transaction,ownerId);
        if (cloudUserId) {
          const currency=accounts.find((account)=>account?.id===original.accountId)?.currency;
          if (!currency || accounts.some((account)=>!account||account.archivedAt!==null||!['cash','bank','wallet','savings'].includes(account.type))) throw new Error('This correction uses an archived or unsupported account. Reopen it or choose a supported account, then try again.');
          const reversalPayload: CloudTransactionPayload = {
            id:reversalId,type:'reversal',amountMinor:String(original.amountMinor),currency:currency as CurrencyCode,
            classificationId:'correction_reversal',categoryLabel:'Correction reversal',accountId:original.accountId,
            ...(original.toAccountId?{toAccountId:original.toAccountId}:{}),occurredAt:new Date().toISOString(),
            note:`Correction reversal for ${original.id}`,paymentMethod:null,sourceName:null,sourceAmountMinor:null,
            sourceCurrency:null,exchangeRate:null,referenceNumber:null,taxStatus:'unreviewed',taxYear:null,reversalOfId:original.id,
          };
          await enqueueCloudMutation(transaction,{mutationId:Crypto.randomUUID(),ownerId,cloudUserId,entityType:'transaction',entityId:reversalId,operation:'transaction.create',payload:reversalPayload,dependencyEntityId:original.id});
        }
        await transaction.runAsync('INSERT OR IGNORE INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, toAccountId, date, note, taxStatus, synced, reversalOfId) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)', [reversalId, ownerId, original.amountMinor / 100, original.amountMinor, 'Reversal', 'Correction reversal', 'correction_reversal', original.accountId, original.toAccountId, new Date().toISOString(), `Correction reversal for ${original.id}`, 'unreviewed', original.id]);
        const result = await createValidatedTransaction(replacement, replacementId, {
          findAccount: async (accountId, profileId) => transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string }>('SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ? AND archivedAt IS NULL', [accountId, profileId]),
          findTransaction: async (transactionId, profileId) => {
            const row = await transaction.getFirstAsync<TransactionRow>('SELECT * FROM "Transaction" WHERE id = ? AND ownerId = ?', [transactionId, profileId]);
            if (!row) return null;
            const account = row.accountId ? await transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string }>('SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ?', [row.accountId, profileId]) : null;
            const destination = row.toAccountId ? await transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string }>('SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ?', [row.toAccountId, profileId]) : null;
            if (!account) throw new Error('Existing transaction refers to a missing account.');
            return normalizeTransactionDraft({ id: row.id, ownerId: row.ownerId, amountMinor: row.amountMinor, type: row.type as TransactionType, classificationId: row.classificationId ?? undefined, accountId: row.accountId!, toAccountId: row.toAccountId ?? undefined, date: row.date, note: row.note, sourceName: row.sourceName ?? undefined, paymentMethod: row.paymentMethod ?? undefined, sourceAmountMinor: row.sourceAmountMinor ?? undefined, sourceCurrency: row.sourceCurrency ?? undefined, exchangeRate: row.exchangeRate ?? undefined, referenceNumber: row.referenceNumber ?? undefined, taxStatus: row.taxStatus, taxYear: row.taxYear ?? undefined }, account, destination ?? undefined);
          },
          insertTransaction: async (record) => {
            const accountForPosting = await transaction.getFirstAsync<{currency:string}>('SELECT currency FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[record.accountId,ownerId]);
            if (!accountForPosting) throw new Error('The correction account is unavailable.');
            if (record.type === 'Expense' || record.type === 'Transfer') {
              await assertAccountCanFund(asObligationsSql(transaction), ownerId, record.accountId, record.amountMinor, accountForPosting.currency);
            }
            if (cloudUserId) {
              const source=await transaction.getFirstAsync<{currency:string;type:string}>('SELECT currency,type FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[record.accountId,ownerId]);
              const destination=record.toAccountId?await transaction.getFirstAsync<{type:string}>('SELECT type FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL',[record.toAccountId,ownerId]):null;
              if(!source||!['cash','bank','wallet','savings'].includes(source.type)||(destination&&!['cash','bank','wallet','savings'].includes(destination.type))) throw new Error('This correction replacement account type is not supported by cloud sync. It was not saved.');
              const payload:CloudTransactionPayload={
                id:record.id,type:record.type==='Income'?'income':record.type==='Expense'?'expense':'transfer',amountMinor:String(record.amountMinor),currency:source.currency as CurrencyCode,
                classificationId:record.classificationId??'internal_transfer',categoryLabel:record.categoryLabel,accountId:record.accountId,
                ...(record.toAccountId?{toAccountId:record.toAccountId}:{}),occurredAt:record.date,note:record.note??null,paymentMethod:record.paymentMethod??null,
                sourceName:record.sourceName??null,sourceAmountMinor:record.sourceAmountMinor==null?null:String(record.sourceAmountMinor),sourceCurrency:record.sourceCurrency??null,
                exchangeRate:record.exchangeRate??null,referenceNumber:record.referenceNumber??null,taxStatus:record.taxStatus,taxYear:record.taxYear??null,correctionOfId:original.id,
              };
              await enqueueCloudMutation(transaction,{mutationId:Crypto.randomUUID(),ownerId,cloudUserId,entityType:'transaction',entityId:record.id,operation:'transaction.create',payload,dependencyEntityId:reversalId});
            }
            await transaction.runAsync('INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, toAccountId, date, note, sourceName, paymentMethod, sourceAmountMinor, sourceCurrency, exchangeRate, referenceNumber, taxStatus, taxYear, synced, correctionOfId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)', [record.id, record.ownerId, record.amountMinor / 100, record.amountMinor, record.type, record.categoryLabel, record.categoryLabel, record.classificationId, record.accountId, record.toAccountId, record.date, record.note, record.sourceName, record.paymentMethod, record.sourceAmountMinor, record.sourceCurrency, record.exchangeRate, record.referenceNumber, record.taxStatus, record.taxYear, originalTransactionId]);
            await budgetingStore.validatePostTransaction(asBudgetingSql(transaction), record.ownerId, record.accountId);
          },
        });
        return result;
      });
      wakeSync(ownerId);
      return corrected;
    },
  },
};

function mapTransactionRow(row: ValidatedTransactionRow): LocalTransaction {
  return {
    id: row.id, ownerId: row.ownerId, amountMinor: row.amountMinor, type: row.type,
    category: row.categoryId, classificationId: row.classificationId, accountId: row.accountId,
    toAccountId: row.toAccountId, date: row.date, note: row.note, sourceName: row.sourceName,
    paymentMethod: row.paymentMethod, sourceAmountMinor: row.sourceAmountMinor, sourceCurrency: row.sourceCurrency,
    exchangeRate: row.exchangeRate, referenceNumber: row.referenceNumber, taxStatus: row.taxStatus,
    taxYear: row.taxYear, synced: row.synced, reversalOfId: row.reversalOfId ?? null,
    correctionOfId: row.correctionOfId ?? null,
    accountCurrency: row.accountCurrency && isCurrencyCode(row.accountCurrency) ? row.accountCurrency : null,
  };
}

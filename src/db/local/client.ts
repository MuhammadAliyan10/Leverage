import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
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
import { migrateLocalDatabase, type MigrationDatabase } from './migrations';
import { createLocalWriteQueue } from './writeQueue';
import { archiveAccount as archiveAccountRecord, editAccount } from '../../finance/accountOperations';
import { assertCorrectionCanPost, resolveRefundAmount } from '../../finance/transactionOperations';
import { buildFinancialReportQuery, type FinancialReportRow } from '../../finance/reporting';
import { buildTransactionPagePredicate } from './queryBuilders';
import { createBudgetingStore, type BudgetingSql } from './budgetingStore';
import { createObligationsStore, type ObligationsSql } from './obligationsStore';
import { createAssetsInvestmentsStore, type AssetSql } from './assetsInvestmentsStore';
import { derivePasswordHash, verifyAndUpgradePassword } from '../../security/passwordHash';
import { createLoginRateLimit } from '../../security/loginRateLimit';
import { projectTransactionActivity, type TransactionActivity } from '../../finance/transactionDisplay';
import { createProfileSetupStore } from './profileSetupStore';

type SqlExecutor = Pick<SQLite.SQLiteDatabase, 'execAsync' | 'runAsync' | 'getFirstAsync' | 'getAllAsync'>;

let expoDb: SQLite.SQLiteDatabase | null = null;
let openingDatabase: Promise<SQLite.SQLiteDatabase> | null = null;
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

async function authAttemptKey(email: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, email.trim().toLowerCase());
}

async function recordAuthFailure(database: SQLite.SQLiteDatabase, key: string): Promise<number> {
  return withLocalWrite(database, async (transaction) => {
    const prior = await transaction.getFirstAsync<AuthAttemptRow>('SELECT failures,blockedUntil FROM AuthLoginAttempt WHERE attemptKey=?',[key]);
    const next = loginRateLimit.next(prior?.failures ?? 0);
    await transaction.runAsync('INSERT INTO AuthLoginAttempt(attemptKey,failures,blockedUntil) VALUES(?,?,?) ON CONFLICT(attemptKey) DO UPDATE SET failures=excluded.failures,blockedUntil=excluded.blockedUntil',[key,next.failures,next.blockedUntil]);
    return next.delayMs;
  });
}

async function currentAuthDelay(database: SQLite.SQLiteDatabase, key: string): Promise<number> {
  const attempt = await database.getFirstAsync<AuthAttemptRow>('SELECT failures,blockedUntil FROM AuthLoginAttempt WHERE attemptKey=?',[key]);
  return attempt ? loginRateLimit.delayFor(attempt.failures,attempt.blockedUntil) : 0;
}

async function clearAuthFailures(database: SQLite.SQLiteDatabase, key: string): Promise<void> {
  await withLocalWrite(database, async (transaction) => {
    await transaction.runAsync('DELETE FROM AuthLoginAttempt WHERE attemptKey=?',[key]);
  });
}

async function openAndMigrateDatabase(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync('finance.db');
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
  if (expoDb) return expoDb;
  openingDatabase ??= openAndMigrateDatabase();
  try {
    expoDb = await openingDatabase;
    return expoDb;
  } finally {
    openingDatabase = null;
  }
}

/** Serializes writes on web (which lacks exclusive transactions) and uses exclusive native transactions. */
async function withLocalWrite<T>(database: SQLite.SQLiteDatabase, task: (executor: SqlExecutor) => Promise<T>): Promise<T> {
  return runSerializedWrite(async () => {
    let resolveResult: ((value: T) => void) | null = null;
    const result = new Promise<T>((resolve) => { resolveResult = resolve; });
    const persist = async (executor: SqlExecutor): Promise<void> => {
      const value = await task(executor);
      if (!resolveResult) throw new Error('The local write result could not be delivered.');
      resolveResult(value);
    };
    if (Platform.OS === 'web') {
      await database.withTransactionAsync(() => persist(database));
    } else {
      await database.withExclusiveTransactionAsync(async (transaction) => persist(transaction));
    }
    return result;
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
  await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,toAccountId,date,note,taxStatus,taxYear,synced) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,0)',[input.id,input.ownerId,input.amountMinor/100,input.amountMinor,input.type,input.categoryId,input.categoryId,null,input.accountId,date.toISOString(),input.note.slice(0,2000),input.taxStatus ?? 'unreviewed',null]);
}

async function insertObligationReversal(sql: ObligationsSql, input: { id: string; ownerId: string; originalTransactionId: string; amountMinor: number; accountId: string; date: string; note: string }): Promise<void> {
  const at=new Date(input.date);
  if(!input.id.trim()||!input.ownerId.trim()||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||!Number.isFinite(at.getTime())) throw new Error('Obligation reversal details are invalid.');
  const original=await sql.getFirstAsync<{id:string;ownerId:string;amountMinor:number;accountId:string;type:string}>('SELECT id,ownerId,amountMinor,accountId,type FROM "Transaction" WHERE id=? AND ownerId=?',[input.originalTransactionId,input.ownerId]);
  if(!original||original.amountMinor!==input.amountMinor||original.accountId!==input.accountId||!['Income','Expense'].includes(original.type)) throw new Error('The original obligation transaction cannot be reversed with these details.');
  const existing=await sql.getFirstAsync<{type:string;ownerId:string;reversalOfId:string|null;amountMinor:number}>('SELECT type,ownerId,reversalOfId,amountMinor FROM "Transaction" WHERE id=?',[input.id]);
  if(existing){if(existing.type!=='Reversal'||existing.ownerId!==input.ownerId||existing.reversalOfId!==input.originalTransactionId||existing.amountMinor!==input.amountMinor) throw new Error('Reversal ID was already used for different details.');return;}
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

export const localDb = {
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
    register: async (fullName: string, email: string, password: string): Promise<AuthResult> => {
      const normalizedName = fullName.trim();
      const normalizedEmail = email.trim().toLocaleLowerCase('en-US');
      if (normalizedName.length < 2 || normalizedName.length > 60) return { success: false, error: 'Enter a valid full name.' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return { success: false, error: 'Enter a valid email address.' };
      if (password.length < 10 || password.length > 1024 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return { success: false, error: 'Password does not meet the HouseLog password requirements.' };
      }
      const id = Crypto.randomUUID();
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
        return { success: false, error: 'Your local profile could not be created. Check device storage and try again.' };
      }
      return { success: true, user: { id, fullName: normalizedName, email: normalizedEmail, createdAt } };
    },

    signIn: async (email: string, password: string): Promise<AuthResult> => {
      try {
        const attemptKey = await authAttemptKey(email);
        const database = await getDb();
        const persistedDelay = await currentAuthDelay(database, attemptKey);
        if (persistedDelay > 0) return { success: false, error: `Invalid email or password. Try again in ${Math.ceil(persistedDelay / 1000)} seconds.`, retryAfterSeconds: Math.ceil(persistedDelay / 1000) };
        const user = await database.getFirstAsync<DbUser>(
          'SELECT id, fullName, email, passwordHash, createdAt FROM User WHERE email = ? COLLATE NOCASE',
          [email.trim().toLocaleLowerCase('en-US')],
        );
        if (!user) {
          if (password.length > 0 && password.length <= 1024) await derivePasswordHash(password, new Uint8Array(16));
          const delay = await recordAuthFailure(database, attemptKey);
          return { success: false, error: delay > 0 ? `Invalid email or password. Try again in ${Math.ceil(delay / 1000)} seconds.` : 'Invalid email or password.', ...(delay > 0 ? { retryAfterSeconds: Math.ceil(delay / 1000) } : {}) };
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
          const delay = await recordAuthFailure(database, attemptKey);
          return { success: false, error: delay > 0 ? `Invalid email or password. Try again in ${Math.ceil(delay / 1000)} seconds.` : 'Invalid email or password.', ...(delay > 0 ? { retryAfterSeconds: Math.ceil(delay / 1000) } : {}) };
        }
        await clearAuthFailures(database, attemptKey);
        return {
          success: true,
          user: { id: user.id, fullName: user.fullName, email: user.email, createdAt: user.createdAt },
          passwordUpgradePending: !user.passwordHash.startsWith('pbkdf2-sha256$') && !verification.upgraded,
        };
      } catch {
        return { success: false, error: 'Local sign in could not complete. Check device storage and try again.' };
      }
    },

    verifyPassword: async (ownerId: string, password: string): Promise<boolean> => {
      if (!ownerId.trim()) return false;
      try {
        const database = await getDb();
        const user = await database.getFirstAsync<DbUser>('SELECT id,fullName,email,passwordHash,createdAt FROM User WHERE id=?',[ownerId]);
        if (!user) return false;
        const result = await verifyAndUpgradePassword(password, user.passwordHash, {
          verifyLegacy: async (candidate, legacyHash) => (await hashLegacyPassword(candidate)) === legacyHash,
          createCurrentHash: hashPassword,
          replaceStoredHash: async (legacyHash, currentHash) => {
            await withLocalWrite(database, async (transaction) => {
              await transaction.runAsync('UPDATE User SET passwordHash=? WHERE id=? AND passwordHash=?',[currentHash,ownerId,legacyHash]);
            });
          },
        });
        return result.valid;
      } catch {
        return false;
      }
    },

    changePassword: async (ownerId: string, currentPassword: string, newPassword: string): Promise<void> => {
      if (!ownerId.trim()) throw new Error('Your local profile is unavailable. Sign in again.');
      if (newPassword.length < 10 || newPassword.length > 1024 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        throw new Error('The new password does not meet the HouseLog password requirements.');
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
      return withLocalWrite(database, async (transaction) => {
        const existing = await transaction.getFirstAsync<AccountRow>(
          'SELECT id, ownerId, name, type, balanceMinor, currency, createdAt, archivedAt, synced FROM Account WHERE id = ?', [id],
        );
        if (existing) {
          if (existing.archivedAt) throw new Error('This account ID belongs to an archived account.');
          if (!accountMatchesDraft(existing, normalized)) throw new Error('This account ID was already used for different account details.');
          return { ...normalized, id, createdAt: existing.createdAt, synced: false };
        }
        const createdAt = new Date().toISOString();
        await transaction.runAsync(
          'INSERT INTO Account (id, ownerId, name, type, balance, balanceMinor, currency, createdAt, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
          [id, normalized.ownerId, normalized.name, normalized.type, normalized.balanceMinor / 100, normalized.balanceMinor, normalized.currency, createdAt],
        );
        return { ...normalized, id, createdAt, synced: false };
      });
    },

    update: async ({ ownerId, accountId, changes }: { ownerId: string; accountId: string; changes: Partial<Pick<AccountDraft, 'name' | 'type' | 'balanceMinor' | 'currency'>> }) => {
      if (!ownerId.trim() || !accountId.trim()) throw new Error('A profile and account are required.');
      const database = await getDb();
      return withLocalWrite(database, async (transaction) => {
        const account = await editAccount(ownerId, accountId, changes, {
          findAccount: async (profileId, id) => transaction.getFirstAsync<AccountRow>('SELECT id, ownerId, name, type, balanceMinor, currency, createdAt, archivedAt, synced FROM Account WHERE id = ? AND ownerId = ?', [id, profileId]),
          countTransactions: async (profileId, id) => (await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM "Transaction" WHERE ownerId = ? AND (accountId = ? OR toAccountId = ?)', [profileId, id, id]))?.count ?? 0,
          updateAccount: async (candidate) => { await transaction.runAsync('UPDATE Account SET name = ?, type = ?, balanceMinor = ?, balance = ?, currency = ?, synced = 0 WHERE id = ? AND ownerId = ? AND archivedAt IS NULL', [candidate.name, candidate.type, candidate.balanceMinor, candidate.balanceMinor / 100, candidate.currency, accountId, ownerId]); },
          archiveAccount: async () => { throw new Error('Unexpected archive call during account edit.'); },
        });
        return { ...account, synced: false };
      });
    },

    archive: async ({ ownerId, accountId }: { ownerId: string; accountId: string }): Promise<void> => {
      if (!ownerId.trim() || !accountId.trim()) throw new Error('A profile and account are required.');
      const database = await getDb();
      await withLocalWrite(database, async (transaction) => {
        await archiveAccountRecord(ownerId, accountId, {
          findAccount: async (profileId, id) => transaction.getFirstAsync<AccountRow>('SELECT id, ownerId, name, type, balanceMinor, currency, createdAt, archivedAt, synced FROM Account WHERE id = ? AND ownerId = ?', [id, profileId]),
          countTransactions: async () => 0,
          updateAccount: async () => { throw new Error('Unexpected edit call during account archive.'); },
          archiveAccount: async (profileId, id, archivedAt) => { await transaction.runAsync('UPDATE Account SET archivedAt = COALESCE(archivedAt, ?), synced = 0 WHERE id = ? AND ownerId = ?', [archivedAt, id, profileId]); },
        });
      });
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
  },

  transaction: {
    findReportRows: async ({ ownerId, startDate, endDate }: {
      ownerId: string; startDate: string; endDate: string;
    }): Promise<FinancialReportRow[]> => {
      const database = await getDb();
      const query = buildFinancialReportQuery(ownerId, startDate, endDate);
      const rows = await database.getAllAsync<FinancialReportRow>(query.sql, query.params);
      return rows;
    },

    findBalanceRows: async (ownerId: string): Promise<Pick<LocalTransaction, 'id' | 'ownerId' | 'amountMinor' | 'type' | 'accountId' | 'toAccountId' | 'reversalOfId'>[]> => {
      if (!ownerId.trim()) throw new Error('A profile is required to calculate account balances.');
      const database = await getDb();
      const rows = await database.getAllAsync<TransactionRow>(`SELECT id,ownerId,amountMinor,type,categoryId,classificationId,accountId,toAccountId,date,note,sourceName,paymentMethod,sourceAmountMinor,sourceCurrency,exchangeRate,referenceNumber,taxStatus,taxYear,synced,reversalOfId,correctionOfId
        FROM "Transaction" WHERE ownerId=? ORDER BY date ASC,id ASC`, [ownerId]);
      return rows.map(validateTransactionRow).map((row) => ({
        id: row.id, ownerId: row.ownerId, amountMinor: row.amountMinor, type: row.type,
        accountId: row.accountId, toAccountId: row.toAccountId, reversalOfId: row.reversalOfId ?? null,
      }));
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

    findPage: async ({ ownerId, limit = 50, cursor, where }: {
      ownerId: string; limit?: number; cursor?: { date: string; id: string }; where?: { synced?: boolean };
    }): Promise<{ items: LocalTransaction[]; nextCursor: { date: string; id: string } | null }> => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Transaction page size must be between 1 and 100.');
      const rows = await localDb.transaction.findMany({ ownerId, orderBy: { date: 'desc' }, take: limit + 1, cursor, where });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items.at(-1);
      return { items, nextCursor: hasMore && last ? { date: last.date, id: last.id } : null };
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
      return withLocalWrite(database, (transaction) => createValidatedTransaction(data, transactionId, {
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
          await transaction.runAsync(
            'INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, toAccountId, date, note, sourceName, paymentMethod, sourceAmountMinor, sourceCurrency, exchangeRate, referenceNumber, taxStatus, taxYear, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
            [record.id, record.ownerId, record.amountMinor / 100, record.amountMinor, record.type, record.categoryLabel, record.categoryLabel, record.classificationId, record.accountId, record.toAccountId, record.date, record.note, record.sourceName, record.paymentMethod, record.sourceAmountMinor, record.sourceCurrency, record.exchangeRate, record.referenceNumber, record.taxStatus, record.taxYear],
          );
          await budgetingStore.validatePostTransaction(asBudgetingSql(transaction), record.ownerId, record.accountId);
        },
      }));
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
      return withLocalWrite(database, async (transaction) => {
        const original = await transaction.getFirstAsync<TransactionRow>('SELECT * FROM "Transaction" WHERE id = ? AND ownerId = ?', [originalTransactionId, ownerId]);
        if (!original || original.type === 'Refund' || original.type === 'Reversal' || !original.accountId) throw new Error('This transaction cannot be corrected.');
        const obligationLink=await transaction.getFirstAsync<{kind:string}>("SELECT 'bill' AS kind FROM BillPayment WHERE ownerId=? AND transactionId=? UNION ALL SELECT 'debt' AS kind FROM DebtEvent WHERE ownerId=? AND transactionId=? LIMIT 1",[ownerId,originalTransactionId,ownerId,originalTransactionId]);
        if(obligationLink) throw new Error('This bill or debt cash entry must be corrected through its obligation history.');
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
        const accounts = await Promise.all([original.accountId, original.toAccountId].filter((value): value is string => !!value).map(async (accountId) => transaction.getFirstAsync<{ id: string; ownerId: string; currency: string; type: string }>('SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ?', [accountId, ownerId])));
        if (accounts.some((account) => !account)) throw new Error('Original transaction refers to a missing account.');
        const existingReversalById = await transaction.getFirstAsync<{ type: string; ownerId: string; reversalOfId: string | null }>('SELECT type, ownerId, reversalOfId FROM "Transaction" WHERE id = ?', [reversalId]);
        if (existingReversalById && (existingReversalById.type !== 'Reversal' || existingReversalById.ownerId !== ownerId || existingReversalById.reversalOfId !== originalTransactionId)) throw new Error('Correction ID conflicts with an existing financial record.');
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
            await transaction.runAsync('INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, toAccountId, date, note, sourceName, paymentMethod, sourceAmountMinor, sourceCurrency, exchangeRate, referenceNumber, taxStatus, taxYear, synced, correctionOfId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)', [record.id, record.ownerId, record.amountMinor / 100, record.amountMinor, record.type, record.categoryLabel, record.categoryLabel, record.classificationId, record.accountId, record.toAccountId, record.date, record.note, record.sourceName, record.paymentMethod, record.sourceAmountMinor, record.sourceCurrency, record.exchangeRate, record.referenceNumber, record.taxStatus, record.taxYear, originalTransactionId]);
            await budgetingStore.validatePostTransaction(asBudgetingSql(transaction), record.ownerId, record.accountId);
          },
        });
        await transaction.runAsync('UPDATE "Transaction" SET correctionOfId = ? WHERE id = ? AND ownerId = ?', [originalTransactionId, result.id, ownerId]);
        return result;
      });
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

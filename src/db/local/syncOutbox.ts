import type { CurrencyCode, PaymentMethod, TaxStatus } from '../../finance/domain.ts';

export interface SyncSql {
  runAsync(source: string, params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params: (string | number | null)[]): Promise<T | null>;
}

export type CloudAccountPayload = {
  id: string; name: string; type: 'cash' | 'bank' | 'wallet' | 'savings'; currency: CurrencyCode; openingBalanceMinor: string;
};
export type CloudTransactionPayload = {
  id: string; type: 'income' | 'expense' | 'transfer' | 'refund' | 'reversal'; amountMinor: string; currency: CurrencyCode;
  classificationId: string; categoryLabel: string; accountId: string; toAccountId?: string;
  occurredAt: string; note: string | null; paymentMethod: PaymentMethod | null; sourceName: string | null;
  sourceAmountMinor: string | null; sourceCurrency: string | null; exchangeRate: string | null;
  referenceNumber: string | null; taxStatus: TaxStatus; taxYear: number | null;
  refundOfId?: string;
  reversalOfId?: string;
  correctionOfId?: string;
};

export interface OutboxMutation {
  mutationId: string;
  ownerId: string;
  cloudUserId: string;
  entityType: 'account' | 'transaction' | 'budget' | 'savings_goal' | 'savings_goal_event' | 'emergency_config' | 'emergency_event' | 'recurring_schedule' | 'schedule_occurrence'
    | 'bill' | 'bill_payment' | 'bill_payment_correction' | 'debt' | 'debt_event' | 'debt_interest_event' | 'debt_event_correction' | 'debt_repayment_schedule'
    | 'asset' | 'asset_valuation' | 'asset_activity' | 'investment_portfolio' | 'investment_holding' | 'investment_event' | 'investment_price';
  entityId: string;
  operation: 'account.create' | 'account.update' | 'account.archive' | 'transaction.create' | 'budget.create' | 'budget.revise' | 'budget.archive'
    | 'saving.goal.create' | 'saving.goal.update' | 'saving.goal.event' | 'emergency.config.save' | 'emergency.event'
    | 'recurring.schedule.create' | 'recurring.schedule.update' | 'schedule.occurrence.create' | 'schedule.occurrence.resolve' | 'domain.create' | 'domain.update';
  payload: Record<string, unknown>;
  dependencyEntityId?: string | null;
  attemptCount?: number;
  now?: string;
}

export function computeRetryDelayMs(attempt: number, random = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 20) throw new Error('Retry attempt is outside the supported range.');
  const base = Math.min(300_000, 1_000 * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + random()));
}

/** Pause the remaining profile queue after an API-wide failure; explicit manual sync releases it. */
export async function deferPendingCloudMutations(sql: SyncSql, ownerId: string, now = Date.now(), delayMs = 24 * 60 * 60 * 1000): Promise<void> {
  if (!ownerId.trim() || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(delayMs) || delayMs < 60_000 || delayMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('Cloud queue pause settings are invalid.');
  }
  await sql.runAsync("UPDATE SyncOutbox SET nextAttemptAt=MAX(nextAttemptAt,?),updatedAt=? WHERE ownerId=? AND status='pending'", [now + delayMs,new Date(now).toISOString(),ownerId]);
}

export async function releasePendingCloudMutations(sql: SyncSql, ownerId: string, now = Date.now()): Promise<void> {
  if (!ownerId.trim() || !Number.isSafeInteger(now) || now < 0) throw new Error('Cloud queue retry settings are invalid.');
  await sql.runAsync("UPDATE SyncOutbox SET nextAttemptAt=0,updatedAt=? WHERE ownerId=? AND status='pending'", [new Date(now).toISOString(),ownerId]);
}

export function validateCloudChangePage(currentCursor: string, nextCursor: string, changes: readonly Record<string, unknown>[]): void {
  const validCursor = (value: string) => /^(0|[1-9]\d{0,18})$/.test(value);
  if (!validCursor(currentCursor) || !validCursor(nextCursor)) throw new Error('The cloud synchronization cursor is invalid.');
  let expected = BigInt(currentCursor) + 1n;
  for (const change of changes) {
    if (typeof change.sequence !== 'string' || !validCursor(change.sequence) || BigInt(change.sequence) !== expected) {
      throw new Error('The cloud change page has a cursor gap or is out of order.');
    }
    if (!Number.isSafeInteger(change.revision) || Number(change.revision) < 1 || typeof change.entityId !== 'string' || !change.entityId) {
      throw new Error('The cloud change page contains invalid entity metadata.');
    }
    expected++;
  }
  const expectedNextCursor = changes.length ? (expected - 1n).toString() : currentCursor;
  if (expectedNextCursor !== nextCursor) throw new Error('The cloud change page cursor does not match its records.');
}

let syncWakeHandler: ((ownerId: string) => void) | null = null;
export function setSyncWakeHandler(handler: ((ownerId: string) => void) | null): void { syncWakeHandler = handler; }
export function wakeSync(ownerId: string): void { if (syncWakeHandler && ownerId.trim()) syncWakeHandler(ownerId); }

export async function activeCloudUser(sql: SyncSql, ownerId: string): Promise<string | null> {
  const row = await sql.getFirstAsync<{ cloudUserId: string }>(
    'SELECT cloudUserId FROM CloudIdentity WHERE ownerId=? AND syncEnabled=1', [ownerId],
  );
  return row?.cloudUserId ?? null;
}

/**
 * Counts all locally owned financial history before an empty-profile cloud link.
 * Keep this list aligned with the local schema: a profile with any dependent or
 * append-only history must use an explicit import workflow, never an empty link.
 */
export async function countLocalFinancialRecords(sql: SyncSql, ownerId: string): Promise<number> {
  const row = await sql.getFirstAsync<{ count: number }>(`SELECT
    (SELECT COUNT(*) FROM Account WHERE ownerId=?) +
    (SELECT COUNT(*) FROM "Transaction" WHERE ownerId=?) +
    (SELECT COUNT(*) FROM Budget WHERE ownerId=?) +
    (SELECT COUNT(*) FROM SavingsGoal WHERE ownerId=?) +
    (SELECT COUNT(*) FROM SavingsGoalEvent WHERE ownerId=?) +
    (SELECT COUNT(*) FROM EmergencyFundConfig WHERE ownerId=?) +
    (SELECT COUNT(*) FROM EmergencyFundEvent WHERE ownerId=?) +
    (SELECT COUNT(*) FROM RecurringSchedule WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ScheduleOccurrence WHERE ownerId=?) +
    (SELECT COUNT(*) FROM Bill WHERE ownerId=?) +
    (SELECT COUNT(*) FROM BillPayment WHERE ownerId=?) +
    (SELECT COUNT(*) FROM BillPaymentCorrection WHERE ownerId=?) +
    (SELECT COUNT(*) FROM BillPaymentCorrectionReplacement WHERE correctionId IN (SELECT id FROM BillPaymentCorrection WHERE ownerId=?)) +
    (SELECT COUNT(*) FROM Debt WHERE ownerId=?) +
    (SELECT COUNT(*) FROM DebtEvent WHERE ownerId=?) +
    (SELECT COUNT(*) FROM DebtInterestEvent WHERE ownerId=?) +
    (SELECT COUNT(*) FROM DebtEventCorrection WHERE ownerId=?) +
    (SELECT COUNT(*) FROM DebtEventCorrectionReplacement WHERE correctionId IN (SELECT id FROM DebtEventCorrection WHERE ownerId=?)) +
    (SELECT COUNT(*) FROM DebtRepaymentSchedule WHERE ownerId=?) +
    (SELECT COUNT(*) FROM Asset WHERE ownerId=?) +
    (SELECT COUNT(*) FROM AssetValuation WHERE ownerId=?) +
    (SELECT COUNT(*) FROM AssetActivity WHERE ownerId=?) +
    (SELECT COUNT(*) FROM InvestmentPortfolio WHERE ownerId=?) +
    (SELECT COUNT(*) FROM InvestmentHolding WHERE ownerId=?) +
    (SELECT COUNT(*) FROM InvestmentEvent WHERE ownerId=?) +
    (SELECT COUNT(*) FROM InvestmentPrice WHERE ownerId=?) +
    (SELECT COUNT(*) FROM Project WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ProjectMember WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ProjectExpense WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ProjectExpenseShare WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ProjectExpenseRefund WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ProjectCashEvent WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ProjectSettlement WHERE ownerId=?) +
    (SELECT COUNT(*) FROM ProjectBudget WHERE ownerId=?) AS count`, Array.from({ length: 34 }, () => ownerId));
  const count = row?.count;
  if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error('Local financial history could not be verified safely.');
  return count as number;
}

export async function enqueueCloudMutation(sql: SyncSql, mutation: OutboxMutation): Promise<void> {
  const now = mutation.now ?? new Date().toISOString();
  const prior = await sql.getFirstAsync<{ ownerId:string;cloudUserId:string;entityType:string;entityId:string;operation:string;payloadJson:string }>(
    'SELECT ownerId,cloudUserId,entityType,entityId,operation,payloadJson FROM SyncOutbox WHERE mutationId=?',[mutation.mutationId],
  );
  if (prior) {
    if (prior.ownerId!==mutation.ownerId || prior.cloudUserId!==mutation.cloudUserId || prior.entityType!==mutation.entityType || prior.entityId!==mutation.entityId || prior.operation!==mutation.operation || prior.payloadJson!==JSON.stringify(mutation.payload)) {
      throw new Error('An existing cloud import mutation conflicts with the current local financial record.');
    }
    return;
  }
  await sql.runAsync(`INSERT INTO SyncOutbox
    (mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,1,?,?, 'pending',0,0,?,?)`, [
    mutation.mutationId, mutation.ownerId, mutation.cloudUserId, mutation.entityType,
    mutation.entityId, mutation.operation, JSON.stringify(mutation.payload),
    mutation.dependencyEntityId ?? null, now, now,
  ]);
}

export async function assertCloudAccountType(sql: SyncSql, ownerId: string, type: string): Promise<void> {
  if (await activeCloudUser(sql, ownerId) && !['cash', 'bank', 'wallet', 'savings'].includes(type)) {
    throw new Error('This account type is not supported by cloud sync yet. It was not saved.');
  }
}

export type SavingsEventReferenceResult =
  | { status: 'ready'; payload: Record<string, unknown> }
  | { status: 'waiting' }
  | { status: 'missing'; category: string };

/**
 * Resolve savings-event references from either their device ID or an already
 * normalized cloud ID. Outbox payloads are persisted after normalization, so
 * retries must accept both forms without changing the mutation identity.
 */
export async function normalizeSavingsEventReferences(
  sql: SyncSql,
  ownerId: string,
  source: Record<string, unknown>,
): Promise<SavingsEventReferenceResult> {
  const payload = { ...source };
  const references: { key: string; entityType: string; category: string }[] = [
    { key: 'goalId', entityType: 'savings_goal', category: 'saving_goal_dependency_missing' },
    { key: 'accountId', entityType: 'account', category: 'account_dependency_missing' },
    { key: 'transactionId', entityType: 'transaction', category: 'transaction_dependency_missing' },
    { key: 'sourceAccountId', entityType: 'account', category: 'account_dependency_missing' },
    { key: 'destinationAccountId', entityType: 'account', category: 'account_dependency_missing' },
  ];
  for (const reference of references) {
    const inputId = payload[reference.key];
    if (inputId == null) continue;
    if (typeof inputId !== 'string' || !inputId) return { status: 'missing', category: reference.category };
    const mapping = await sql.getFirstAsync<{ cloudId: string }>(
      `SELECT cloudId FROM CloudEntityMap
       WHERE ownerId=? AND entityType=? AND (localId=? OR cloudId=?)
       ORDER BY CASE WHEN localId=? THEN 0 ELSE 1 END LIMIT 1`,
      [ownerId, reference.entityType, inputId, inputId, inputId],
    );
    if (mapping) {
      payload[reference.key] = mapping.cloudId;
      continue;
    }
    const pending = await sql.getFirstAsync<{ mutationId: string }>(
      `SELECT mutationId FROM SyncOutbox
       WHERE ownerId=? AND entityType=? AND entityId=? AND status IN ('pending','in_flight') LIMIT 1`,
      [ownerId, reference.entityType, inputId],
    );
    if (pending) return { status: 'waiting' };
    return { status: 'missing', category: reference.category };
  }
  return { status: 'ready', payload };
}

/** Retry transient failures and dependency failures only after every linked
 * savings record has a confirmed cloud identity mapping. */
export async function retryEligibleRejectedCloudChanges(
  sql: SyncSql,
  ownerId: string,
  cloudUserId: string,
  now = new Date().toISOString(),
): Promise<number> {
  const safeCategories = ['AUTH_REQUIRED','session_expired','network_or_timeout','DATABASE_UNAVAILABLE'];
  const result = await sql.runAsync(`UPDATE SyncOutbox AS o SET status='pending',attemptCount=0,nextAttemptAt=0,leaseUntil=NULL,lastErrorCategory=NULL,updatedAt=?
    WHERE ownerId=? AND cloudUserId=? AND status='rejected' AND (
      lastErrorCategory IN (${safeCategories.map(() => '?').join(',')})
      OR (lastErrorCategory='saving_goal_dependency_missing' AND entityType='savings_goal_event' AND operation='saving.goal.event'
        AND EXISTS (SELECT 1 FROM CloudEntityMap m WHERE m.ownerId=o.ownerId AND m.entityType='savings_goal' AND (m.localId=json_extract(o.payloadJson,'$.goalId') OR m.cloudId=json_extract(o.payloadJson,'$.goalId')))
        AND (json_type(o.payloadJson,'$.accountId') IS NULL OR json_type(o.payloadJson,'$.accountId')='null' OR EXISTS (SELECT 1 FROM CloudEntityMap m WHERE m.ownerId=o.ownerId AND m.entityType='account' AND (m.localId=json_extract(o.payloadJson,'$.accountId') OR m.cloudId=json_extract(o.payloadJson,'$.accountId'))))
        AND (json_type(o.payloadJson,'$.transactionId') IS NULL OR json_type(o.payloadJson,'$.transactionId')='null' OR EXISTS (SELECT 1 FROM CloudEntityMap m WHERE m.ownerId=o.ownerId AND m.entityType='transaction' AND (m.localId=json_extract(o.payloadJson,'$.transactionId') OR m.cloudId=json_extract(o.payloadJson,'$.transactionId'))))
        AND (json_type(o.payloadJson,'$.sourceAccountId') IS NULL OR json_type(o.payloadJson,'$.sourceAccountId')='null' OR EXISTS (SELECT 1 FROM CloudEntityMap m WHERE m.ownerId=o.ownerId AND m.entityType='account' AND (m.localId=json_extract(o.payloadJson,'$.sourceAccountId') OR m.cloudId=json_extract(o.payloadJson,'$.sourceAccountId'))))
        AND (json_type(o.payloadJson,'$.destinationAccountId') IS NULL OR json_type(o.payloadJson,'$.destinationAccountId')='null' OR EXISTS (SELECT 1 FROM CloudEntityMap m WHERE m.ownerId=o.ownerId AND m.entityType='account' AND (m.localId=json_extract(o.payloadJson,'$.destinationAccountId') OR m.cloudId=json_extract(o.payloadJson,'$.destinationAccountId'))))
      )
    )`, [now,ownerId,cloudUserId,...safeCategories]);
  const changes = result && typeof result === 'object' && 'changes' in result ? Number(result.changes) : 0;
  return Number.isSafeInteger(changes) && changes > 0 ? changes : 0;
}

export async function nextCloudAccountRevision(sql: SyncSql, ownerId: string, accountId: string): Promise<number> {
  const mapping = await sql.getFirstAsync<{ serverRevision: number | null }>(
    "SELECT serverRevision FROM CloudEntityMap WHERE ownerId=? AND entityType='account' AND localId=?", [ownerId,accountId],
  );
  const queuedCreate = await sql.getFirstAsync<{ n:number }>(
    "SELECT COUNT(*) AS n FROM SyncOutbox WHERE ownerId=? AND entityType='account' AND entityId=? AND operation='account.create' AND status IN ('pending','in_flight','confirmed')", [ownerId,accountId],
  );
  if (!mapping && !queuedCreate?.n) throw new Error('This account has not been created in the cloud yet.');
  const queuedUpdates = await sql.getFirstAsync<{ n:number }>(
    "SELECT COUNT(*) AS n FROM SyncOutbox WHERE ownerId=? AND entityType='account' AND entityId=? AND operation='account.update' AND status IN ('pending','in_flight')", [ownerId,accountId],
  );
  const revision = (mapping?.serverRevision ?? 1) + (queuedUpdates?.n ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('The cloud account revision is invalid.');
  return revision;
}

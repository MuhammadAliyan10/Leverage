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
    (SELECT COUNT(*) FROM InvestmentPrice WHERE ownerId=?) AS count`, Array.from({ length: 26 }, () => ownerId));
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

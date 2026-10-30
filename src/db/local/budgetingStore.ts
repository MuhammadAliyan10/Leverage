import { calculateBudgetSnapshot, calculateEmergencyFundTarget, rollMonthlyBudget } from '../../finance/budgeting.ts';
import { buildFinancialReportQuery, calculateFinancialReport } from '../../finance/reporting.ts';
import { EXPENSE_CLASSIFICATION_IDS, isCurrencyCode } from '../../finance/domain.ts';

export interface BudgetingSql {
  getFirstAsync<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]>;
  runAsync(sql: string, params?: readonly (string | number | null)[]): Promise<unknown>;
}

export type BudgetingWrite = <T>(task: (transaction: BudgetingSql) => Promise<T>) => Promise<T>;

export interface BudgetRecord {
  id: string;
  ownerId: string;
  categoryId: string;
  amountMinor: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  rolloverPolicy: 'reset' | 'carry_unused';
  revision: number;
  supersedesId: string | null;
  supersededAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface GoalRecord {
  id: string;
  ownerId: string;
  name: string;
  targetMinor: number;
  currency: string;
  targetDate: string | null;
  status: 'active' | 'completed' | 'archived';
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  actualMinor: number;
  plannedMinor: number;
}

export interface GoalEventRecord {
  id: string;
  ownerId: string;
  goalId: string;
  eventType: 'planned' | 'allocate' | 'release' | 'transfer_in' | 'transfer_out';
  amountMinor: number;
  currency: string;
  accountId: string | null;
  transactionId: string | null;
  idempotencyKey: string;
  eventDate: string;
  note: string;
  createdAt: string;
}

export interface EmergencyFundRecord {
  ownerId: string;
  currency: string;
  coverageMonths: number;
  essentialMonthlyMinor: number;
  requiredMinor: number;
  allocatedMinor: number;
  remainingMinor: number;
  coverageMonthsActual: number;
  updatedAt: string;
}

const EXPENSE_CATEGORIES = new Set<string>(EXPENSE_CLASSIFICATION_IDS);

function positiveMinor(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer amount in minor units.`);
  }
}

function assertProfile(ownerId: string): void {
  if (!ownerId.trim()) throw new Error('A profile is required.');
}

function assertCurrency(currency: string): void {
  if (!isCurrencyCode(currency)) throw new Error('Choose a supported currency.');
}

function validIsoDate(value: string | null, label: string): void {
  if (value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)))) {
    throw new Error(`${label} must be a valid calendar date.`);
  }
}

function assertMonthlyPeriod(start: string, end: string): void {
  validIsoDate(start, 'Budget period start');
  validIsoDate(end, 'Budget period end');
  const parsed = new Date(`${start}T00:00:00.000Z`);
  if (!start.endsWith('-01') || new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1)).toISOString().slice(0, 10) !== end) {
    throw new Error('Budget periods must cover one complete calendar month.');
  }
}

function budgetMatches(row: BudgetRecord, input: SaveBudgetInput): boolean {
  return row.ownerId === input.ownerId && row.categoryId === input.categoryId && row.amountMinor === input.amountMinor &&
    row.currency === input.currency && row.periodStart === input.periodStart && row.periodEnd === input.periodEnd &&
    row.rolloverPolicy === input.rolloverPolicy;
}

export interface SaveBudgetInput {
  id: string;
  ownerId: string;
  categoryId: string;
  amountMinor: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  rolloverPolicy: 'reset' | 'carry_unused';
  replacesBudgetId?: string;
}

export interface SaveGoalInput {
  id: string;
  ownerId: string;
  name: string;
  targetMinor: number;
  currency: string;
  targetDate: string | null;
}

export type GoalEventType = GoalEventRecord['eventType'];
export interface AddGoalEventInput {
  id: string;
  ownerId: string;
  goalId: string;
  eventType: GoalEventType;
  amountMinor: number;
  eventDate: string;
  note?: string;
  accountId?: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
}

interface AccountFundsRow { id: string; ownerId: string; currency: string; archivedAt: string | null }
interface MoneyRow { amountMinor: number }

/** Repository factory keeps all financial writes inside the same transaction adapter used by Expo SQLite. */
export function createBudgetingStore(
  getDatabase: () => Promise<BudgetingSql>,
  withWrite: BudgetingWrite,
) {
  const accountBalance = async (db: BudgetingSql, ownerId: string, accountId: string): Promise<bigint> => {
    const row = await db.getFirstAsync<MoneyRow>(`
      SELECT a.balanceMinor + COALESCE(SUM(CASE
        WHEN t.type IN ('Income', 'Refund') AND t.accountId = a.id THEN t.amountMinor
        WHEN t.type = 'Expense' AND t.accountId = a.id THEN -t.amountMinor
        WHEN t.type = 'Transfer' AND t.accountId = a.id THEN -t.amountMinor
        WHEN t.type = 'Transfer' AND t.toAccountId = a.id THEN t.amountMinor
        WHEN t.type = 'Reversal' AND original.type = 'Income' AND t.accountId = a.id THEN -t.amountMinor
        WHEN t.type = 'Reversal' AND original.type = 'Expense' AND t.accountId = a.id THEN t.amountMinor
        WHEN t.type = 'Reversal' AND original.type = 'Refund' AND t.accountId = a.id THEN -t.amountMinor
        WHEN t.type = 'Reversal' AND original.type = 'Transfer' AND t.accountId = a.id THEN t.amountMinor
        WHEN t.type = 'Reversal' AND original.type = 'Transfer' AND t.toAccountId = a.id THEN -t.amountMinor
        ELSE 0 END), 0) AS amountMinor
      FROM Account a
      LEFT JOIN "Transaction" t ON t.ownerId = a.ownerId AND (t.accountId = a.id OR t.toAccountId = a.id)
      LEFT JOIN "Transaction" original ON original.id = t.reversalOfId AND original.ownerId = t.ownerId
      WHERE a.id = ? AND a.ownerId = ? GROUP BY a.id
    `, [accountId, ownerId]);
    if (!row || !Number.isSafeInteger(row.amountMinor)) throw new Error('The selected account balance could not be verified.');
    return BigInt(row.amountMinor);
  };

  const accountReservations = async (db: BudgetingSql, ownerId: string, accountId: string): Promise<bigint> => {
    const row = await db.getFirstAsync<{ amountMinor: number | null }>(`
      SELECT COALESCE(SUM(amount), 0) AS amountMinor FROM (
        SELECT CASE WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor ELSE -amountMinor END AS amount
          FROM SavingsGoalEvent WHERE ownerId = ? AND accountId = ?
        UNION ALL
        SELECT CASE WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor ELSE -amountMinor END AS amount
          FROM EmergencyFundEvent WHERE ownerId = ? AND accountId = ?
      )
    `, [ownerId, accountId, ownerId, accountId]);
    return BigInt(row?.amountMinor ?? 0);
  };

  const goalReservation = async (db: BudgetingSql, ownerId: string, goalId: string, accountId: string): Promise<bigint> => {
    const row = await db.getFirstAsync<{ amountMinor: number | null }>(`
      SELECT COALESCE(SUM(CASE WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor ELSE -amountMinor END), 0) AS amountMinor
      FROM SavingsGoalEvent WHERE ownerId = ? AND goalId = ? AND accountId = ?
    `, [ownerId, goalId, accountId]);
    return BigInt(row?.amountMinor ?? 0);
  };

  const emergencyReservation = async (db: BudgetingSql, ownerId: string, accountId: string): Promise<bigint> => {
    const row = await db.getFirstAsync<{ amountMinor: number | null }>(`
      SELECT COALESCE(SUM(CASE WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor ELSE -amountMinor END), 0) AS amountMinor
      FROM EmergencyFundEvent WHERE ownerId = ? AND accountId = ?
    `, [ownerId, accountId]);
    return BigInt(row?.amountMinor ?? 0);
  };

  const getAccount = async (db: BudgetingSql, ownerId: string, accountId: string, currency: string): Promise<AccountFundsRow> => {
    const account = await db.getFirstAsync<AccountFundsRow>(
      'SELECT id, ownerId, currency, archivedAt FROM Account WHERE id = ? AND ownerId = ?', [accountId, ownerId],
    );
    if (!account || account.currency !== currency) throw new Error('The selected account must belong to this profile and use the fund currency.');
    return account;
  };

  const assertUnreservedBalanceAfterDebit = async (
    db: BudgetingSql, ownerId: string, accountId: string, debitMinor: bigint, reservationReleaseMinor = 0n,
  ): Promise<void> => {
    const balance = await accountBalance(db, ownerId, accountId);
    const reserved = await accountReservations(db, ownerId, accountId);
    const remainingReserved = reserved - reservationReleaseMinor;
    if (remainingReserved < 0n || balance - debitMinor < remainingReserved) throw new Error('This would spend money already earmarked for a savings or emergency fund.');
  };

  const assertExistingReservationsCovered = async (db: BudgetingSql, ownerId: string, accountId: string): Promise<void> => {
    const balance = await accountBalance(db, ownerId, accountId);
    const reserved = await accountReservations(db, ownerId, accountId);
    if (balance < reserved) {
      throw new Error('This would spend money reserved for savings. Lower the amount or release it.');
    }
  };

  const insertTransfer = async (
    db: BudgetingSql,
    ownerId: string,
    id: string,
    amountMinor: number,
    sourceAccountId: string,
    destinationAccountId: string,
    currency: string,
    at: string,
    note: string,
    reservationReleaseMinor = 0n,
  ): Promise<string> => {
    if (sourceAccountId === destinationAccountId) throw new Error('Choose two different accounts for a savings transfer.');
    const [source, destination] = await Promise.all([
      getAccount(db, ownerId, sourceAccountId, currency), getAccount(db, ownerId, destinationAccountId, currency),
    ]);
    if (source.archivedAt || destination.archivedAt) throw new Error('Savings transfers require active accounts.');
    await assertUnreservedBalanceAfterDebit(db, ownerId, sourceAccountId, BigInt(amountMinor), reservationReleaseMinor);
    const transactionId = `fund-transfer:${id}`;
    await db.runAsync(`INSERT INTO "Transaction"
      (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, toAccountId,
       date, note, taxStatus, synced)
      VALUES (?, ?, ?, ?, 'Transfer', 'Internal transfer', 'internal_transfer', NULL, ?, ?, ?, ?, 'unreviewed', 0)`,
    [transactionId, ownerId, amountMinor / 100, amountMinor, sourceAccountId, destinationAccountId, at, note]);
    return transactionId;
  };

  const insertGoalEvent = async (db: BudgetingSql, input: AddGoalEventInput): Promise<GoalEventRecord> => {
    assertProfile(input.ownerId);
    if (!input.id.trim() || !input.goalId.trim()) throw new Error('A stable event ID and savings goal are required.');
    positiveMinor(input.amountMinor, 'Savings amount');
    const eventDate = new Date(input.eventDate);
    if (!Number.isFinite(eventDate.getTime())) throw new Error('Savings event date is invalid.');
    if (input.note && input.note.length > 1000) throw new Error('Savings note must be 1,000 characters or fewer.');
    const existing = await db.getFirstAsync<GoalEventRecord>('SELECT * FROM SavingsGoalEvent WHERE ownerId = ? AND id = ?', [input.ownerId, input.id]);
    if (existing) {
      const transfer = input.eventType === 'transfer_in' || input.eventType === 'transfer_out';
      const expectedAccountId = input.eventType === 'transfer_in' ? input.destinationAccountId
        : input.eventType === 'transfer_out' ? input.sourceAccountId : input.accountId ?? null;
      if (existing.goalId !== input.goalId || existing.eventType !== input.eventType || existing.amountMinor !== input.amountMinor ||
        existing.accountId !== expectedAccountId || existing.eventDate !== eventDate.toISOString() || existing.note !== (input.note?.trim() ?? '') ||
        existing.transactionId !== (transfer ? `fund-transfer:${input.id}` : null)) {
        throw new Error('This savings event ID was already used for different details.');
      }
      return existing;
    }
    const goal = await db.getFirstAsync<{ id: string; ownerId: string; currency: string; status: string; targetMinor: number }>(
      'SELECT id, ownerId, currency, status, targetMinor FROM SavingsGoal WHERE id = ? AND ownerId = ?', [input.goalId, input.ownerId],
    );
    if (!goal || (goal.status !== 'active' && input.eventType !== 'release' && input.eventType !== 'transfer_out')) {
      throw new Error('Choose an active savings goal for contributions, or release funds from its existing allocation.');
    }
    let accountId: string | null = null;
    let transactionId: string | null = null;
    if (input.eventType === 'planned') {
      if (input.accountId || input.sourceAccountId || input.destinationAccountId) throw new Error('A planned contribution does not move money between accounts.');
    } else if (input.eventType === 'allocate' || input.eventType === 'release') {
      if (!input.accountId || input.sourceAccountId || input.destinationAccountId) throw new Error('Choose one account for an earmark or release.');
      const account = await getAccount(db, input.ownerId, input.accountId, goal.currency);
      if (input.eventType === 'allocate') {
        if (account.archivedAt) throw new Error('Choose an active account to earmark funds.');
        const balance = await accountBalance(db, input.ownerId, account.id);
        const reserved = await accountReservations(db, input.ownerId, account.id);
        if (balance - reserved < BigInt(input.amountMinor)) throw new Error('There is not enough unallocated money in this account.');
      } else if (await goalReservation(db, input.ownerId, goal.id, account.id) < BigInt(input.amountMinor)) {
        throw new Error('The goal does not have that much earmarked in this account.');
      }
      accountId = account.id;
    } else if (input.eventType === 'transfer_in' || input.eventType === 'transfer_out') {
      if (!input.sourceAccountId || !input.destinationAccountId || input.accountId) throw new Error('Choose the source and destination accounts for the transfer.');
      if (input.eventType === 'transfer_out' && await goalReservation(db, input.ownerId, goal.id, input.sourceAccountId) < BigInt(input.amountMinor)) {
        throw new Error('The goal does not have that much allocated in the source account.');
      }
      const transferDate = eventDate.toISOString();
      transactionId = await insertTransfer(db, input.ownerId, input.id, input.amountMinor,
        input.sourceAccountId, input.destinationAccountId, goal.currency, transferDate, input.note?.trim() ?? '',
        input.eventType === 'transfer_out' ? BigInt(input.amountMinor) : 0n);
      accountId = input.eventType === 'transfer_in' ? input.destinationAccountId : input.sourceAccountId;
      if (input.eventType === 'transfer_in') {
        const balance = await accountBalance(db, input.ownerId, accountId);
        const reserved = await accountReservations(db, input.ownerId, accountId);
        if (balance - reserved < BigInt(input.amountMinor)) throw new Error('The destination account has an inconsistent fund allocation.');
      }
    } else {
      throw new Error('Savings event type is unsupported.');
    }
    const createdAt = new Date().toISOString();
    await db.runAsync(`INSERT INTO SavingsGoalEvent
      (id, ownerId, goalId, eventType, amountMinor, currency, accountId, transactionId, idempotencyKey, eventDate, note, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.ownerId, input.goalId, input.eventType, input.amountMinor, goal.currency, accountId, transactionId,
      input.id, eventDate.toISOString(), input.note?.trim() ?? '', createdAt]);
    if (goal.status === 'completed' && (input.eventType === 'release' || input.eventType === 'transfer_out')) {
      const progress = await db.getFirstAsync<{ actualMinor: number }>(`SELECT COALESCE(SUM(CASE
        WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor
        WHEN eventType IN ('release', 'transfer_out') THEN -amountMinor ELSE 0 END), 0) AS actualMinor
        FROM SavingsGoalEvent WHERE ownerId = ? AND goalId = ?`, [input.ownerId, goal.id]);
      if ((progress?.actualMinor ?? 0) < goal.targetMinor) {
        await db.runAsync("UPDATE SavingsGoal SET status = 'active', completedAt = NULL, updatedAt = ? WHERE id = ? AND ownerId = ? AND status = 'completed'",
          [createdAt, goal.id, input.ownerId]);
      }
    }
    return (await db.getFirstAsync<GoalEventRecord>('SELECT * FROM SavingsGoalEvent WHERE ownerId = ? AND id = ?', [input.ownerId, input.id]))!;
  };

  const insertEmergencyEvent = async (
    db: BudgetingSql,
    input: Omit<AddGoalEventInput, 'goalId' | 'eventType'> & { eventType: 'allocate' | 'release' | 'transfer_in' | 'transfer_out' },
    currency: string,
  ): Promise<void> => {
    assertProfile(input.ownerId);
    positiveMinor(input.amountMinor, 'Emergency fund amount');
    if (!input.id.trim()) throw new Error('A stable emergency-fund event ID is required.');
    const eventDate = new Date(input.eventDate);
    if (!Number.isFinite(eventDate.getTime())) throw new Error('Emergency-fund event date is invalid.');
    const existing = await db.getFirstAsync<{ id: string; eventType: string; amountMinor: number; accountId: string; currency: string; transactionId: string | null; eventDate: string; note: string }>(
      'SELECT * FROM EmergencyFundEvent WHERE ownerId = ? AND id = ?', [input.ownerId, input.id],
    );
    if (existing) {
      const transfer = input.eventType === 'transfer_in' || input.eventType === 'transfer_out';
      const expectedAccountId = input.eventType === 'transfer_in' ? input.destinationAccountId
        : input.eventType === 'transfer_out' ? input.sourceAccountId : input.accountId;
      if (existing.eventType !== input.eventType || existing.amountMinor !== input.amountMinor || existing.currency !== currency ||
        existing.accountId !== expectedAccountId || existing.eventDate !== eventDate.toISOString() || existing.note !== (input.note?.trim() ?? '') ||
        existing.transactionId !== (transfer ? `fund-transfer:${input.id}` : null)) throw new Error('This emergency-fund event ID was already used for different details.');
      return;
    }
    let accountId: string;
    let transactionId: string | null = null;
    if (input.eventType === 'allocate' || input.eventType === 'release') {
      if (!input.accountId || input.sourceAccountId || input.destinationAccountId) throw new Error('Choose one account for an emergency-fund earmark or release.');
      const account = await getAccount(db, input.ownerId, input.accountId, currency);
      if (input.eventType === 'allocate') {
        if (account.archivedAt) throw new Error('Choose an active account to earmark funds.');
        const balance = await accountBalance(db, input.ownerId, account.id);
        const reserved = await accountReservations(db, input.ownerId, account.id);
        if (balance - reserved < BigInt(input.amountMinor)) throw new Error('There is not enough unallocated money in this account.');
      } else if (await emergencyReservation(db, input.ownerId, account.id) < BigInt(input.amountMinor)) {
        throw new Error('The emergency fund does not have that much earmarked in this account.');
      }
      accountId = account.id;
    } else {
      if (!input.sourceAccountId || !input.destinationAccountId || input.accountId) throw new Error('Choose the source and destination accounts for the transfer.');
      if (input.eventType === 'transfer_out' && await emergencyReservation(db, input.ownerId, input.sourceAccountId) < BigInt(input.amountMinor)) {
        throw new Error('The emergency fund does not have that much allocated in the source account.');
      }
      transactionId = await insertTransfer(db, input.ownerId, input.id, input.amountMinor, input.sourceAccountId,
        input.destinationAccountId, currency, eventDate.toISOString(), input.note?.trim() ?? '',
        input.eventType === 'transfer_out' ? BigInt(input.amountMinor) : 0n);
      accountId = input.eventType === 'transfer_in' ? input.destinationAccountId : input.sourceAccountId;
      if (input.eventType === 'transfer_in') {
        const balance = await accountBalance(db, input.ownerId, accountId);
        const reserved = await accountReservations(db, input.ownerId, accountId);
        if (balance - reserved < BigInt(input.amountMinor)) throw new Error('The destination account has an inconsistent fund allocation.');
      }
    }
    await db.runAsync(`INSERT INTO EmergencyFundEvent
      (id, ownerId, eventType, amountMinor, currency, accountId, transactionId, idempotencyKey, eventDate, note, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [input.id, input.ownerId, input.eventType, input.amountMinor,
      currency, accountId, transactionId, input.id, eventDate.toISOString(), input.note?.trim() ?? '', new Date().toISOString()]);
  };

  const saveBudget = async (db: BudgetingSql, input: SaveBudgetInput): Promise<BudgetRecord> => {
    assertProfile(input.ownerId);
    if (!input.id.trim()) throw new Error('A stable budget ID is required.');
    if (!EXPENSE_CATEGORIES.has(input.categoryId)) throw new Error('Choose a supported expense category.');
    positiveMinor(input.amountMinor, 'Budget limit');
    assertCurrency(input.currency);
    assertMonthlyPeriod(input.periodStart, input.periodEnd);
    if (input.rolloverPolicy !== 'reset' && input.rolloverPolicy !== 'carry_unused') throw new Error('Budget rollover policy is invalid.');
    const duplicateId = await db.getFirstAsync<BudgetRecord>('SELECT * FROM Budget WHERE id = ? AND ownerId = ?', [input.id, input.ownerId]);
    if (duplicateId) {
      if (!budgetMatches(duplicateId, input)) throw new Error('This budget ID was already used for different details.');
      return duplicateId;
    }
    const current = await db.getFirstAsync<BudgetRecord>(`SELECT * FROM Budget
      WHERE ownerId = ? AND categoryId = ? AND currency = ? AND periodStart = ? AND supersededAt IS NULL AND archivedAt IS NULL`,
    [input.ownerId, input.categoryId, input.currency, input.periodStart]);
    if (input.replacesBudgetId) {
      if (!current || current.id !== input.replacesBudgetId) throw new Error('The budget changed; refresh and try again.');
      await db.runAsync('UPDATE Budget SET supersededAt = ? WHERE id = ? AND ownerId = ? AND supersededAt IS NULL AND archivedAt IS NULL',
        [new Date().toISOString(), current.id, input.ownerId]);
    } else if (current) {
      throw new Error('A budget already exists for this category, currency and month. Edit the existing budget instead.');
    }
    const revision = await db.getFirstAsync<{ revision: number | null }>(
      'SELECT MAX(revision) AS revision FROM Budget WHERE ownerId = ? AND categoryId = ? AND currency = ? AND periodStart = ?',
      [input.ownerId, input.categoryId, input.currency, input.periodStart],
    );
    await db.runAsync(`INSERT INTO Budget
      (id, ownerId, categoryId, amountMinor, currency, periodStart, periodEnd, rolloverPolicy, revision, supersedesId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.ownerId, input.categoryId, input.amountMinor, input.currency, input.periodStart, input.periodEnd,
      input.rolloverPolicy, (revision?.revision ?? 0) + 1, current?.id ?? input.replacesBudgetId ?? null, new Date().toISOString()]);
    return (await db.getFirstAsync<BudgetRecord>('SELECT * FROM Budget WHERE id = ? AND ownerId = ?', [input.id, input.ownerId]))!;
  };

  return {
    validatePostTransaction: (db: BudgetingSql, ownerId: string, accountId: string) => assertExistingReservationsCovered(db, ownerId, accountId),
    budget: {
      list: async (ownerId: string, periodStart?: string, includeHistory = false): Promise<BudgetRecord[]> => {
        assertProfile(ownerId);
        const db = await getDatabase();
        const filters = includeHistory ? '' : ' AND supersededAt IS NULL AND archivedAt IS NULL';
        const periodFilter = periodStart ? ' AND periodStart = ?' : '';
        return db.getAllAsync<BudgetRecord>(`SELECT * FROM Budget WHERE ownerId = ?${filters}${periodFilter} ORDER BY periodStart DESC, currency, categoryId, revision DESC`,
          periodStart ? [ownerId, periodStart] : [ownerId]);
      },
      save: (input: SaveBudgetInput) => withWrite((db) => saveBudget(db, input)),
      archive: async (ownerId: string, budgetId: string): Promise<void> => {
        assertProfile(ownerId);
        await withWrite(async (db) => {
          const result = await db.runAsync('UPDATE Budget SET archivedAt = COALESCE(archivedAt, ?) WHERE id = ? AND ownerId = ? AND supersededAt IS NULL',
            [new Date().toISOString(), budgetId, ownerId]);
          const changes = typeof result === 'object' && result !== null && 'changes' in result
            ? Number((result as { changes: number }).changes)
            : undefined;
          if (changes === 0) {
            const exists = await db.getFirstAsync<{ id: string }>('SELECT id FROM Budget WHERE id = ? AND ownerId = ?', [budgetId, ownerId]);
            if (!exists) throw new Error('Budget not found for this profile.');
          }
        });
      },
      deleteUnused: async (ownerId: string, budgetId: string): Promise<void> => {
        assertProfile(ownerId);
        await withWrite(async (db) => {
          const row = await db.getFirstAsync<BudgetRecord>('SELECT * FROM Budget WHERE id = ? AND ownerId = ?', [budgetId, ownerId]);
          if (!row) throw new Error('Budget not found for this profile.');
          if (row.supersedesId || await db.getFirstAsync('SELECT id FROM Budget WHERE supersedesId = ? LIMIT 1', [row.id])) {
            throw new Error('Budget history exists; archive this definition instead of deleting it.');
          }
          const used = await db.getFirstAsync<{ used: number }>(`
            SELECT EXISTS(
              SELECT 1 FROM "Transaction" t
              LEFT JOIN Account a ON a.id = t.accountId AND a.ownerId = t.ownerId
              LEFT JOIN "Transaction" original ON original.id = t.reversalOfId AND original.ownerId = t.ownerId
              WHERE t.ownerId = ? AND t.date >= ? AND t.date < ? AND
                (a.currency = ? OR EXISTS(SELECT 1 FROM Account d WHERE d.id = t.toAccountId AND d.ownerId = t.ownerId AND d.currency = ?)) AND
                (t.type = 'Expense' AND t.classificationId = ? OR
                 t.type IN ('Refund', 'Reversal') AND original.classificationId = ?)
            ) AS used`, [ownerId, row.periodStart, row.periodEnd, row.currency, row.currency, row.categoryId, row.categoryId]);
          if (used?.used) throw new Error('This budget period has related financial activity; archive it to preserve history.');
          await db.runAsync('DELETE FROM Budget WHERE id = ? AND ownerId = ?', [budgetId, ownerId]);
        });
      },
      rollover: async (input: { ownerId: string; sourcePeriodStart: string; targetPeriodStart: string; requestId: string; policy: 'reset' | 'carry_unused' }): Promise<BudgetRecord[]> => {
        assertProfile(input.ownerId);
        if (!input.requestId.trim()) throw new Error('A stable rollover request ID is required.');
        const sourceDate = new Date(`${input.sourcePeriodStart}T00:00:00.000Z`);
        const targetDate = new Date(`${input.targetPeriodStart}T00:00:00.000Z`);
        if (!Number.isFinite(sourceDate.getTime()) || !Number.isFinite(targetDate.getTime())) throw new Error('Budget rollover month is invalid.');
        const next = new Date(Date.UTC(sourceDate.getUTCFullYear(), sourceDate.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
        if (input.targetPeriodStart !== next) throw new Error('Budgets can roll forward by one month at a time.');
        return withWrite(async (db) => {
          const source = await db.getAllAsync<BudgetRecord>(`SELECT * FROM Budget WHERE ownerId = ? AND periodStart = ? AND supersededAt IS NULL AND archivedAt IS NULL ORDER BY currency, categoryId`,
            [input.ownerId, input.sourcePeriodStart]);
          if (!source.length) throw new Error('There are no active budgets to roll forward.');
          const rowsQuery = buildFinancialReportQuery(input.ownerId, `${input.sourcePeriodStart}T00:00:00.000Z`, `${source[0].periodEnd}T00:00:00.000Z`);
          const rows = await db.getAllAsync<import('../../finance/reporting.ts').FinancialReportRow>(rowsQuery.sql, rowsQuery.params);
          const groups = new Map<string, BudgetRecord[]>();
          for (const budget of source) groups.set(budget.currency, [...(groups.get(budget.currency) ?? []), budget]);
          const output: BudgetRecord[] = [];
          let index = 0;
          for (const [currency, budgets] of groups) {
            const report = calculateFinancialReport(rows, currency, {
              startDate: `${input.sourcePeriodStart}T00:00:00.000Z`, endDate: `${source[0].periodEnd}T00:00:00.000Z`,
            });
            const prior = calculateBudgetSnapshot({ ownerId: input.ownerId, reportOwnerId: input.ownerId, currency,
              startDate: `${input.sourcePeriodStart}T00:00:00.000Z`, endDate: `${source[0].periodEnd}T00:00:00.000Z`,
              allocations: budgets.map(({ categoryId, amountMinor }) => ({ category: categoryId, amountMinor })), report });
            const rolled = rollMonthlyBudget(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), input.ownerId, currency,
              budgets.map(({ categoryId, amountMinor }) => ({ category: categoryId, amountMinor })), prior, input.policy);
            for (const allocation of rolled.allocations) {
              const id = `${input.requestId}:${index++}`;
              output.push(await saveBudget(db, { id, ownerId: input.ownerId, categoryId: allocation.category,
                amountMinor: allocation.amountMinor, currency, periodStart: input.targetPeriodStart,
                periodEnd: rolled.endDate.slice(0, 10), rolloverPolicy: input.policy }));
            }
          }
          return output;
        });
      },
    },

    savings: {
      reservationsByAccount: async (ownerId: string): Promise<{ accountId: string; amountMinor: number }[]> => {
        assertProfile(ownerId);
        const db = await getDatabase();
        const rows = await db.getAllAsync<{ accountId: string; amountMinor: number }>(`
          SELECT accountId, SUM(amount) AS amountMinor FROM (
            SELECT accountId, CASE WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor ELSE -amountMinor END AS amount
              FROM SavingsGoalEvent WHERE ownerId = ? AND accountId IS NOT NULL
            UNION ALL
            SELECT accountId, CASE WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor ELSE -amountMinor END AS amount
              FROM EmergencyFundEvent WHERE ownerId = ? AND accountId IS NOT NULL
          ) GROUP BY accountId
        `, [ownerId, ownerId]);
        return rows.map((row) => {
          if (!row.accountId || !Number.isSafeInteger(row.amountMinor)) throw new Error('A savings reservation is invalid.');
          return row;
        });
      },
      goals: async (ownerId: string): Promise<GoalRecord[]> => {
        assertProfile(ownerId);
        const db = await getDatabase();
        return db.getAllAsync<GoalRecord>(`
          SELECT g.*, COALESCE(SUM(CASE WHEN e.eventType IN ('allocate', 'transfer_in') THEN e.amountMinor
            WHEN e.eventType IN ('release', 'transfer_out') THEN -e.amountMinor ELSE 0 END), 0) AS actualMinor,
            COALESCE(SUM(CASE WHEN e.eventType = 'planned' THEN e.amountMinor ELSE 0 END), 0) AS plannedMinor
          FROM SavingsGoal g LEFT JOIN SavingsGoalEvent e ON e.ownerId = g.ownerId AND e.goalId = g.id
          WHERE g.ownerId = ? GROUP BY g.id ORDER BY CASE g.status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, g.createdAt DESC`, [ownerId]);
      },
      history: async (ownerId: string, goalId: string): Promise<GoalEventRecord[]> => {
        assertProfile(ownerId);
        const db = await getDatabase();
        return db.getAllAsync<GoalEventRecord>('SELECT * FROM SavingsGoalEvent WHERE ownerId = ? AND goalId = ? ORDER BY eventDate DESC, id DESC', [ownerId, goalId]);
      },
      save: async (input: SaveGoalInput): Promise<GoalRecord> => withWrite(async (db) => {
        assertProfile(input.ownerId);
        if (!input.id.trim() || input.name.trim().length < 1 || input.name.trim().length > 100) throw new Error('Savings goal name must be between 1 and 100 characters.');
        positiveMinor(input.targetMinor, 'Savings goal target');
        assertCurrency(input.currency);
        validIsoDate(input.targetDate, 'Savings goal deadline');
        const existing = await db.getFirstAsync<{ id: string; ownerId: string; currency: string; status: string }>('SELECT id, ownerId, currency, status FROM SavingsGoal WHERE id = ? AND ownerId = ?', [input.id, input.ownerId]);
        if (existing) {
          if (existing.currency !== input.currency) {
            const events = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM SavingsGoalEvent WHERE ownerId = ? AND goalId = ?', [input.ownerId, input.id]);
            if (events?.count) throw new Error('A savings goal currency cannot change after it has history.');
          }
          if (existing.status !== 'active') throw new Error('Only active savings goals can be edited.');
          await db.runAsync('UPDATE SavingsGoal SET name = ?, targetMinor = ?, currency = ?, targetDate = ?, updatedAt = ? WHERE id = ? AND ownerId = ?',
            [input.name.trim(), input.targetMinor, input.currency, input.targetDate, new Date().toISOString(), input.id, input.ownerId]);
        } else {
          const now = new Date().toISOString();
          await db.runAsync(`INSERT INTO SavingsGoal (id, ownerId, name, targetMinor, currency, targetDate, status, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [input.id, input.ownerId, input.name.trim(), input.targetMinor, input.currency, input.targetDate, now, now]);
        }
        return (await db.getFirstAsync<GoalRecord>(`SELECT g.*, 0 AS actualMinor, 0 AS plannedMinor FROM SavingsGoal g WHERE id = ? AND ownerId = ?`, [input.id, input.ownerId]))!;
      }),
      setStatus: async (ownerId: string, goalId: string, status: 'completed' | 'archived'): Promise<void> => withWrite(async (db) => {
        assertProfile(ownerId);
        const goal = await db.getFirstAsync<{ targetMinor: number; actualMinor: number; status: string }>(`
          SELECT g.targetMinor, g.status, COALESCE(SUM(CASE WHEN e.eventType IN ('allocate', 'transfer_in') THEN e.amountMinor
            WHEN e.eventType IN ('release', 'transfer_out') THEN -e.amountMinor ELSE 0 END), 0) AS actualMinor
          FROM SavingsGoal g LEFT JOIN SavingsGoalEvent e ON e.ownerId = g.ownerId AND e.goalId = g.id
          WHERE g.ownerId = ? AND g.id = ? GROUP BY g.id`, [ownerId, goalId]);
        if (!goal) throw new Error('Savings goal not found for this profile.');
        if (goal.status === 'archived') throw new Error('Archived savings goals cannot change status.');
        if (status === 'completed' && goal.actualMinor < goal.targetMinor) throw new Error('The goal must reach its target before it can be completed.');
        const at = new Date().toISOString();
        await db.runAsync('UPDATE SavingsGoal SET status = ?, completedAt = ?, archivedAt = ?, updatedAt = ? WHERE id = ? AND ownerId = ?',
          [status, status === 'completed' ? at : null, status === 'archived' ? at : null, at, goalId, ownerId]);
      }),
      addEvent: (input: AddGoalEventInput) => withWrite((db) => insertGoalEvent(db, input)),
    },

    emergency: {
      get: async (ownerId: string): Promise<EmergencyFundRecord | null> => {
        assertProfile(ownerId);
        const db = await getDatabase();
        const config = await db.getFirstAsync<{ ownerId: string; currency: string; coverageMonths: number; essentialMonthlyMinor: number; updatedAt: string }>(
          'SELECT * FROM EmergencyFundConfig WHERE ownerId = ?', [ownerId]);
        if (!config) return null;
        const totals = await db.getFirstAsync<{ allocatedMinor: number }>(`SELECT COALESCE(SUM(CASE
          WHEN eventType IN ('allocate', 'transfer_in') THEN amountMinor ELSE -amountMinor END), 0) AS allocatedMinor
          FROM EmergencyFundEvent WHERE ownerId = ?`, [ownerId]);
        const allocatedMinor = totals?.allocatedMinor ?? 0;
        const requiredMinor = calculateEmergencyFundTarget(config.currency,
          [{ currency: config.currency, amountMinor: config.essentialMonthlyMinor }], config.coverageMonths);
        return { ...config, requiredMinor, allocatedMinor, remainingMinor: Math.max(0, requiredMinor - allocatedMinor),
          coverageMonthsActual: config.essentialMonthlyMinor > 0 ? Number((BigInt(allocatedMinor) * 100n) / BigInt(config.essentialMonthlyMinor)) / 100 : 0 };
      },
      saveConfig: async (input: { ownerId: string; currency: string; coverageMonths: number; essentialMonthlyMinor: number }): Promise<void> => withWrite(async (db) => {
        assertProfile(input.ownerId);
        assertCurrency(input.currency);
        positiveMinor(input.essentialMonthlyMinor, 'Essential monthly estimate', true);
        if (!Number.isInteger(input.coverageMonths) || input.coverageMonths < 1 || input.coverageMonths > 60) throw new Error('Coverage target must be between 1 and 60 months.');
        const existing = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM EmergencyFundConfig WHERE ownerId = ?', [input.ownerId]);
        if (existing && existing.currency !== input.currency) {
          const events = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM EmergencyFundEvent WHERE ownerId = ?', [input.ownerId]);
          if (events?.count) throw new Error('Emergency-fund currency cannot change after it has history.');
        }
        await db.runAsync(`INSERT INTO EmergencyFundConfig (ownerId, currency, coverageMonths, essentialMonthlyMinor, updatedAt)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(ownerId) DO UPDATE SET currency = excluded.currency,
          coverageMonths = excluded.coverageMonths, essentialMonthlyMinor = excluded.essentialMonthlyMinor, updatedAt = excluded.updatedAt`,
        [input.ownerId, input.currency, input.coverageMonths, input.essentialMonthlyMinor, new Date().toISOString()]);
      }),
      addEvent: (input: Omit<AddGoalEventInput, 'goalId' | 'eventType'> & { eventType: 'allocate' | 'release' | 'transfer_in' | 'transfer_out' }) => withWrite(async (db) => {
        const config = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM EmergencyFundConfig WHERE ownerId = ?', [input.ownerId]);
        if (!config) throw new Error('Set up the emergency fund before recording allocations.');
        await insertEmergencyEvent(db, input, config.currency);
      }),
      history: async (ownerId: string): Promise<Record<string, unknown>[]> => {
        assertProfile(ownerId);
        const db = await getDatabase();
        return db.getAllAsync('SELECT * FROM EmergencyFundEvent WHERE ownerId = ? ORDER BY eventDate DESC, id DESC', [ownerId]);
      },
    },
  };
}

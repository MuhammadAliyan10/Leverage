import { CLASSIFICATIONS, resolveClassification } from './domain.ts';

export interface FinancialReportRow {
  id: string;
  ownerId: string;
  date: string;
  amountMinor: number;
  type: string;
  category: string;
  classificationId?: string | null;
  note: string;
  accountId: string | null;
  toAccountId: string | null;
  accountCurrency: string | null;
  destinationCurrency: string | null;
  reversalOfId: string | null;
  linkedOriginalAccountId: string | null;
  linkedOriginalToAccountId: string | null;
  linkedOriginalType: string | null;
  linkedCategory: string | null;
  linkedClassificationId?: string | null;
  linkedCurrency: string | null;
  linkedDestinationCurrency: string | null;
  linkedRootType: string | null;
  linkedRootId: string | null;
  linkedRootAccountId?: string | null;
  linkedRootCurrency: string | null;
}

export interface FinancialReport {
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  expenseCount: number;
  netMinor: number;
  categoryTotals: { category: string; amountMinor: number }[];
  incomeSourceTotals: { source: string; amountMinor: number }[];
  largestExpenses: FinancialReportRow[];
  excludedCurrencies: string[];
}

export interface FinancialBucket {
  id: string;
  group: string;
  startDate: string;
  endDate: string;
}

export interface FinancialBucketTotals { incomeMinor: number; expenseMinor: number }

export type CashFlowSection = 'operating' | 'investing' | 'financing';
export interface CashFlowSectionSummary {
  section: CashFlowSection;
  inflowsMinor: number;
  outflowsMinor: number;
  netMinor: number;
}

const INVESTING_CASH_CATEGORIES = new Set([
  'asset_purchase', 'asset_sale_proceeds', 'investment_purchase', 'investment_sale_proceeds', 'investment_dividend',
]);
const FINANCING_CASH_CATEGORIES = new Set([
  'debt_borrowing', 'debt_lending', 'debt_principal_repayment', 'debt_receivable_payment', 'debt_settlement',
]);

/**
 * Cash-basis personal cash flow. Own-account transfers are excluded; loans,
 * principal movements, and asset/investment transactions are classified outside
 * ordinary income and spending. All values remain in the selected currency.
 */
export function calculateCashFlowSections(
  rows: readonly FinancialReportRow[],
  currency: string,
  range: { startDate: string; endDate: string },
): CashFlowSectionSummary[] {
  if (!currency.trim()) throw new Error('A cash-flow currency is required.');
  const startMs = new Date(range.startDate).getTime();
  const endMs = new Date(range.endDate).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('Cash-flow date range is invalid.');

  const values: Record<CashFlowSection, { inflows: bigint; outflows: bigint }> = {
    operating: { inflows: 0n, outflows: 0n },
    investing: { inflows: 0n, outflows: 0n },
    financing: { inflows: 0n, outflows: 0n },
  };

  for (const row of rows) {
    const timestamp = transactionDateTimestamp(row.date);
    if (!Number.isFinite(timestamp)) throw new Error(`Transaction ${row.id} has an invalid date.`);
    if (timestamp < startMs || timestamp >= endMs || row.accountCurrency !== currency) continue;
    if (!row.id || !row.ownerId || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) throw new Error('A cash-flow transaction is invalid.');
    if (!['Income', 'Expense', 'Transfer', 'Refund', 'Reversal'].includes(row.type)) throw new Error(`Transaction ${row.id} has an unsupported type.`);

    // A transfer only moves money between the user's own accounts. Its reversal
    // is also excluded, so neither can inflate the total cash flow.
    if (row.type === 'Transfer' || (row.type === 'Reversal' && row.linkedOriginalType === 'Transfer')) continue;
    if ((row.type === 'Refund' || row.type === 'Reversal') && (!row.reversalOfId || !row.linkedCategory)) {
      throw new Error(`Transaction ${row.id} is missing its linked correction details.`);
    }

    const category = row.type === 'Refund' || row.type === 'Reversal' ? row.linkedCategory! : row.category;
    const section: CashFlowSection = FINANCING_CASH_CATEGORIES.has(category)
      ? 'financing'
      : INVESTING_CASH_CATEGORIES.has(category) ? 'investing' : 'operating';
    let signedMovement: bigint;
    if (row.type === 'Income' || row.type === 'Refund') signedMovement = BigInt(row.amountMinor);
    else if (row.type === 'Expense') signedMovement = -BigInt(row.amountMinor);
    else if (row.linkedOriginalType === 'Income' || row.linkedOriginalType === 'Refund') signedMovement = -BigInt(row.amountMinor);
    else if (row.linkedOriginalType === 'Expense') signedMovement = BigInt(row.amountMinor);
    else throw new Error(`Transaction ${row.id} has an unsupported correction type.`);

    if (signedMovement >= 0n) values[section].inflows += signedMovement;
    else values[section].outflows += -signedMovement;
  }

  return (['operating', 'investing', 'financing'] as const).map((section) => {
    const inflowsMinor = safeNumber(values[section].inflows, `${section} cash inflows`);
    const outflowsMinor = safeNumber(values[section].outflows, `${section} cash outflows`);
    return { section, inflowsMinor, outflowsMinor, netMinor: safeNumber(values[section].inflows - values[section].outflows, `${section} net cash flow`) };
  });
}

const NON_OPERATING_CASH_CATEGORIES = new Set([
  'debt_borrowing', 'debt_lending', 'debt_principal_repayment', 'debt_receivable_payment', 'debt_settlement',
  'asset_purchase', 'asset_sale_proceeds', 'investment_purchase', 'investment_sale_proceeds',
]);

/** Date-only legacy values are civil dates, kept at local noon without inventing an offset. */
export function transactionDateTimestamp(value: string): number {
  const civilDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (civilDate) {
    const year = Number(civilDate[1]); const month = Number(civilDate[2]) - 1; const day = Number(civilDate[3]);
    const date = new Date(year, month, day, 12);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return Number.NaN;
    return date.getTime();
  }
  return new Date(value).getTime();
}

/** Resolves a local calendar month without deriving date keys from UTC ISO strings. */
export function dashboardMonthRange(date: Date): {
  periodStart: string;
  periodEnd: string;
  startDate: string;
  endDate: string;
} {
  if (!Number.isFinite(date.getTime())) throw new Error('Dashboard report date is invalid.');
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  const key = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return { periodStart: key(start), periodEnd: key(end), startDate: start.toISOString(), endDate: end.toISOString() };
}

function isNonOperatingMovement(row: FinancialReportRow): boolean {
  const category = row.type === 'Refund' || row.type === 'Reversal' ? row.linkedCategory : row.category;
  return category !== null && category !== undefined && NON_OPERATING_CASH_CATEGORIES.has(category);
}

/**
 * Complete, profile-scoped report slice. The owner/date index serves this range query;
 * joins deliberately retain archived accounts and resolve reversal provenance.
 */
export function buildFinancialReportQuery(ownerId: string, startDate: string, endDate: string): {
  sql: string;
  params: [string, string, string];
} {
  if (!ownerId.trim()) throw new Error('A profile is required to read financial reports.');
  if (!Number.isFinite(new Date(startDate).getTime()) || !Number.isFinite(new Date(endDate).getTime()) || startDate >= endDate) {
    throw new Error('Financial report date range is invalid.');
  }
  const startDay = new Date(startDate).toISOString().slice(0, 10);
  const endDay = new Date(endDate);
  // At an exact UTC midnight, the date-only bound is already exclusive. For local-time
  // boundaries, include the rest of that UTC calendar day and trim by exact instant later.
  if (endDay.getUTCHours() || endDay.getUTCMinutes() || endDay.getUTCSeconds() || endDay.getUTCMilliseconds()) {
    endDay.setUTCDate(endDay.getUTCDate() + 1);
  }
  return {
    sql: `
      SELECT t.id, t.ownerId, t.date, t.amountMinor, t.type, t.categoryId AS category, COALESCE(t.note, '') AS note,
        t.accountId, t.toAccountId, t.reversalOfId, t.classificationId, a.currency AS accountCurrency, destination.currency AS destinationCurrency,
        original.accountId AS linkedOriginalAccountId, original.toAccountId AS linkedOriginalToAccountId,
        original.type AS linkedOriginalType,
        CASE WHEN original.type = 'Refund' THEN rootOriginal.categoryId ELSE original.categoryId END AS linkedCategory,
        CASE WHEN original.type = 'Refund' THEN rootOriginal.classificationId ELSE original.classificationId END AS linkedClassificationId,
        originalAccount.currency AS linkedCurrency,
        originalDestination.currency AS linkedDestinationCurrency,
        rootOriginal.type AS linkedRootType,
        rootOriginal.id AS linkedRootId,
        rootOriginal.accountId AS linkedRootAccountId,
        rootAccount.currency AS linkedRootCurrency
      FROM "Transaction" t
      LEFT JOIN Account a ON a.id = t.accountId AND a.ownerId = t.ownerId
      LEFT JOIN Account destination ON destination.id = t.toAccountId AND destination.ownerId = t.ownerId
      LEFT JOIN "Transaction" original ON original.id = t.reversalOfId AND original.ownerId = t.ownerId
      LEFT JOIN Account originalAccount ON originalAccount.id = original.accountId AND originalAccount.ownerId = original.ownerId
      LEFT JOIN Account originalDestination ON originalDestination.id = original.toAccountId AND originalDestination.ownerId = original.ownerId
      LEFT JOIN "Transaction" rootOriginal ON rootOriginal.id = original.reversalOfId AND rootOriginal.ownerId = original.ownerId
      LEFT JOIN Account rootAccount ON rootAccount.id = rootOriginal.accountId AND rootAccount.ownerId = rootOriginal.ownerId
      WHERE t.ownerId = ? AND t.date >= ? AND t.date < ?
      ORDER BY t.date ASC, t.id ASC
    `,
    // Day bounds remain sargable against the owner/date index across ISO and legacy
    // SQLite datetime strings. Exact instant bounds are applied by the calculator.
    params: [ownerId, startDay, endDay.toISOString().slice(0, 10)],
  };
}

/** Selects rows already denominated in the report currency without implicit conversion. */
export function transactionsInCurrency<T extends { accountCurrency: string | null }>(
  transactions: readonly T[],
  currency: string,
): T[] {
  if (!currency.trim()) throw new Error('A report currency is required.');
  return transactions.filter((transaction) => transaction.accountCurrency === currency);
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return Number(value);
}

/** Calculates totals from the full report slice; no page or display-list data is accepted. */
export function calculateFinancialReport(
  rows: readonly FinancialReportRow[],
  currency: string,
  range: { startDate: string; endDate: string },
): FinancialReport {
  if (!currency.trim()) throw new Error('A report currency is required.');
  if (!Number.isFinite(new Date(range.startDate).getTime()) || !Number.isFinite(new Date(range.endDate).getTime()) || range.startDate >= range.endDate) {
    throw new Error('Financial report date range is invalid.');
  }
  let income = 0n;
  let expense = 0n;
  const categoryTotals = new Map<string, bigint>();
  const incomeSourceTotals = new Map<string, bigint>();
  const excluded = new Set<string>();
  const expenseRows = new Map<string, FinancialReportRow>();
  const expenseAdjustmentById = new Map<string, bigint>();
  const addExpenseAdjustment = (id: string, adjustment: bigint) => {
    expenseAdjustmentById.set(id, (expenseAdjustmentById.get(id) ?? 0n) + adjustment);
  };
  const incomeSource = (classificationId: string | null | undefined, category: string): string => {
    const resolved = resolveClassification(classificationId ?? category);
    if (resolved && CLASSIFICATIONS[resolved].type === 'Income') return resolved;
    // Preserve an unknown legacy label for review instead of assigning it a
    // plausible but potentially false source.
    return category.trim() || 'Unclassified income';
  };

  const startMs = new Date(range.startDate).getTime();
  const endMs = new Date(range.endDate).getTime();
  const periodRows = rows.filter((row) => {
    const timestamp = transactionDateTimestamp(row.date);
    if (!Number.isFinite(timestamp)) throw new Error(`Transaction ${row.id} has an invalid date.`);
    return timestamp >= startMs && timestamp < endMs;
  });
  for (const row of periodRows) {
    if (!row.id || !row.ownerId || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) {
      throw new Error('A financial report row is invalid.');
    }
    if (!Number.isFinite(transactionDateTimestamp(row.date))) throw new Error(`Transaction ${row.id} has an invalid date.`);

    const type = row.type;
    if (!['Income', 'Expense', 'Transfer', 'Refund', 'Reversal'].includes(type)) {
      throw new Error(`Transaction ${row.id} has an unsupported type.`);
    }
    if (type === 'Refund' && (row.linkedOriginalType !== 'Expense' || !row.reversalOfId || !row.linkedCategory)) {
      throw new Error(`Refund ${row.id} does not refer to a recorded expense.`);
    }
    if ((type === 'Income' || type === 'Expense' || type === 'Refund') && row.toAccountId !== null) {
      throw new Error(`Transaction ${row.id} has an unexpected destination account.`);
    }
    if (type === 'Transfer' && (!row.accountId || !row.toAccountId || row.accountId === row.toAccountId ||
      !row.accountCurrency || !row.destinationCurrency || row.accountCurrency !== row.destinationCurrency)) {
      throw new Error(`Transfer ${row.id} has invalid or mismatched accounts.`);
    }
    if (type === 'Reversal') {
      if (!row.reversalOfId || !row.linkedOriginalType || !row.linkedCategory) {
        throw new Error(`Reversal ${row.id} does not refer to a recorded transaction.`);
      }
      if (row.linkedOriginalType === 'Refund' && row.linkedRootType !== 'Expense') {
        throw new Error(`Reversal ${row.id} does not refer to a valid expense refund.`);
      }
      if (!['Income', 'Expense', 'Transfer', 'Refund'].includes(row.linkedOriginalType)) {
        throw new Error(`Reversal ${row.id} refers to an unsupported transaction.`);
      }
      if (row.accountId !== row.linkedOriginalAccountId || row.toAccountId !== row.linkedOriginalToAccountId) {
        throw new Error(`Reversal ${row.id} does not mirror the original transaction accounts.`);
      }
      if (row.linkedOriginalType === 'Transfer' && (!row.destinationCurrency || row.destinationCurrency !== row.accountCurrency ||
        row.linkedDestinationCurrency !== row.linkedCurrency)) {
        throw new Error(`Transfer reversal ${row.id} has inconsistent currencies.`);
      }
    }

    // Validate linked-account currency even when this row is excluded from the PKR report.
    if ((type === 'Refund' || type === 'Reversal') && row.accountCurrency !== row.linkedCurrency) {
      throw new Error(`Transaction ${row.id} uses a different currency from its linked record.`);
    }
    if (type === 'Reversal' && row.linkedOriginalType === 'Refund' && row.linkedCurrency !== row.linkedRootCurrency) {
      throw new Error(`Reversal ${row.id} uses a different currency from the refunded expense.`);
    }

    if (row.accountCurrency !== currency) {
      excluded.add(row.accountCurrency ?? 'Unknown currency');
      continue;
    }

    const amount = BigInt(row.amountMinor);
    // Explicit principal/receivable movements change cash and debt balances, not earned
    // income or ordinary spending. Linked reversals follow the original classification.
    if (isNonOperatingMovement(row)) continue;
    if (type === 'Income') {
      income += amount;
      const source = incomeSource(row.classificationId, row.category);
      incomeSourceTotals.set(source, (incomeSourceTotals.get(source) ?? 0n) + amount);
    }
    else if (type === 'Expense') {
      expense += amount;
      expenseRows.set(row.id, row);
      categoryTotals.set(row.category, (categoryTotals.get(row.category) ?? 0n) + amount);
    } else if (type === 'Refund') {
      expense -= amount;
      addExpenseAdjustment(row.reversalOfId!, -amount);
      categoryTotals.set(row.linkedCategory!, (categoryTotals.get(row.linkedCategory!) ?? 0n) - amount);
    } else if (type === 'Reversal') {
      if (row.linkedOriginalType === 'Income') {
        income -= amount;
        const source = incomeSource(row.linkedClassificationId, row.linkedCategory!);
        incomeSourceTotals.set(source, (incomeSourceTotals.get(source) ?? 0n) - amount);
      }
      else if (row.linkedOriginalType === 'Expense') {
        expense -= amount;
        addExpenseAdjustment(row.reversalOfId!, -amount);
        categoryTotals.set(row.linkedCategory!, (categoryTotals.get(row.linkedCategory!) ?? 0n) - amount);
      } else if (row.linkedOriginalType === 'Refund') {
        expense += amount;
        if (row.linkedRootId) addExpenseAdjustment(row.linkedRootId, amount);
        categoryTotals.set(row.linkedCategory!, (categoryTotals.get(row.linkedCategory!) ?? 0n) + amount);
      }
      // Transfers and their reversals change account balances, never income or expense.
    }
  }

  const largestExpenses: FinancialReportRow[] = Array.from(expenseRows, ([id, row]) => {
    const netAmount = BigInt(row.amountMinor) + (expenseAdjustmentById.get(id) ?? 0n);
    if (netAmount < 0n) throw new Error(`Refunds or reversals exceed expense ${id}.`);
    if (netAmount <= 0n) return null;
    return { ...row, amountMinor: safeNumber(netAmount, `Net expense ${id}`) };
  }).filter((row): row is FinancialReportRow => row !== null);
  const expenseCount = largestExpenses.length;
  largestExpenses.sort((a, b) => b.amountMinor - a.amountMinor || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const expenseMinor = safeNumber(expense, 'Report expense total');
  const incomeMinor = safeNumber(income, 'Report income total');
  const net = income - expense;
  return {
    currency,
    incomeMinor,
    expenseMinor,
    expenseCount,
    netMinor: safeNumber(net, 'Report net total'),
    categoryTotals: Array.from(categoryTotals).filter(([, amountMinor]) => amountMinor !== 0n).map(([category, amountMinor]) => ({
      category,
      amountMinor: safeNumber(amountMinor, 'Report category total'),
    })).sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor) || a.category.localeCompare(b.category)),
    incomeSourceTotals: Array.from(incomeSourceTotals).filter(([, amountMinor]) => amountMinor !== 0n).map(([source, amountMinor]) => ({
      source,
      amountMinor: safeNumber(amountMinor, 'Report income source total'),
    })).sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor) || a.source.localeCompare(b.source)),
    largestExpenses: largestExpenses.slice(0, 5),
    excludedCurrencies: Array.from(excluded).sort(),
  };
}

/** Groups signed, refund-adjusted ordinary spending by the account funding it. */
export function calculateSpendingByAccountTotals(
  rows: readonly FinancialReportRow[],
  currency: string,
  range: { startDate: string; endDate: string },
): { accountId: string | null; amountMinor: number }[] {
  if (!currency.trim()) throw new Error('A report currency is required.');
  const startMs = new Date(range.startDate).getTime();
  const endMs = new Date(range.endDate).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('Financial report date range is invalid.');
  const totals = new Map<string | null, bigint>();
  const add = (accountId: string | null, amount: bigint) => totals.set(accountId, (totals.get(accountId) ?? 0n) + amount);
  for (const row of rows) {
    const timestamp = transactionDateTimestamp(row.date);
    if (!Number.isFinite(timestamp)) throw new Error(`Transaction ${row.id} has an invalid date.`);
    if (timestamp < startMs || timestamp >= endMs || row.accountCurrency !== currency || isNonOperatingMovement(row)) continue;
    if (!row.id || !row.ownerId || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) throw new Error('A financial report row is invalid.');
    if (!['Income', 'Expense', 'Transfer', 'Refund', 'Reversal'].includes(row.type)) throw new Error(`Transaction ${row.id} has an unsupported type.`);
    if (row.type === 'Refund' && (row.linkedOriginalType !== 'Expense' || !row.reversalOfId || !row.linkedOriginalAccountId || row.accountCurrency !== row.linkedCurrency)) throw new Error(`Refund ${row.id} does not refer to a compatible expense.`);
    if (row.type === 'Reversal' && (!row.reversalOfId || !row.linkedOriginalType || row.accountId !== row.linkedOriginalAccountId || row.accountCurrency !== row.linkedCurrency)) throw new Error(`Reversal ${row.id} does not refer to a compatible transaction.`);
    const amount = BigInt(row.amountMinor);
    if (row.type === 'Expense') add(row.accountId, amount);
    else if (row.type === 'Refund') add(row.linkedOriginalAccountId ?? row.accountId, -amount);
    else if (row.type === 'Reversal' && row.linkedOriginalType === 'Expense') add(row.accountId, -amount);
    else if (row.type === 'Reversal' && row.linkedOriginalType === 'Refund') add(row.linkedRootAccountId ?? row.accountId, amount);
  }
  return [...totals]
    .filter(([, amount]) => amount !== 0n)
    .map(([accountId, amount]) => ({ accountId, amountMinor: safeNumber(amount, 'Account spending total') }))
    .sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor) || (a.accountId ?? '').localeCompare(b.accountId ?? ''));
}

/**
 * Builds many non-overlapping chart buckets in one pass over complete report rows.
 * Buckets are grouped by scale (for example daily/weekly/monthly/yearly); each row
 * contributes to at most one bucket in each group.
 */
export function calculateExpenseBucketTotals(
  rows: readonly FinancialReportRow[],
  currency: string,
  buckets: readonly FinancialBucket[],
): Readonly<Record<string, number>> {
  if (!currency.trim()) throw new Error('A report currency is required.');
  const byGroup = new Map<string, (FinancialBucket & { startMs: number; endMs: number })[]>();
  const seenIds = new Set<string>();
  for (const bucket of buckets) {
    const startMs = new Date(bucket.startDate).getTime();
    const endMs = new Date(bucket.endDate).getTime();
    if (!bucket.id.trim() || !bucket.group.trim() || seenIds.has(bucket.id) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('Financial chart bucket is invalid.');
    }
    seenIds.add(bucket.id);
    const group = byGroup.get(bucket.group) ?? [];
    group.push({ ...bucket, startMs, endMs });
    byGroup.set(bucket.group, group);
  }
  for (const group of byGroup.values()) {
    group.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    for (let index = 1; index < group.length; index += 1) {
      if (group[index - 1].endMs > group[index].startMs) throw new Error('Financial chart buckets in one group must not overlap.');
    }
  }

  const totals = new Map<string, bigint>(buckets.map((bucket) => [bucket.id, 0n]));
  const findBucket = (group: (FinancialBucket & { startMs: number; endMs: number })[], timestamp: number) => {
    let low = 0;
    let high = group.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const bucket = group[middle];
      if (timestamp < bucket.startMs) high = middle - 1;
      else if (timestamp >= bucket.endMs) low = middle + 1;
      else return bucket;
    }
    return undefined;
  };

  for (const row of rows) {
    const timestamp = transactionDateTimestamp(row.date);
    if (!Number.isFinite(timestamp)) throw new Error(`Transaction ${row.id} has an invalid date.`);
    if (!row.id || !row.ownerId || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) throw new Error('A financial report row is invalid.');
    if (!['Income', 'Expense', 'Transfer', 'Refund', 'Reversal'].includes(row.type)) throw new Error(`Transaction ${row.id} has an unsupported type.`);
    if (row.type === 'Refund' && (row.linkedOriginalType !== 'Expense' || !row.reversalOfId || !row.linkedCategory)) {
      throw new Error(`Refund ${row.id} does not refer to a recorded expense.`);
    }
    if (row.type === 'Reversal' && (!row.reversalOfId || !row.linkedOriginalType || !row.linkedCategory)) {
      throw new Error(`Reversal ${row.id} does not refer to a recorded transaction.`);
    }
    if ((row.type === 'Refund' || row.type === 'Reversal') && row.accountCurrency !== row.linkedCurrency) {
      throw new Error(`Transaction ${row.id} uses a different currency from its linked record.`);
    }
    if (row.accountCurrency !== currency || isNonOperatingMovement(row)) continue;

    let expenseDelta = 0n;
    if (row.type === 'Expense') expenseDelta = BigInt(row.amountMinor);
    else if (row.type === 'Refund') expenseDelta = -BigInt(row.amountMinor);
    else if (row.type === 'Reversal' && row.linkedOriginalType === 'Expense') expenseDelta = -BigInt(row.amountMinor);
    else if (row.type === 'Reversal' && row.linkedOriginalType === 'Refund') expenseDelta = BigInt(row.amountMinor);
    if (expenseDelta === 0n) continue;

    for (const group of byGroup.values()) {
      const bucket = findBucket(group, timestamp);
      if (bucket) totals.set(bucket.id, (totals.get(bucket.id) ?? 0n) + expenseDelta);
    }
  }

  return Object.fromEntries([...totals].map(([id, total]) => [id, safeNumber(total, `Chart bucket ${id}`)]));
}

/** Aggregates income and signed ordinary spending into a bounded set of non-overlapping chart buckets in one pass. */
export function calculateFinancialBucketTotals(
  rows: readonly FinancialReportRow[],
  currency: string,
  buckets: readonly FinancialBucket[],
): Readonly<Record<string, FinancialBucketTotals>> {
  if (!currency.trim()) throw new Error('A report currency is required.');
  const ranges = buckets.map((bucket) => {
    const start = new Date(bucket.startDate).getTime(); const end = new Date(bucket.endDate).getTime();
    if (!bucket.id.trim() || !bucket.group.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Financial chart bucket is invalid.');
    return { bucket, start, end };
  }).sort((a, b) => a.start - b.start || a.bucket.id.localeCompare(b.bucket.id));
  if (new Set(ranges.map(({ bucket }) => bucket.group)).size > 1) throw new Error('Financial totals require one chart bucket group at a time.');
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].bucket.group === ranges[index].bucket.group && ranges[index - 1].end > ranges[index].start) throw new Error('Financial chart buckets in one group must not overlap.');
  }
  const totals = new Map(ranges.map(({ bucket }) => [bucket.id, { income: 0n, expense: 0n }]));
  for (const row of rows) {
    const timestamp = transactionDateTimestamp(row.date);
    if (!Number.isFinite(timestamp)) throw new Error(`Transaction ${row.id} has an invalid date.`);
    let low = 0; let high = ranges.length - 1; let match: (typeof ranges)[number] | undefined;
    while (low <= high) {
      const middle = (low + high) >>> 1; const candidate = ranges[middle];
      if (timestamp < candidate.start) high = middle - 1;
      else if (timestamp >= candidate.end) low = middle + 1;
      else { match = candidate; break; }
    }
    if (!match) continue;
    if (!row.id || !row.ownerId || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) throw new Error('A financial report row is invalid.');
    if (!['Income', 'Expense', 'Transfer', 'Refund', 'Reversal'].includes(row.type)) throw new Error(`Transaction ${row.id} has an unsupported type.`);
    if (row.type === 'Refund' && (row.linkedOriginalType !== 'Expense' || !row.reversalOfId || !row.linkedCategory || row.accountCurrency !== row.linkedCurrency)) throw new Error(`Refund ${row.id} does not refer to a compatible recorded expense.`);
    if (row.type === 'Reversal' && (!row.reversalOfId || !row.linkedOriginalType || !row.linkedCategory || row.accountCurrency !== row.linkedCurrency)) throw new Error(`Reversal ${row.id} does not refer to a compatible recorded transaction.`);
    if (row.accountCurrency !== currency || isNonOperatingMovement(row)) continue;
    const total = totals.get(match.bucket.id)!;
    const amount = BigInt(row.amountMinor);
    if (row.type === 'Income') total.income += amount;
    else if (row.type === 'Expense') total.expense += amount;
    else if (row.type === 'Refund') total.expense -= amount;
    else if (row.type === 'Reversal') {
      if (row.linkedOriginalType === 'Income') total.income -= amount;
      else if (row.linkedOriginalType === 'Expense') total.expense -= amount;
      else if (row.linkedOriginalType === 'Refund') total.expense += amount;
    }
  }
  return Object.fromEntries([...totals].map(([id, value]) => [id, {
    incomeMinor: safeNumber(value.income, `Chart income bucket ${id}`),
    expenseMinor: safeNumber(value.expense, `Chart expense bucket ${id}`),
  }]));
}

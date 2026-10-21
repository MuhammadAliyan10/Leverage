export interface FinancialReportRow {
  id: string;
  ownerId: string;
  date: string;
  amountMinor: number;
  type: string;
  category: string;
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
  linkedCurrency: string | null;
  linkedDestinationCurrency: string | null;
  linkedRootType: string | null;
  linkedRootId: string | null;
  linkedRootCurrency: string | null;
}

export interface FinancialReport {
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  categoryTotals: { category: string; amountMinor: number }[];
  largestExpenses: FinancialReportRow[];
  excludedCurrencies: string[];
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
        t.accountId, t.toAccountId, t.reversalOfId, a.currency AS accountCurrency, destination.currency AS destinationCurrency,
        original.accountId AS linkedOriginalAccountId, original.toAccountId AS linkedOriginalToAccountId,
        original.type AS linkedOriginalType,
        CASE WHEN original.type = 'Refund' THEN rootOriginal.categoryId ELSE original.categoryId END AS linkedCategory,
        originalAccount.currency AS linkedCurrency,
        originalDestination.currency AS linkedDestinationCurrency,
        rootOriginal.type AS linkedRootType,
        rootOriginal.id AS linkedRootId,
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
  const excluded = new Set<string>();
  const expenseRows = new Map<string, FinancialReportRow>();
  const expenseAdjustmentById = new Map<string, bigint>();
  const addExpenseAdjustment = (id: string, adjustment: bigint) => {
    expenseAdjustmentById.set(id, (expenseAdjustmentById.get(id) ?? 0n) + adjustment);
  };

  const startMs = new Date(range.startDate).getTime();
  const endMs = new Date(range.endDate).getTime();
  const periodRows = rows.filter((row) => {
    const timestamp = new Date(row.date).getTime();
    if (!Number.isFinite(timestamp)) throw new Error(`Transaction ${row.id} has an invalid date.`);
    return timestamp >= startMs && timestamp < endMs;
  });
  for (const row of periodRows) {
    if (!row.id || !row.ownerId || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) {
      throw new Error('A financial report row is invalid.');
    }
    if (!Number.isFinite(new Date(row.date).getTime())) throw new Error(`Transaction ${row.id} has an invalid date.`);

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
    // income or ordinary spending. Interest remains a normal expense.
    if (['debt_borrowing','debt_lending','debt_principal_repayment','debt_receivable_payment','debt_settlement'].includes(row.category)) continue;
    if (type === 'Income') income += amount;
    else if (type === 'Expense') {
      expense += amount;
      expenseRows.set(row.id, row);
      categoryTotals.set(row.category, (categoryTotals.get(row.category) ?? 0n) + amount);
    } else if (type === 'Refund') {
      expense -= amount;
      addExpenseAdjustment(row.reversalOfId!, -amount);
      categoryTotals.set(row.linkedCategory!, (categoryTotals.get(row.linkedCategory!) ?? 0n) - amount);
    } else if (type === 'Reversal') {
      if (row.linkedOriginalType === 'Income') income -= amount;
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
  largestExpenses.sort((a, b) => b.amountMinor - a.amountMinor || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const expenseMinor = safeNumber(expense, 'Report expense total');
  const incomeMinor = safeNumber(income, 'Report income total');
  const net = income - expense;
  return {
    currency,
    incomeMinor,
    expenseMinor,
    netMinor: safeNumber(net, 'Report net total'),
    categoryTotals: Array.from(categoryTotals).filter(([, amountMinor]) => amountMinor !== 0n).map(([category, amountMinor]) => ({
      category,
      amountMinor: safeNumber(amountMinor, 'Report category total'),
    })).sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor) || a.category.localeCompare(b.category)),
    largestExpenses: largestExpenses.slice(0, 5),
    excludedCurrencies: Array.from(excluded).sort(),
  };
}

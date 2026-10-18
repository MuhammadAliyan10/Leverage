export type AccountClass = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type CashFlowActivity = 'operating' | 'investing' | 'financing' | 'transfer';

export interface Posting {
  accountId: string;
  accountClass: AccountClass;
  debitMinor: number;
  creditMinor: number;
  isCashLike?: boolean;
  cashFlowActivity?: CashFlowActivity;
}

export interface JournalEntry {
  id: string;
  date: string;
  description: string;
  postings: Posting[];
}

export interface AccountBalance {
  accountId: string;
  accountClass: AccountClass;
  balanceMinor: number;
}

function assertSafeMinorUnits(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer in minor units.`);
  }
}

const EXCHANGE_RATE_SCALE = 100_000_000n;

/** Parses a PKR-per-currency-unit rate to an exact 8-decimal integer scale. */
export function parseExchangeRate(input: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(input.trim());
  if (!match) throw new Error('Enter an exchange rate with up to eight decimal places.');
  const rate = BigInt(match[1]) * EXCHANGE_RATE_SCALE
    + BigInt((match[2] ?? '').padEnd(8, '0') || '0');
  if (rate <= 0n) throw new Error('Exchange rate must be greater than zero.');
  return rate;
}

/** Converts a two-decimal foreign amount to PKR minor units using half-up rounding. */
export function convertForeignMinorToPkr(
  sourceAmountMinor: number,
  pkrPerCurrencyUnitScaled: bigint,
): number {
  if (!Number.isSafeInteger(sourceAmountMinor) || sourceAmountMinor < 0) {
    throw new Error('Foreign amount must be a non-negative safe integer in minor units.');
  }
  if (pkrPerCurrencyUnitScaled <= 0n) throw new Error('Exchange rate must be greater than zero.');
  const numerator = BigInt(sourceAmountMinor) * pkrPerCurrencyUnitScaled;
  const rounded = (numerator + EXCHANGE_RATE_SCALE / 2n) / EXCHANGE_RATE_SCALE;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Converted PKR amount is outside the supported range.');
  return Number(rounded);
}

/** Converts a plain decimal amount to integer minor units without floating-point math. */
export function parseMinorUnits(input: string, fractionDigits = 2): number {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 6) {
    throw new Error('fractionDigits must be an integer between 0 and 6.');
  }

  const value = input.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('Enter a positive amount using digits and an optional decimal point.');

  const fraction = match[2] ?? '';
  if (fraction.length > fractionDigits) {
    throw new Error(`Enter no more than ${fractionDigits} digits after the decimal point.`);
  }

  const scale = 10n ** BigInt(fractionDigits);
  const whole = BigInt(match[1]);
  const fractional = fractionDigits === 0
    ? 0n
    : BigInt(fraction.padEnd(fractionDigits, '0') || '0');
  const minorUnits = whole * scale + fractional;

  if (minorUnits <= 0n || minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount must be greater than zero and within the supported range.');
  }
  return Number(minorUnits);
}

/** Formats integer minor units for display. Keep calculations in minor units. */
export function formatMinorUnits(
  amountMinor: number,
  currency = 'PKR',
  locale = 'en-PK',
  fractionDigits = 2,
): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('Amount is outside the supported range.');
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amountMinor / 10 ** fractionDigits);
}

/** Enforces the balancing and line rules before a journal entry can be saved. */
export function assertBalancedEntry(entry: JournalEntry): void {
  if (!entry.id.trim()) throw new Error('Journal entry ID is required.');
  if (!entry.description.trim()) throw new Error('Journal entry description is required.');
  if (Number.isNaN(new Date(entry.date).getTime())) throw new Error('Journal entry date is invalid.');
  if (entry.postings.length < 2) throw new Error('A journal entry must have at least two postings.');

  let debitTotal = 0n;
  let creditTotal = 0n;

  for (const posting of entry.postings) {
    if (!posting.accountId.trim()) throw new Error('Every posting must reference an account.');
    assertSafeMinorUnits(posting.debitMinor, 'Debit');
    assertSafeMinorUnits(posting.creditMinor, 'Credit');
    if ((posting.debitMinor > 0) === (posting.creditMinor > 0)) {
      throw new Error('Each posting must have exactly one positive debit or credit.');
    }
    debitTotal += BigInt(posting.debitMinor);
    creditTotal += BigInt(posting.creditMinor);
  }

  if (debitTotal !== creditTotal) throw new Error('Journal entry debits must equal credits.');
}

/** Returns normal-balance account balances: assets/expenses debit-normal; others credit-normal. */
export function calculateAccountBalances(postings: Posting[]): AccountBalance[] {
  const balances = new Map<string, { accountClass: AccountClass; net: bigint }>();

  for (const posting of postings) {
    if (!posting.accountId.trim()) throw new Error('Every posting must reference an account.');
    assertSafeMinorUnits(posting.debitMinor, 'Debit');
    assertSafeMinorUnits(posting.creditMinor, 'Credit');
    if ((posting.debitMinor > 0) === (posting.creditMinor > 0)) {
      throw new Error('Each posting must have exactly one positive debit or credit.');
    }
    const current = balances.get(posting.accountId);
    if (current && current.accountClass !== posting.accountClass) {
      throw new Error(`Account ${posting.accountId} has inconsistent classifications.`);
    }
    const debitNormal = posting.accountClass === 'asset' || posting.accountClass === 'expense';
    const change = BigInt(posting.debitMinor) - BigInt(posting.creditMinor);
    balances.set(posting.accountId, {
      accountClass: posting.accountClass,
      net: (current?.net ?? 0n) + (debitNormal ? change : -change),
    });
  }

  return Array.from(balances, ([accountId, value]) => {
    if (value.net > BigInt(Number.MAX_SAFE_INTEGER) || value.net < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`Account ${accountId} balance is outside the supported range.`);
    }
    return { accountId, accountClass: value.accountClass, balanceMinor: Number(value.net) };
  });
}

export interface IncomeExpenseSummary {
  incomeMinor: number;
  expenseMinor: number;
  surplusMinor: number;
}

export interface BalanceSheetSummary {
  assetsMinor: number;
  liabilitiesMinor: number;
  equityMinor: number;
  netWorthMinor: number;
}

export interface CashFlowSummary {
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
  netCashFlowMinor: number;
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return Number(value);
}

function parseDateBoundary(value: string | undefined, label: string, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid.`);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date;
}

/** Includes balanced entries up to and including the supplied instant. */
function postingsFor(entries: JournalEntry[], endDate?: string): Posting[] {
  const cutoff = endDate ? new Date(endDate) : undefined;
  if (cutoff && Number.isNaN(cutoff.getTime())) throw new Error('Report end date is invalid.');

  return entries.flatMap((entry) => {
    assertBalancedEntry(entry);
    const entryDate = new Date(entry.date);
    if (cutoff && entryDate > cutoff) return [];
    return entry.postings;
  });
}

export function calculateIncomeExpense(
  entries: JournalEntry[],
  period?: { startDate?: string; endDate?: string },
): IncomeExpenseSummary {
  const start = parseDateBoundary(period?.startDate, 'Report start date', false);
  const end = parseDateBoundary(period?.endDate, 'Report end date', true);
  if (start && end && start > end) throw new Error('Report start date must not follow its end date.');

  let income = 0n;
  let expense = 0n;

  for (const entry of entries) {
    assertBalancedEntry(entry);
    const date = new Date(entry.date);
    if ((start && date < start) || (end && date > end)) continue;
    for (const posting of entry.postings) {
      if (!posting.accountId.trim()) throw new Error('Every posting must reference an account.');
      assertSafeMinorUnits(posting.debitMinor, 'Debit');
      assertSafeMinorUnits(posting.creditMinor, 'Credit');
      if ((posting.debitMinor > 0) === (posting.creditMinor > 0)) {
        throw new Error('Each posting must have exactly one positive debit or credit.');
      }
      if (posting.accountClass === 'income') {
        income += BigInt(posting.creditMinor) - BigInt(posting.debitMinor);
      } else if (posting.accountClass === 'expense') {
        expense += BigInt(posting.debitMinor) - BigInt(posting.creditMinor);
      }
    }
  }

  const surplus = income - expense;
  return {
    incomeMinor: toSafeNumber(income, 'Income total'),
    expenseMinor: toSafeNumber(expense, 'Expense total'),
    surplusMinor: toSafeNumber(surplus, 'Surplus or deficit'),
  };
}

/** Builds a balance sheet from every balanced entry posted on or before the as-of date. */
export function calculateBalanceSheet(entries: JournalEntry[], asOfDate: string): BalanceSheetSummary {
  const asOf = parseDateBoundary(asOfDate, 'Balance sheet as-of date', true)!;
  const postings = postingsFor(entries, asOf.toISOString());
  const balances = calculateAccountBalances(postings);
  const assets = balances
    .filter((account) => account.accountClass === 'asset')
    .reduce((sum, account) => sum + BigInt(account.balanceMinor), 0n);
  const liabilities = balances
    .filter((account) => account.accountClass === 'liability')
    .reduce((sum, account) => sum + BigInt(account.balanceMinor), 0n);
  const equityAccounts = balances
    .filter((account) => account.accountClass === 'equity')
    .reduce((sum, account) => sum + BigInt(account.balanceMinor), 0n);
  const earnings = calculateIncomeExpense(entries, { endDate: asOf.toISOString() });
  const equity = equityAccounts + BigInt(earnings.surplusMinor);
  const netWorth = assets - liabilities;

  if (netWorth !== equity) {
    throw new Error('Ledger is out of balance. Check opening balances and journal postings.');
  }

  return {
    assetsMinor: toSafeNumber(assets, 'Assets total'),
    liabilitiesMinor: toSafeNumber(liabilities, 'Liabilities total'),
    equityMinor: toSafeNumber(equity, 'Equity total'),
    netWorthMinor: toSafeNumber(netWorth, 'Net worth'),
  };
}

/** Calculates changes in cash-like accounts and excludes own-account transfers. */
export function calculateCashFlow(
  entries: JournalEntry[],
  period?: { startDate?: string; endDate?: string },
): CashFlowSummary {
  const activityTotals: Record<'operating' | 'investing' | 'financing', bigint> = {
    operating: 0n,
    investing: 0n,
    financing: 0n,
  };

  const start = parseDateBoundary(period?.startDate, 'Report start date', false);
  const end = parseDateBoundary(period?.endDate, 'Report end date', true);
  if (start && end && start > end) throw new Error('Report start date must not follow its end date.');

  for (const entry of entries) {
    assertBalancedEntry(entry);
    const date = new Date(entry.date);
    if ((start && date < start) || (end && date > end)) continue;
    for (const posting of entry.postings) {
      assertSafeMinorUnits(posting.debitMinor, 'Debit');
      assertSafeMinorUnits(posting.creditMinor, 'Credit');
      if (!posting.isCashLike || posting.cashFlowActivity === 'transfer') continue;
      if (!posting.cashFlowActivity) {
        throw new Error('Cash-like postings need a cash-flow classification.');
      }
      activityTotals[posting.cashFlowActivity] += BigInt(posting.debitMinor) - BigInt(posting.creditMinor);
    }
  }

  const net = activityTotals.operating + activityTotals.investing + activityTotals.financing;
  return {
    operatingMinor: toSafeNumber(activityTotals.operating, 'Operating cash flow'),
    investingMinor: toSafeNumber(activityTotals.investing, 'Investing cash flow'),
    financingMinor: toSafeNumber(activityTotals.financing, 'Financing cash flow'),
    netCashFlowMinor: toSafeNumber(net, 'Net cash flow'),
  };
}

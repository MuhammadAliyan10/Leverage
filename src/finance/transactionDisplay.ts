import { CLASSIFICATIONS, isCurrencyCode, resolveClassification, type CurrencyCode, type TransactionType } from './domain.ts';

export interface TransactionActivityInput {
  id: string;
  type: TransactionType;
  categoryId: string;
  amountMinor: number;
  accountCurrency: string | null;
  destinationCurrency: string | null;
  sourceName: string | null;
  note: string;
  date: string;
  linkedOriginalType: TransactionType | null;
  linkedCategoryId: string | null;
  accountName?: string | null;
  destinationName?: string | null;
}

export interface TransactionActivity {
  id: string;
  type: TransactionType;
  title: string;
  categoryLabel: string;
  amountMinor: number;
  currency: CurrencyCode | null;
  direction: 'in' | 'out' | 'transfer';
  date: string;
  accountContext: string | null;
  statusLabel: string | null;
}

export function groupTransactionsByDate<T extends { date: string }>(items: readonly T[], now = new Date()): { title: string; data: T[] }[] {
  const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const todayKey = dayKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const date = new Date(item.date);
    const key = dayKey(date);
    const rows = groups.get(key) ?? [];
    rows.push(item);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, data]) => ({
    title: key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : new Date(data[0].date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    data,
  }));
}

function labelFor(categoryId: string | null, fallback: string): string {
  if (!categoryId) return fallback;
  const classification = resolveClassification(categoryId);
  if (classification) return CLASSIFICATIONS[classification].label;
  const linkedLabels: Readonly<Record<string, string>> = {
    debt_borrowing: 'Borrowed principal received', debt_lending: 'Money lent',
    debt_principal_repayment: 'Debt principal repayment', debt_receivable_payment: 'Principal repaid to you',
    debt_interest: 'Debt interest', debt_settlement: 'Debt settlement',
    asset_purchase: 'Asset purchase', asset_sale_proceeds: 'Asset sale proceeds',
    investment_purchase: 'Investment purchase', investment_sale_proceeds: 'Investment sale proceeds',
    investment_dividend: 'Investment dividend', scheduled_transfer: 'Scheduled account transfer',
  };
  return linkedLabels[categoryId] ?? fallback;
}

/** Pure, shared presentation projection; the source transaction amounts stay integer minor units. */
export function projectTransactionActivity(input: TransactionActivityInput): TransactionActivity {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !Number.isFinite(new Date(input.date).getTime())) {
    throw new Error('Transaction activity details are invalid.');
  }
  let direction: TransactionActivity['direction'];
  let categoryLabel: string;
  switch (input.type) {
    case 'Income':
      direction = 'in';
      categoryLabel = labelFor(input.categoryId, 'Income');
      break;
    case 'Expense':
      direction = 'out';
      categoryLabel = labelFor(input.categoryId, 'Expense');
      break;
    case 'Transfer':
      direction = 'transfer';
      categoryLabel = 'Account transfer';
      break;
    case 'Refund':
      if (input.linkedOriginalType !== 'Expense') throw new Error('A refund must be linked to an expense.');
      direction = 'in';
      categoryLabel = `Refund · ${labelFor(input.linkedCategoryId, 'expense')}`;
      break;
    case 'Reversal':
      if (!input.linkedOriginalType) throw new Error('A correction must be linked to its original transaction.');
      direction = input.linkedOriginalType === 'Transfer' ? 'transfer'
        : input.linkedOriginalType === 'Expense' ? 'in' : 'out';
      categoryLabel = input.linkedOriginalType === 'Refund'
        ? `Refund correction · ${labelFor(input.linkedCategoryId, 'expense')}`
        : `${input.linkedOriginalType} correction · ${labelFor(input.linkedCategoryId, input.linkedOriginalType.toLocaleLowerCase('en-US'))}`;
      break;
  }
  const transactionCurrency = input.type === 'Transfer' || (input.type === 'Reversal' && input.linkedOriginalType === 'Transfer')
    ? input.accountCurrency && input.accountCurrency === input.destinationCurrency ? input.accountCurrency : null
    : input.accountCurrency;
  const currency = transactionCurrency && isCurrencyCode(transactionCurrency) ? transactionCurrency : null;
  const rawTitle = input.sourceName?.trim() || input.note.trim() || categoryLabel;
  const title = input.type === 'Refund' ? categoryLabel : input.type === 'Reversal' ? categoryLabel : rawTitle;
  const accountContext = input.type === 'Transfer' || (input.type === 'Reversal' && input.linkedOriginalType === 'Transfer')
    ? `${input.accountName?.trim() || 'Account unavailable'} → ${input.destinationName?.trim() || 'Account unavailable'}`
    : input.accountName?.trim() || null;
  const statusLabel = input.type === 'Refund' ? 'Refund' : input.type === 'Reversal' ? 'Correction reversal' : null;
  if (!input.id.trim()) throw new Error('Transaction activity needs an identity.');
  return { id: input.id, type: input.type, title, categoryLabel, amountMinor: input.amountMinor, currency, direction, date: input.date, accountContext, statusLabel };
}

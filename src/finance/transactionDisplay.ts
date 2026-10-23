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
}

function labelFor(categoryId: string | null, fallback: string): string {
  if (!categoryId) return fallback;
  const classification = resolveClassification(categoryId);
  return classification ? CLASSIFICATIONS[classification].label : fallback;
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
  const title = input.sourceName?.trim() || input.note.trim() || categoryLabel;
  if (!input.id.trim()) throw new Error('Transaction activity needs an identity.');
  return { id: input.id, type: input.type, title, categoryLabel, amountMinor: input.amountMinor, currency, direction, date: input.date };
}

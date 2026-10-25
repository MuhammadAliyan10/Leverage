import { convertForeignMinorToPkr, parseExchangeRate } from './ledger.ts';

export const ACCOUNT_TYPES = [
  { id: 'cash', label: 'Cash' },
  { id: 'bank', label: 'Bank' },
  { id: 'savings', label: 'Savings' },
  { id: 'wallet', label: 'Mobile wallet' },
  { id: 'investment', label: 'Investment' },
  { id: 'other', label: 'Other' },
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number]['id'];

export const TRANSACTION_TYPES = ['Income', 'Expense', 'Transfer', 'Refund', 'Reversal'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
const TRANSACTION_TYPE_SET: ReadonlySet<string> = new Set(TRANSACTION_TYPES);

export function isTransactionType(value: string): value is TransactionType {
  return TRANSACTION_TYPE_SET.has(value);
}

export const TAX_STATUSES = ['unreviewed', 'taxable', 'non_taxable'] as const;
export type TaxStatus = (typeof TAX_STATUSES)[number];
const TAX_STATUS_SET: ReadonlySet<string> = new Set(TAX_STATUSES);

export const PAYMENT_METHODS = ['Bank transfer', 'Digital payment', 'Cash', 'Cheque', 'Card', 'Other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
const PAYMENT_METHOD_SET: ReadonlySet<string> = new Set(PAYMENT_METHODS);

export function isTaxStatus(value: string): value is TaxStatus {
  return TAX_STATUS_SET.has(value);
}

export function isPaymentMethod(value: string): value is PaymentMethod {
  return PAYMENT_METHOD_SET.has(value);
}

/** Currency support is intentionally explicit. Add a code only with its minor-unit definition. */
export const CURRENCIES = {
  PKR: { label: 'Pakistani Rupee', minorUnitDigits: 2 },
  USD: { label: 'US Dollar', minorUnitDigits: 2 },
  GBP: { label: 'Pound Sterling', minorUnitDigits: 2 },
  EUR: { label: 'Euro', minorUnitDigits: 2 },
  AED: { label: 'UAE Dirham', minorUnitDigits: 2 },
  SAR: { label: 'Saudi Riyal', minorUnitDigits: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CLASSIFICATIONS = {
  salary: { label: 'Employment income', type: 'Income' },
  freelance: { label: 'Freelance income', type: 'Income' },
  business_revenue: { label: 'Business receipts', type: 'Income' },
  family_gift: { label: 'Family gift / support', type: 'Income' },
  foreign_remittance: { label: 'Family remittance', type: 'Income' },
  investment_return: { label: 'Bank profit / deposit income', type: 'Income' },
  rental_income: { label: 'Rent received', type: 'Income' },
  other_income: { label: 'Other income', type: 'Income' },
  food: { label: 'Food', type: 'Expense' },
  transport: { label: 'Transport', type: 'Expense' },
  bills: { label: 'Bills', type: 'Expense' },
  shopping: { label: 'Shopping', type: 'Expense' },
  health: { label: 'Health', type: 'Expense' },
  bank_fee: { label: 'Banking expense', type: 'Expense' },
  housing: { label: 'Housing / hostel', type: 'Expense' },
  other_expense: { label: 'Other expense', type: 'Expense' },
  expense_refund: { label: 'Expense refund', type: 'Refund' },
  // These classifications are reserved for linked debt, asset, and investment
  // ledger operations. They are intentionally excluded from the manual picker.
  debt_borrowing: { label: 'Borrowed principal received', type: 'Income' },
  debt_lending: { label: 'Money lent', type: 'Expense' },
  debt_principal_repayment: { label: 'Debt principal repayment', type: 'Expense' },
  debt_receivable_payment: { label: 'Principal repaid to you', type: 'Income' },
  debt_interest: { label: 'Debt interest', type: 'Expense' },
  debt_settlement: { label: 'Debt settlement', type: 'Expense' },
  asset_purchase: { label: 'Asset purchase', type: 'Expense' },
  asset_sale_proceeds: { label: 'Asset sale proceeds', type: 'Income' },
  investment_purchase: { label: 'Investment purchase', type: 'Expense' },
  investment_sale_proceeds: { label: 'Investment sale proceeds', type: 'Income' },
  investment_dividend: { label: 'Investment dividend', type: 'Income' },
} as const;

export type ClassificationId = keyof typeof CLASSIFICATIONS;
export const INCOME_CLASSIFICATION_IDS = [
  'salary', 'freelance', 'business_revenue', 'family_gift', 'foreign_remittance',
  'investment_return', 'rental_income', 'other_income',
] as const satisfies readonly ClassificationId[];
export const EXPENSE_CLASSIFICATION_IDS = [
  'food', 'transport', 'bills', 'shopping', 'health', 'bank_fee', 'housing', 'other_expense',
] as const satisfies readonly ClassificationId[];

const LEGACY_CLASSIFICATION_ALIASES: Readonly<Record<string, ClassificationId>> = {
  salary: 'salary',
  'employment income': 'salary',
  freelance: 'freelance',
  'freelance income': 'freelance',
  business_revenue: 'business_revenue',
  'business receipts': 'business_revenue',
  family_gift: 'family_gift',
  'family gift': 'family_gift',
  'family gift / support': 'family_gift',
  'family gift / family support': 'family_gift',
  foreign_remittance: 'foreign_remittance',
  'family remittance': 'foreign_remittance',
  'foreign family remittance': 'foreign_remittance',
  'foreign family gift/remittance': 'foreign_remittance',
  investment_return: 'investment_return',
  'bank profit / deposit income': 'investment_return',
  'investment/deposit income': 'investment_return',
  rental_income: 'rental_income',
  'rent received': 'rental_income',
  other_income: 'other_income',
  food: 'food',
  groceries: 'food',
  transport: 'transport',
  bills: 'bills',
  utilities: 'bills',
  shopping: 'shopping',
  health: 'health',
  bank_fee: 'bank_fee',
  'banking expense': 'bank_fee',
  housing: 'housing',
  'housing / hostel': 'housing',
  'rent & utilities': 'housing',
  other_expense: 'other_expense',
  'other expense': 'other_expense',
  expense_refund: 'expense_refund',
  'expense refund': 'expense_refund',
  debt_borrowing: 'debt_borrowing',
  debt_lending: 'debt_lending',
  debt_principal_repayment: 'debt_principal_repayment',
  debt_receivable_payment: 'debt_receivable_payment',
  debt_interest: 'debt_interest',
  debt_settlement: 'debt_settlement',
  asset_purchase: 'asset_purchase',
  asset_sale_proceeds: 'asset_sale_proceeds',
  investment_purchase: 'investment_purchase',
  investment_sale_proceeds: 'investment_sale_proceeds',
  investment_dividend: 'investment_dividend',
};

export function resolveClassification(value: string): ClassificationId | null {
  return LEGACY_CLASSIFICATION_ALIASES[value.trim().toLocaleLowerCase('en-US')] ?? null;
}

/** Validates stored classification metadata without silently reclassifying historical records. */
export function validateStoredClassification(
  transactionType: string,
  value: string | null,
): ClassificationId | null {
  if (!isTransactionType(transactionType)) throw new Error('A saved transaction has an unsupported type.');
  if (value === null) return null;
  const classificationId = resolveClassification(value);
  if (!classificationId) throw new Error('A saved transaction has an unsupported classification.');
  // Settlement entries are generated for either direction: paying off a debt
  // is an expense, while settling a receivable is income.
  if (CLASSIFICATIONS[classificationId].type !== transactionType && !(classificationId === 'debt_settlement' && (transactionType === 'Income' || transactionType === 'Expense'))) {
    throw new Error('A saved transaction classification does not match its transaction type.');
  }
  return classificationId;
}

export interface AccountDraft {
  id?: string;
  ownerId: string;
  name: string;
  type: string;
  balanceMinor: number;
  currency?: string;
}

export interface NormalizedAccountDraft {
  id?: string;
  ownerId: string;
  name: string;
  type: AccountType;
  balanceMinor: number;
  currency: CurrencyCode;
}

const ACCOUNT_TYPE_ALIASES: Readonly<Record<string, AccountType>> = {
  cash: 'cash',
  bank: 'bank',
  checking: 'bank',
  current: 'bank',
  savings: 'savings',
  'mobile wallet': 'wallet',
  wallet: 'wallet',
  investment: 'investment',
  other: 'other',
};

export function normalizeAccountType(value: string): AccountType | null {
  return ACCOUNT_TYPE_ALIASES[value.trim().toLocaleLowerCase('en-US')] ?? null;
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

export function normalizeAccountDraft(draft: AccountDraft): NormalizedAccountDraft {
  const type = normalizeAccountType(draft.type);
  const currencyValue = draft.currency ?? 'PKR';
  if (!draft.ownerId.trim()) throw new Error('An account owner is required.');
  if (draft.id !== undefined && !draft.id.trim()) throw new Error('Account ID cannot be empty.');
  if (draft.name.trim().length < 2 || draft.name.trim().length > 80) {
    throw new Error('Account name must be between 2 and 80 characters.');
  }
  if (!type) throw new Error('Choose a supported account type.');
  if (!Number.isSafeInteger(draft.balanceMinor) || draft.balanceMinor < 0) {
    throw new Error('Opening balance must be a non-negative safe integer in minor units.');
  }
  if (!isCurrencyCode(currencyValue)) throw new Error('Choose a supported ISO currency code.');
  return {
    ...draft,
    name: draft.name.trim(),
    type,
    currency: currencyValue,
  };
}

export interface TransactionDraft {
  id?: string;
  ownerId: string;
  amountMinor: number;
  type: TransactionType;
  classificationId?: string;
  accountId?: string;
  toAccountId?: string;
  date?: Date | string;
  note?: string;
  sourceName?: string;
  paymentMethod?: string;
  sourceAmountMinor?: number;
  sourceCurrency?: string;
  exchangeRate?: string;
  referenceNumber?: string;
  taxStatus?: string;
  taxYear?: number;
}

export interface OwnedAccount {
  id: string;
  ownerId: string;
  currency: string;
  type: string;
}

export interface NormalizedTransactionDraft {
  id: string;
  ownerId: string;
  amountMinor: number;
  type: TransactionType;
  classificationId: ClassificationId | null;
  categoryLabel: string;
  accountId: string;
  toAccountId: string | null;
  date: string;
  note: string;
  sourceName: string | null;
  paymentMethod: PaymentMethod | null;
  sourceAmountMinor: number | null;
  sourceCurrency: CurrencyCode | null;
  exchangeRate: string | null;
  referenceNumber: string | null;
  taxStatus: TaxStatus;
  taxYear: number | null;
}

function normalizeDate(value: Date | string | undefined): string {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Transaction date is invalid.');
  return date.toISOString();
}

export function pakistanTaxYear(dateIso: string | Date): number {
  const date = dateIso instanceof Date ? dateIso : new Date(dateIso);
  if (Number.isNaN(date.getTime())) throw new Error('Tax-year date is invalid.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: 'numeric',
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  return month >= 7 ? year + 1 : year;
}

export function normalizeTransactionDraft(
  draft: TransactionDraft,
  sourceAccount: OwnedAccount,
  destinationAccount?: OwnedAccount,
): NormalizedTransactionDraft {
  if (!draft.ownerId.trim()) throw new Error('A transaction owner is required.');
  if (draft.id !== undefined && !draft.id.trim()) throw new Error('Transaction ID cannot be empty.');
  if (!Number.isSafeInteger(draft.amountMinor) || draft.amountMinor <= 0) {
    throw new Error('Transaction amount must be a positive safe integer in minor units.');
  }
  if (!draft.accountId || sourceAccount.id !== draft.accountId || sourceAccount.ownerId !== draft.ownerId) {
    throw new Error('The selected account is not available to this profile.');
  }
  if (!isCurrencyCode(sourceAccount.currency)) throw new Error('The selected account has an unsupported currency.');

  let classificationId: ClassificationId | null = null;
  let categoryLabel = 'Internal transfer';
  let toAccountId: string | null = null;
  if (draft.type === 'Transfer') {
    if (draft.classificationId) throw new Error('A classification is not valid for an internal transfer.');
    if (!draft.toAccountId || draft.toAccountId === draft.accountId) {
      throw new Error('Choose two different accounts for a transfer.');
    }
    if (!destinationAccount || destinationAccount.id !== draft.toAccountId || destinationAccount.ownerId !== draft.ownerId) {
      throw new Error('The destination account is not available to this profile.');
    }
    if (!isCurrencyCode(destinationAccount.currency)) throw new Error('The destination account has an unsupported currency.');
    if (sourceAccount.currency !== destinationAccount.currency) {
      throw new Error('Transfers between accounts with different currencies are not supported yet.');
    }
    toAccountId = destinationAccount.id;
  } else {
    if (draft.toAccountId) throw new Error('A destination account is only valid for an internal transfer.');
    if (draft.type !== 'Income' && draft.type !== 'Expense' && draft.type !== 'Refund') throw new Error('Transaction type is invalid.');
    if (!draft.classificationId) throw new Error('Choose a transaction classification.');
    classificationId = resolveClassification(draft.classificationId);
    if (!classificationId) throw new Error('Choose a supported transaction classification.');
    const classification = CLASSIFICATIONS[classificationId];
    if (classification.type !== draft.type) throw new Error('That classification does not match this transaction type.');
    categoryLabel = classification.label;
  }

  const date = normalizeDate(draft.date);
  const taxStatusValue = draft.taxStatus ?? 'unreviewed';
  if (!isTaxStatus(taxStatusValue)) throw new Error('Tax status is invalid.');
  const taxStatus = taxStatusValue;
  const isIncome = draft.type === 'Income';
  if (!isIncome && (draft.taxStatus !== undefined || draft.taxYear !== undefined)) {
    throw new Error('Tax classification applies to income receipts only.');
  }
  const taxYear = isIncome ? draft.taxYear ?? pakistanTaxYear(date) : null;
  if (taxYear !== null) {
    if (!Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 9999) {
      throw new Error('Tax year is invalid.');
    }
    if (taxYear !== pakistanTaxYear(date)) throw new Error('Tax year does not match the transaction date.');
  }

  const sourceName = draft.sourceName?.trim() || null;
  if (!isIncome && sourceName) throw new Error('Payer or sender details are only valid for income receipts.');
  if (classificationId === 'family_gift' && !sourceName) throw new Error('Record who gave you this family gift.');
  if (classificationId === 'foreign_remittance' && !sourceName) throw new Error('Record who sent you this remittance.');

  const paymentMethodValue = draft.paymentMethod?.trim();
  if (paymentMethodValue && !isPaymentMethod(paymentMethodValue)) {
    throw new Error('Payment method is invalid.');
  }

  let sourceAmountMinor: number | null = null;
  let sourceCurrency: CurrencyCode | null = null;
  let exchangeRate: string | null = null;
  let referenceNumber: string | null = null;
  if (classificationId === 'foreign_remittance') {
    if (sourceAccount.currency !== 'PKR') throw new Error('Converted remittances must be recorded in a PKR account.');
    const originalAmountMinor = draft.sourceAmountMinor;
    if (typeof originalAmountMinor !== 'number' || !Number.isSafeInteger(originalAmountMinor) || originalAmountMinor <= 0) {
      throw new Error('A remittance requires a positive original amount in minor units.');
    }
    if (!draft.sourceCurrency || !isCurrencyCode(draft.sourceCurrency) || draft.sourceCurrency === 'PKR') {
      throw new Error('Choose a supported foreign currency for the remittance.');
    }
    if (!draft.exchangeRate) throw new Error('A remittance requires the provider exchange rate.');
    const rate = parseExchangeRate(draft.exchangeRate);
    if (convertForeignMinorToPkr(originalAmountMinor, rate) !== draft.amountMinor) {
      throw new Error('Converted PKR amount does not match the original amount and provider rate.');
    }
    const reference = draft.referenceNumber?.trim();
    if (!reference || reference.length > 120) throw new Error('A valid remittance reference number is required.');
    sourceAmountMinor = originalAmountMinor;
    sourceCurrency = draft.sourceCurrency;
    exchangeRate = draft.exchangeRate.trim();
    referenceNumber = reference;
  } else if (
    draft.sourceAmountMinor !== undefined || draft.sourceCurrency !== undefined ||
    draft.exchangeRate !== undefined || draft.referenceNumber !== undefined
  ) {
    throw new Error('Original-currency details are only supported for a foreign remittance.');
  }

  if (draft.note !== undefined && draft.note.length > 2000) throw new Error('Note must be 2,000 characters or fewer.');
  if (sourceName && sourceName.length > 160) throw new Error('Payer or sender name must be 160 characters or fewer.');

  return {
    ...draft,
    id: draft.id ?? '',
    amountMinor: draft.amountMinor,
    type: draft.type,
    classificationId,
    categoryLabel,
    accountId: sourceAccount.id,
    toAccountId,
    date,
    note: draft.note?.trim() ?? '',
    sourceName,
    paymentMethod: paymentMethodValue && isPaymentMethod(paymentMethodValue) ? paymentMethodValue : null,
    sourceAmountMinor,
    sourceCurrency,
    exchangeRate,
    referenceNumber,
    taxStatus,
    taxYear,
  };
}

export interface TransactionStore {
  findAccount(id: string, ownerId: string): Promise<OwnedAccount | null>;
  findTransaction(id: string, ownerId: string): Promise<NormalizedTransactionDraft | null>;
  insertTransaction(transaction: NormalizedTransactionDraft): Promise<void>;
}

/** Validate ownership and write through a transaction-scoped store. The id is the idempotency key. */
export async function createValidatedTransaction(
  draft: TransactionDraft,
  transactionId: string,
  store: TransactionStore,
): Promise<NormalizedTransactionDraft> {
  if (!transactionId.trim()) throw new Error('Transaction ID cannot be empty.');
  const sourceAccount = draft.accountId ? await store.findAccount(draft.accountId, draft.ownerId) : null;
  if (!sourceAccount) throw new Error('The selected account is not available to this profile.');
  const destinationAccount = draft.toAccountId
    ? await store.findAccount(draft.toAccountId, draft.ownerId)
    : undefined;
  const normalized = normalizeTransactionDraft({ ...draft, id: transactionId }, sourceAccount, destinationAccount ?? undefined);
  const existing = await store.findTransaction(transactionId, draft.ownerId);
  if (existing) {
    if (!sameTransaction(existing, normalized)) throw new Error('This transaction ID was already used for different financial details.');
    return existing;
  }
  await store.insertTransaction(normalized);
  return normalized;
}

function sameTransaction(left: NormalizedTransactionDraft, right: NormalizedTransactionDraft): boolean {
  const fields: readonly (keyof NormalizedTransactionDraft)[] = [
    'ownerId', 'amountMinor', 'type', 'classificationId', 'accountId', 'toAccountId', 'date', 'note',
    'sourceName', 'paymentMethod', 'sourceAmountMinor', 'sourceCurrency', 'exchangeRate', 'referenceNumber',
    'taxStatus', 'taxYear',
  ];
  return fields.every((field) => left[field] === right[field]);
}

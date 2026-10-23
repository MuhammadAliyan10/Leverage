import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBalanceSheet,
  calculateCashFlow,
  calculateIncomeExpense,
  convertForeignMinorToPkr,
  formatMinorUnitsForInput,
  parseExchangeRate,
  parseMinorUnits,
} from '../../src/finance/ledger.ts';
import {
  createValidatedTransaction,
  normalizeAccountDraft,
  normalizeTransactionDraft,
  resolveClassification,
  validateStoredClassification,
} from '../../src/finance/domain.ts';
import { calculateAccountBalances } from '../../src/finance/balances.ts';
import { transactionsInCurrency } from '../../src/finance/reporting.ts';

const pkrAccount = { id: 'bank-main', ownerId: 'user-1', currency: 'PKR', type: 'bank' };

test('minor-unit parsing rejects precision loss, signs, and unsafe values', () => {
  assert.equal(parseMinorUnits('20,000'.replace(',', '')), 2_000_000);
  assert.equal(parseMinorUnits('0.05'), 5);
  assert.throws(() => parseMinorUnits('1.001'), /digits after the decimal point/);
  assert.throws(() => parseMinorUnits('-1'), /positive amount/);
  assert.throws(() => parseMinorUnits('90071992547409.92'), /supported range/);
});

test('editable amount formatting avoids floating-point round trips', () => {
  assert.equal(formatMinorUnitsForInput(2_000_000), '20000');
  assert.equal(formatMinorUnitsForInput(5), '0.05');
  assert.equal(formatMinorUnitsForInput(1_234), '12.34');
  assert.equal(formatMinorUnitsForInput(12_340), '123.4');
  assert.equal(formatMinorUnitsForInput(123, 0), '123');
  assert.equal(formatMinorUnitsForInput(-5), '-0.05');
  assert.throws(() => formatMinorUnitsForInput(Number.MAX_SAFE_INTEGER + 1), /supported range/);
  assert.throws(() => formatMinorUnitsForInput(10, 7), /fractionDigits/);
});

test('foreign remittance conversion uses exact scaled rate and half-up rounding', () => {
  assert.equal(convertForeignMinorToPkr(10_000, parseExchangeRate('280.125')), 2_801_250);
  assert.equal(convertForeignMinorToPkr(1, parseExchangeRate('1.5')), 2);
  assert.throws(() => parseExchangeRate('0'), /greater than zero/);
  assert.throws(() => parseExchangeRate('1.123456789'), /eight decimal places/);
});

test('account validation restricts new account types and ISO currency metadata', () => {
  const account = normalizeAccountDraft({
    ownerId: 'user-1', name: 'Primary bank', type: 'Checking', balanceMinor: 0,
  });
  assert.equal(account.type, 'bank');
  assert.equal(account.currency, 'PKR');
  assert.throws(() => normalizeAccountDraft({ ownerId: '', name: 'Bank', type: 'Bank', balanceMinor: 0 }), /owner/);
  assert.throws(() => normalizeAccountDraft({ ownerId: 'user-1', name: 'Bank', type: 'Cash', balanceMinor: -1 }), /non-negative/);
  assert.throws(() => normalizeAccountDraft({ ownerId: 'user-1', name: 'Bank', type: 'Crypto', balanceMinor: 0 }), /supported account type/);
  assert.throws(() => normalizeAccountDraft({ ownerId: 'user-1', name: 'Bank', type: 'Bank', balanceMinor: 0, currency: 'XYZ' }), /currency/);
});

test('gift legacy display name resolves to a canonical classification and requires its donor', () => {
  assert.equal(resolveClassification('Family gift / support'), 'family_gift');
  const gift = {
    id: 'gift-1', ownerId: 'user-1', amountMinor: 2_000_000, type: 'Income',
    classificationId: 'family_gift', accountId: pkrAccount.id, sourceName: 'Mother',
    date: '2026-06-15T12:00:00.000Z', taxStatus: 'unreviewed', taxYear: 2026,
  };
  const normalized = normalizeTransactionDraft(gift, pkrAccount);
  assert.equal(normalized.classificationId, 'family_gift');
  assert.equal(normalized.categoryLabel, 'Family gift / support');
  assert.equal(normalized.taxStatus, 'unreviewed');
  assert.throws(() => normalizeTransactionDraft({ ...gift, sourceName: '' }, pkrAccount), /who gave/);
  assert.throws(() => normalizeTransactionDraft({ ...gift, type: 'Expense' }, pkrAccount), /does not match/);
  const salary = normalizeTransactionDraft({ ...gift, id: 'salary-1', classificationId: 'salary', sourceName: 'Employer' }, pkrAccount);
  assert.equal(salary.classificationId, 'salary');
  assert.notEqual(normalized.classificationId, salary.classificationId, 'family support remains distinguishable from employment income');
});

test('stored records with invalid transaction types or mismatched classifications are rejected', () => {
  assert.equal(validateStoredClassification('Income', 'Family gift / support'), 'family_gift');
  assert.throws(() => validateStoredClassification('Deposit', 'salary'), /unsupported type/);
  assert.throws(() => validateStoredClassification('Expense', 'salary'), /does not match/);
  assert.throws(() => validateStoredClassification('Income', 'not-a-category'), /unsupported classification/);
});

test('remittance requires complete provenance and an exactly matching converted PKR amount', () => {
  const remittance = {
    id: 'remit-1', ownerId: 'user-1', amountMinor: 2_801_250, type: 'Income',
    classificationId: 'foreign_remittance', accountId: pkrAccount.id, sourceName: 'Brother',
    sourceAmountMinor: 10_000, sourceCurrency: 'USD', exchangeRate: '280.125',
    referenceNumber: 'BANK-123', date: '2026-05-20T12:00:00.000Z',
  };
  const normalized = normalizeTransactionDraft(remittance, pkrAccount);
  assert.equal(normalized.sourceAmountMinor, 10_000);
  assert.equal(normalized.sourceCurrency, 'USD');
  assert.equal(normalized.referenceNumber, 'BANK-123');
  assert.throws(() => normalizeTransactionDraft({ ...remittance, amountMinor: 2_801_249 }, pkrAccount), /does not match/);
  assert.throws(() => normalizeTransactionDraft({ ...remittance, referenceNumber: '' }, pkrAccount), /reference/);
  assert.throws(() => normalizeTransactionDraft({ ...remittance, sourceCurrency: 'PKR' }, pkrAccount), /foreign currency/);
});

test('ownership, transfer currency, and classification rules are enforced in the domain service', async () => {
  const accounts = new Map([
    ['bank-main', pkrAccount],
    ['savings', { id: 'savings', ownerId: 'user-1', currency: 'PKR', type: 'savings' }],
    ['foreign', { id: 'foreign', ownerId: 'user-1', currency: 'USD', type: 'bank' }],
    ['other-owner', { id: 'other-owner', ownerId: 'user-2', currency: 'PKR', type: 'bank' }],
  ]);
  const records = new Map();
  let inserted = 0;
  const store = {
    async findAccount(id, ownerId) {
      const account = accounts.get(id);
      return account?.ownerId === ownerId ? account : null;
    },
    async findTransaction(id, ownerId) {
      const record = records.get(id);
      return record?.ownerId === ownerId ? record : null;
    },
    async insertTransaction(record) {
      records.set(record.id, record);
      inserted += 1;
    },
  };

  const transfer = {
    id: 'transfer-1', ownerId: 'user-1', amountMinor: 1_000, type: 'Transfer',
    accountId: 'bank-main', toAccountId: 'savings', date: '2026-04-01T00:00:00.000Z',
  };
  const saved = await createValidatedTransaction(transfer, transfer.id, store);
  assert.equal(saved.classificationId, null);
  assert.equal(saved.categoryLabel, 'Internal transfer');
  await createValidatedTransaction(transfer, transfer.id, store);
  assert.equal(inserted, 1, 'same stable ID and details must not create a duplicate');
  await assert.rejects(
    createValidatedTransaction({ ...transfer, amountMinor: 2_000 }, transfer.id, store), /already used/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, accountId: 'other-owner' }, 'cross-owner', store), /not available/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, toAccountId: 'foreign' }, 'fx-transfer', store), /different currencies/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, type: 'Expense', classificationId: 'salary', toAccountId: undefined }, 'bad-class', store), /does not match/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, amountMinor: 0 }, 'zero-amount', store), /positive safe integer/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, amountMinor: -1 }, 'negative-amount', store), /positive safe integer/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, amountMinor: Number.MAX_SAFE_INTEGER + 1 }, 'unsafe-amount', store), /positive safe integer/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, type: 'Deposit', toAccountId: undefined }, 'invalid-type', store), /type is invalid/,
  );
  await assert.rejects(
    createValidatedTransaction({ ...transfer, type: 'Income', toAccountId: undefined, classificationId: 'unknown' }, 'invalid-category', store), /supported transaction classification/,
  );
});

test('transfers change account balances but do not inflate income, expenses, or cash flow', () => {
  const entries = [
    {
      id: 'opening', date: '2026-01-01T00:00:00.000Z', description: 'Opening balance', postings: [
        { accountId: 'cash', accountClass: 'asset', debitMinor: 10_000, creditMinor: 0, isCashLike: true, cashFlowActivity: 'financing' },
        { accountId: 'opening-equity', accountClass: 'equity', debitMinor: 0, creditMinor: 10_000 },
      ],
    },
    {
      id: 'salary', date: '2026-01-02T00:00:00.000Z', description: 'Salary', postings: [
        { accountId: 'cash', accountClass: 'asset', debitMinor: 5_000, creditMinor: 0, isCashLike: true, cashFlowActivity: 'operating' },
        { accountId: 'salary-income', accountClass: 'income', debitMinor: 0, creditMinor: 5_000 },
      ],
    },
    {
      id: 'food', date: '2026-01-03T00:00:00.000Z', description: 'Food', postings: [
        { accountId: 'food-expense', accountClass: 'expense', debitMinor: 1_000, creditMinor: 0 },
        { accountId: 'cash', accountClass: 'asset', debitMinor: 0, creditMinor: 1_000, isCashLike: true, cashFlowActivity: 'operating' },
      ],
    },
    {
      id: 'transfer', date: '2026-01-04T00:00:00.000Z', description: 'Own account transfer', postings: [
        { accountId: 'savings', accountClass: 'asset', debitMinor: 2_000, creditMinor: 0, isCashLike: true, cashFlowActivity: 'transfer' },
        { accountId: 'cash', accountClass: 'asset', debitMinor: 0, creditMinor: 2_000, isCashLike: true, cashFlowActivity: 'transfer' },
      ],
    },
  ];
  assert.deepEqual(calculateIncomeExpense(entries), { incomeMinor: 5_000, expenseMinor: 1_000, surplusMinor: 4_000 });
  assert.deepEqual(calculateBalanceSheet(entries, '2026-01-31'), {
    assetsMinor: 14_000, liabilitiesMinor: 0, equityMinor: 14_000, netWorthMinor: 14_000,
  });
  assert.deepEqual(calculateCashFlow(entries), {
    operatingMinor: 4_000, investingMinor: 0, financingMinor: 10_000, netCashFlowMinor: 14_000,
  });
  assert.equal(calculateIncomeExpense(entries, { startDate: '2026-01-02', endDate: '2026-01-02' }).incomeMinor, 5_000);
  assert.equal(calculateIncomeExpense(entries, { startDate: '2026-02-01', endDate: '2026-02-28' }).incomeMinor, 0);
});

test('account balances apply income, spending, and same-currency transfers exactly', () => {
  const balances = calculateAccountBalances([
    { id: 'cash', ownerId: 'user-1', name: 'Cash', type: 'cash', balanceMinor: 10_000, currency: 'PKR' },
    { id: 'savings', ownerId: 'user-1', name: 'Savings', type: 'savings', balanceMinor: 3_000, currency: 'PKR' },
  ], [
    { ownerId: 'user-1', amountMinor: 2500, type: 'Income', accountId: 'cash', toAccountId: null },
    { ownerId: 'user-1', amountMinor: 1000, type: 'Expense', accountId: 'cash', toAccountId: null },
    { ownerId: 'user-1', amountMinor: 4000, type: 'Transfer', accountId: 'cash', toAccountId: 'savings' },
  ]);
  assert.deepEqual(balances.map(({ id, balanceMinor }) => ({ id, balanceMinor })), [
    { id: 'cash', balanceMinor: 7500 },
    { id: 'savings', balanceMinor: 7000 },
  ]);
  assert.throws(() => calculateAccountBalances([
    { id: 'cash', ownerId: 'user-1', name: 'Cash', type: 'cash', balanceMinor: 100, currency: 'PKR' },
  ], [{ ownerId: 'user-2', amountMinor: 1, type: 'Income', accountId: 'cash', toAccountId: null }]), /unavailable source account/);
  assert.throws(() => calculateAccountBalances([
    { id: 'cash', ownerId: 'user-1', name: 'Cash', type: 'cash', balanceMinor: 100, currency: 'PKR' },
  ], [{ ownerId: 'user-1', amountMinor: 1, type: 'Transfer', accountId: 'cash', toAccountId: 'cash' }]), /invalid destination/);
  assert.throws(() => calculateAccountBalances([
    { id: 'cash', ownerId: 'user-1', name: 'Cash', type: 'cash', balanceMinor: Number.MAX_SAFE_INTEGER, currency: 'PKR' },
  ], [{ ownerId: 'user-1', amountMinor: 1, type: 'Income', accountId: 'cash', toAccountId: null }]), /outside the supported range/);
});

test('report currency selection excludes foreign and unknown denomination rows', () => {
  const transactions = [
    { id: 'pkr', accountCurrency: 'PKR', amountMinor: 250_000 },
    { id: 'usd', accountCurrency: 'USD', amountMinor: 250_000 },
    { id: 'legacy', accountCurrency: null, amountMinor: 250_000 },
  ];
  assert.deepEqual(transactionsInCurrency(transactions, 'PKR').map(({ id }) => id), ['pkr']);
  assert.deepEqual(transactionsInCurrency(transactions, 'USD').map(({ id }) => id), ['usd']);
  assert.throws(() => transactionsInCurrency(transactions, ' '), /report currency/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateExpenseBucketTotals, calculateFinancialReport, dashboardMonthRange } from '../../src/finance/reporting.ts';
import { projectTransactionActivity } from '../../src/finance/transactionDisplay.ts';
import { calculateLiquidityPositions } from '../../src/finance/liquidity.ts';

const bucket = {
  id: 'week-1', group: 'Weekly',
  startDate: '2026-05-11T00:00:00.000Z', endDate: '2026-05-18T00:00:00.000Z',
};

function row(overrides = {}) {
  return {
    id: 'expense-0', ownerId: 'user-1', date: '2026-05-15T12:00:00.000Z', amountMinor: 100,
    type: 'Expense', category: 'food', note: '', accountId: 'cash', toAccountId: null,
    accountCurrency: 'PKR', destinationCurrency: null, reversalOfId: null,
    linkedOriginalAccountId: null, linkedOriginalToAccountId: null, linkedOriginalType: null,
    linkedCategory: null, linkedCurrency: null, linkedDestinationCurrency: null,
    linkedRootType: null, linkedRootId: null, linkedRootCurrency: null,
    ...overrides,
  };
}

test('dashboard budget keys and report bounds use the selected local calendar month in positive offsets', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Karachi';
  try {
    const range = dashboardMonthRange(new Date(2026, 9, 24, 12));
    assert.equal(range.periodStart, '2026-10-01');
    assert.equal(range.periodEnd, '2026-11-01');
    assert.equal(new Date(range.startDate).getFullYear(), 2026);
    assert.equal(new Date(range.startDate).getMonth(), 9);
    assert.equal(new Date(range.startDate).getDate(), 1);
    assert.equal(new Date(range.startDate).getHours(), 0);
    assert.equal(new Date(range.endDate).getDate(), 1);
    assert.equal(new Date(range.endDate).getMonth(), 10);
    assert.equal(new Date(range.endDate).getHours(), 0);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('dashboard monthly totals reconcile income, expenses, partial refunds, refund corrections, and currency exclusions', () => {
  const report = calculateFinancialReport([
    row({ id: 'salary', type: 'Income', category: 'employment', amountMinor: 100_000 }),
    row({ id: 'food', category: 'food', amountMinor: 30_000 }),
    row({ id: 'refund', type: 'Refund', category: 'expense_refund', amountMinor: 5_000, reversalOfId: 'food', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' }),
    row({ id: 'refund-correction', type: 'Reversal', category: 'correction', amountMinor: 2_000, reversalOfId: 'refund', accountId: 'cash', linkedOriginalAccountId: 'cash', linkedOriginalType: 'Refund', linkedCategory: 'food', linkedCurrency: 'PKR', linkedRootType: 'Expense', linkedRootId: 'food', linkedRootCurrency: 'PKR' }),
    row({ id: 'transfer', type: 'Transfer', category: 'transfer', amountMinor: 50_000, toAccountId: 'bank', destinationCurrency: 'PKR' }),
    row({ id: 'principal', category: 'debt_principal_repayment', amountMinor: 40_000 }),
    row({ id: 'foreign-expense', accountCurrency: 'USD', amountMinor: 900_000 }),
  ], 'PKR', { startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z' });

  assert.equal(report.incomeMinor, 100_000);
  assert.equal(report.expenseMinor, 27_000);
  assert.equal(report.netMinor, 73_000);
  assert.deepEqual(report.excludedCurrencies, ['USD']);
});

test('dashboard chart aggregation uses complete unordered rows and stays stable across pagination boundaries', () => {
  const rows = Array.from({ length: 2500 }, (_, index) => row({ id: `expense-${index}`, amountMinor: 100 }));
  rows.push(
    row({ id: 'refund-a', type: 'Refund', category: 'expense_refund', amountMinor: 300, reversalOfId: 'expense-0', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' }),
    row({ id: 'refund-b', type: 'Refund', category: 'expense_refund', amountMinor: 100, reversalOfId: 'expense-0', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' }),
    row({ id: 'refund-correction', type: 'Reversal', category: 'correction', amountMinor: 200, reversalOfId: 'refund-a', linkedOriginalType: 'Refund', linkedCategory: 'food', linkedCurrency: 'PKR', linkedRootType: 'Expense', linkedRootId: 'expense-0', linkedRootCurrency: 'PKR' }),
    row({ id: 'expense-correction', type: 'Reversal', category: 'correction', amountMinor: 100, reversalOfId: 'expense-1', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' }),
    row({ id: 'usd-expense', accountCurrency: 'USD', amountMinor: 90000 }),
    row({ id: 'before', date: '2026-05-10T23:59:59.999Z', amountMinor: 70000 }),
    row({ id: 'boundary', date: '2026-05-18T00:00:00.000Z', amountMinor: 80000 }),
    row({ id: 'transfer', type: 'Transfer', category: 'transfer', amountMinor: 50000, toAccountId: 'bank', destinationCurrency: 'PKR' }),
    row({ id: 'capital-movement', category: 'debt_principal_repayment', amountMinor: 60000 }),
  );

  const forward = calculateExpenseBucketTotals(rows, 'PKR', [bucket]);
  const reordered = calculateExpenseBucketTotals([...rows].reverse(), 'PKR', [bucket]);
  const pageSize = 37;
  const partitionedRows = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) partitionedRows.push(...rows.slice(offset, offset + pageSize));
  const partitioned = calculateExpenseBucketTotals(partitionedRows, 'PKR', [bucket]);

  assert.equal(forward['week-1'], 249700);
  assert.deepEqual(reordered, forward);
  assert.deepEqual(partitioned, forward);
});

test('dashboard chart shows refunds before expenses as negative spending and uses exclusive bucket ends', () => {
  const rows = [
    row({ id: 'net-refund', type: 'Refund', amountMinor: 250, category: 'expense_refund', reversalOfId: 'expense-old', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' }),
    row({ id: 'same-instant', amountMinor: 50 }),
    row({ id: 'at-end', date: bucket.endDate, amountMinor: 500 }),
  ];
  assert.deepEqual(calculateExpenseBucketTotals(rows, 'PKR', [bucket]), { 'week-1': -200 });
});

test('recent activity uses friendly categories and financially correct directions', () => {
  const common = {
    id: 'tx-1', amountMinor: 20000, accountCurrency: 'PKR', destinationCurrency: null,
    sourceName: 'Mother', note: '', date: '2026-05-15T12:00:00.000Z', linkedOriginalType: null, linkedCategoryId: null,
  };
  const gift = projectTransactionActivity({ ...common, type: 'Income', categoryId: 'family_gift' });
  assert.equal(gift.title, 'Mother');
  assert.equal(gift.categoryLabel, 'Family gift / support');
  assert.equal(gift.direction, 'in');
  assert.equal(gift.currency, 'PKR');

  const refund = projectTransactionActivity({ ...common, id: 'refund-1', type: 'Refund', categoryId: 'expense_refund', linkedOriginalType: 'Expense', linkedCategoryId: 'housing' });
  assert.equal(refund.categoryLabel, 'Refund · Housing / hostel');
  assert.equal(refund.direction, 'in');

  const refundCorrection = projectTransactionActivity({ ...common, id: 'reversal-1', type: 'Reversal', categoryId: 'correction', linkedOriginalType: 'Refund', linkedCategoryId: 'housing' });
  assert.equal(refundCorrection.direction, 'out');
  assert.equal(refundCorrection.categoryLabel, 'Refund correction · Housing / hostel');

  const unknownCurrency = projectTransactionActivity({ ...common, id: 'unknown-currency', type: 'Expense', categoryId: 'food', accountCurrency: 'CAD' });
  assert.equal(unknownCurrency.currency, null);
  assert.throws(() => projectTransactionActivity({ ...common, id: '', type: 'Expense', categoryId: 'food' }), /identity/);
});

test('liquidity reserves only the amounts earmarked in each active liquid account, by currency', () => {
  assert.deepEqual(calculateLiquidityPositions([
    { id: 'cash-pkr', currency: 'PKR', type: 'cash', archivedAt: null, balanceMinor: 100000 },
    { id: 'bank-pkr', currency: 'PKR', type: 'bank', archivedAt: null, balanceMinor: 50000 },
    { id: 'cash-usd', currency: 'USD', type: 'wallet', archivedAt: null, balanceMinor: 10000 },
    { id: 'archived', currency: 'PKR', type: 'bank', archivedAt: '2026-01-01T00:00:00.000Z', balanceMinor: 90000 },
    { id: 'portfolio', currency: 'PKR', type: 'investment', archivedAt: null, balanceMinor: 30000 },
  ], [
    { accountId: 'cash-pkr', amountMinor: 12000 },
    { accountId: 'archived', amountMinor: 20000 },
    { accountId: 'portfolio', amountMinor: 10000 },
    { accountId: 'cash-usd', amountMinor: 3000 },
  ]), [
    { currency: 'PKR', currentBalanceMinor: 150000, reservedMinor: 12000, availableMinor: 138000 },
    { currency: 'USD', currentBalanceMinor: 10000, reservedMinor: 3000, availableMinor: 7000 },
  ]);
  assert.throws(() => calculateLiquidityPositions([
    { id: 'cash', currency: 'PKR', type: 'cash', archivedAt: null, balanceMinor: 100 },
  ], [{ accountId: 'cash', amountMinor: Number.MAX_SAFE_INTEGER + 1 }]), /reservation is invalid/);
});

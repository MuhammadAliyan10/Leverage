import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTransactionsByDate, projectTransactionActivity } from '../../src/finance/transactionDisplay.ts';

test('refunds and reversals retain their linked accounting meaning and never assume a currency', () => {
  const refund = projectTransactionActivity({ id: 'refund-1', type: 'Refund', categoryId: 'expense_refund', amountMinor: 1250, accountCurrency: null, destinationCurrency: null, sourceName: null, note: 'Refund', date: '2026-10-23T10:00:00.000Z', linkedOriginalType: 'Expense', linkedCategoryId: 'food' });
  assert.equal(refund.direction, 'in');
  assert.equal(refund.categoryLabel, 'Refund · Food');
  assert.equal(refund.currency, null);
  assert.equal(refund.statusLabel, 'Refund');

  const reversal = projectTransactionActivity({ id: 'reversal-1', type: 'Reversal', categoryId: 'correction_reversal', amountMinor: 5000, accountCurrency: 'PKR', destinationCurrency: null, sourceName: null, note: 'Correction', date: '2026-10-23T10:00:00.000Z', linkedOriginalType: 'Expense', linkedCategoryId: 'housing' });
  assert.equal(reversal.direction, 'in', 'reversing an expense restores the balance');
  assert.match(reversal.categoryLabel, /Expense correction/);

  const transfer = projectTransactionActivity({ id: 'transfer-1', type: 'Transfer', categoryId: 'internal_transfer', amountMinor: 9900, accountCurrency: 'USD', destinationCurrency: 'USD', sourceName: null, note: '', date: '2026-10-23T10:00:00.000Z', linkedOriginalType: null, linkedCategoryId: null, accountName: 'Bank', destinationName: 'Wallet' });
  assert.equal(transfer.direction, 'transfer');
  assert.equal(transfer.accountContext, 'Bank → Wallet');
  assert.equal(transfer.categoryLabel, 'Account transfer');
});

test('history groups transactions by local calendar date without reordering equal-time entries', () => {
  const now = new Date(2026, 9, 23, 12, 0, 0);
  const entries = [
    { id: 'a', date: new Date(2026, 9, 23, 10, 0, 0).toISOString() },
    { id: 'b', date: new Date(2026, 9, 23, 10, 0, 0).toISOString() },
    { id: 'c', date: new Date(2026, 9, 22, 22, 0, 0).toISOString() },
  ];
  const groups = groupTransactionsByDate(entries, now);
  assert.equal(groups[0].title, 'Today');
  assert.deepEqual(groups[0].data.map(({ id }) => id), ['a', 'b']);
  assert.equal(groups[1].title, 'Yesterday');
});

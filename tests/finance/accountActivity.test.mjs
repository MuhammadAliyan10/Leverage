import assert from 'node:assert/strict';
import test from 'node:test';
import { accountMovementDirection } from '../../src/finance/accountActivity.ts';

test('account movement direction reflects both sides of transfers and their reversals', () => {
  const transfer = { type: 'Transfer', accountId: 'cash', toAccountId: 'bank' };
  assert.equal(accountMovementDirection(transfer, 'cash'), 'out');
  assert.equal(accountMovementDirection(transfer, 'bank'), 'in');
  const reversal = { ...transfer, type: 'Reversal', linkedOriginalType: 'Transfer' };
  assert.equal(accountMovementDirection(reversal, 'cash'), 'in');
  assert.equal(accountMovementDirection(reversal, 'bank'), 'out');
  assert.equal(accountMovementDirection(transfer, 'other'), null);
});

test('account movement direction treats refunds as cash in and corrections as compensating entries', () => {
  assert.equal(accountMovementDirection({ type: 'Refund', accountId: 'wallet', toAccountId: null }, 'wallet'), 'in');
  assert.equal(accountMovementDirection({ type: 'Reversal', accountId: 'wallet', toAccountId: null, linkedOriginalType: 'Income' }, 'wallet'), 'out');
  assert.equal(accountMovementDirection({ type: 'Reversal', accountId: 'wallet', toAccountId: null, linkedOriginalType: 'Expense' }, 'wallet'), 'in');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBudgetSnapshot,
  calculateEmergencyFundTarget,
  calculateSavingsGoalProgress,
  rollMonthlyBudget,
} from '../../src/finance/budgeting.ts';

const report = {
  currency: 'PKR', incomeMinor: 0, expenseMinor: 12000, netMinor: -12000,
  categoryTotals: [
    { category: 'Food', amountMinor: 10000 },
    { category: 'Housing', amountMinor: 2000 },
    { category: 'Transport', amountMinor: -500 },
  ],
  largestExpenses: [], excludedCurrencies: ['USD'],
};

test('budget snapshot compares allocations to full net category spending, including refunds and uncapped overages', () => {
  const snapshot = calculateBudgetSnapshot({
    ownerId: 'user-1', reportOwnerId: 'user-1', currency: 'PKR',
    startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z',
    allocations: [{ category: 'Food', amountMinor: 8000 }, { category: 'Housing', amountMinor: 5000 }],
    report,
  });
  assert.equal(snapshot.allocatedMinor, 13000);
  assert.equal(snapshot.spentMinor, 11500);
  assert.equal(snapshot.remainingMinor, 1500);
  assert.deepEqual(snapshot.categories.map(({ category, amountMinor, spentMinor, remainingMinor }) => ({
    category, amountMinor, spentMinor, remainingMinor,
  })), [
    { category: 'Food', amountMinor: 8000, spentMinor: 10000, remainingMinor: -2000 },
    { category: 'Housing', amountMinor: 5000, spentMinor: 2000, remainingMinor: 3000 },
    { category: 'Transport', amountMinor: 0, spentMinor: -500, remainingMinor: 500 },
  ]);
  assert.equal(snapshot.categories[0].percentUsed, 125);
});

test('budgets reject profile, currency, period and duplicate-category mismatches', () => {
  const base = {
    ownerId: 'user-1', reportOwnerId: 'user-1', currency: 'PKR',
    startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z',
    allocations: [], report,
  };
  assert.throws(() => calculateBudgetSnapshot({ ...base, reportOwnerId: 'user-2' }), /profiles must match/);
  assert.throws(() => calculateBudgetSnapshot({ ...base, currency: 'USD' }), /currencies must match/);
  assert.throws(() => calculateBudgetSnapshot({ ...base, startDate: '2026-06-01T00:00:00.000Z' }), /period is invalid/);
  assert.throws(() => calculateBudgetSnapshot({ ...base, allocations: [
    { category: 'Food', amountMinor: 1 }, { category: 'Food', amountMinor: 1 },
  ] }), /Duplicate budget category/);
});

test('monthly rollover resets or carries unused category amounts and uses UTC calendar boundaries', () => {
  const prior = {
    ownerId: 'user-1', currency: 'PKR', categories: [
      { category: 'Food', amountMinor: 10000, spentMinor: 7000, remainingMinor: 3000, percentUsed: 70 },
      { category: 'Housing', amountMinor: 5000, spentMinor: 6000, remainingMinor: -1000, percentUsed: 120 },
    ],
  };
  const base = [{ category: 'Food', amountMinor: 9000 }, { category: 'Housing', amountMinor: 5000 }];
  const carried = rollMonthlyBudget(2026, 5, 'user-1', 'PKR', base, prior, 'carry_unused');
  assert.equal(carried.startDate, '2026-06-01T00:00:00.000Z');
  assert.equal(carried.endDate, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(carried.allocations, [{ category: 'Food', amountMinor: 12000 }, { category: 'Housing', amountMinor: 5000 }]);
  assert.deepEqual(rollMonthlyBudget(2026, 5, 'user-1', 'PKR', base, prior, 'reset').allocations, base);
  assert.throws(() => rollMonthlyBudget(2026, 5, 'user-2', 'PKR', base, prior, 'carry_unused'), /profiles must match/);
  assert.throws(() => rollMonthlyBudget(2026, 5, 'user-1', 'USD', base, prior, 'carry_unused'), /currencies must match/);
});

test('savings goals enforce profile and currency and report remaining and overfunded amounts exactly', () => {
  const progress = calculateSavingsGoalProgress({
    ownerId: 'user-1', currency: 'PKR', targetMinor: 10000,
    contributions: [
      { ownerId: 'user-1', currency: 'PKR', amountMinor: 6000 },
      { ownerId: 'user-1', currency: 'PKR', amountMinor: 5500 },
    ],
  });
  assert.deepEqual(progress, {
    targetMinor: 10000, contributedMinor: 11500, remainingMinor: 0, percentComplete: 115, overfundedMinor: 1500,
  });
  assert.throws(() => calculateSavingsGoalProgress({
    ownerId: 'user-1', currency: 'PKR', targetMinor: 10000,
    contributions: [{ ownerId: 'user-2', currency: 'PKR', amountMinor: 500 }],
  }), /goal profile/);
  assert.throws(() => calculateSavingsGoalProgress({
    ownerId: 'user-1', currency: 'PKR', targetMinor: 10000,
    contributions: [{ ownerId: 'user-1', currency: 'USD', amountMinor: 500 }],
  }), /goal currency/);
});

test('emergency fund target uses integer minor units and bounded month counts', () => {
  const expenses = [10000, 2550, 7450].map((amountMinor) => ({ amountMinor, currency: 'PKR' }));
  assert.equal(calculateEmergencyFundTarget('PKR', expenses, 6), 120000);
  assert.throws(() => calculateEmergencyFundTarget('PKR', [{ amountMinor: 100.5, currency: 'PKR' }]), /integer minor-unit/);
  assert.throws(() => calculateEmergencyFundTarget('PKR', [{ amountMinor: 100, currency: 'USD' }]), /one currency/);
  assert.throws(() => calculateEmergencyFundTarget('PKR', expenses, 0), /between 1 and 60/);
});

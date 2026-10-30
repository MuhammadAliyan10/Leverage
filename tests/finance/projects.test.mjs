import assert from 'node:assert/strict';
import test from 'node:test';
import { splitProjectExpense, calculateProjectTotals, projectRemainingBudget, projectFundBalance } from '../../src/finance/projects.ts';

test('equal project splits allocate every minor unit deterministically', () => {
  assert.deepEqual(splitProjectExpense({amountMinor:200_000,method:'equal',participants:[{memberId:'ali'},{memberId:'ahmed'},{memberId:'usman'}]}),[
    {memberId:'ali',amountMinor:66_666},{memberId:'ahmed',amountMinor:66_666},{memberId:'usman',amountMinor:66_668},
  ]);
});

test('percentage and weighted splits reconcile exactly and validate their basis', () => {
  assert.deepEqual(splitProjectExpense({amountMinor:10_000,method:'percentage',participants:[{memberId:'a',value:5000},{memberId:'b',value:3000},{memberId:'c',value:2000}]}).map((share)=>share.amountMinor),[5_000,3_000,2_000]);
  assert.deepEqual(splitProjectExpense({amountMinor:10_000,method:'weighted',participants:[{memberId:'a',value:2},{memberId:'b',value:1},{memberId:'c',value:1}]}).map((share)=>share.amountMinor),[5_000,2_500,2_500]);
  assert.throws(()=>splitProjectExpense({amountMinor:1_000,method:'percentage',participants:[{memberId:'a',value:5000},{memberId:'b',value:4999}]}),/total exactly 100%/);
});

test('fixed and individual allocations reject inconsistent and duplicate participants', () => {
  assert.deepEqual(splitProjectExpense({amountMinor:1000,method:'fixed',participants:[{memberId:'a',value:350},{memberId:'b',value:650}]}),[{memberId:'a',amountMinor:350},{memberId:'b',amountMinor:650}]);
  assert.throws(()=>splitProjectExpense({amountMinor:1000,method:'fixed',participants:[{memberId:'a',value:349},{memberId:'b',value:650}]}),/equal the expense amount/);
  assert.throws(()=>splitProjectExpense({amountMinor:1000,method:'equal',participants:[{memberId:'a'},{memberId:'a'}]}),/unique/);
  assert.throws(()=>splitProjectExpense({amountMinor:1000,method:'individual',participants:[{memberId:'a'},{memberId:'b'}]}),/exactly one/);
});

test('project budgets, group contributions and expenses remain distinct', () => {
  const totals=calculateProjectTotals([{type:'contribution',amountMinor:900_000},{type:'fund_spend',amountMinor:200_000},{type:'revenue',amountMinor:75_000}],1_000_000);
  assert.equal(totals.expenseMinor,200_000);
  assert.equal(totals.contributionMinor,900_000);
  assert.equal(totals.externalRevenueMinor,75_000);
  assert.equal(projectRemainingBudget(totals),800_000);
  assert.equal(projectFundBalance(totals),700_000);
});

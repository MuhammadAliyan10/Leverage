import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDebtRepayments } from '../../src/finance/debtSchedule.ts';
import { calculateDebtPositions } from '../../src/finance/debtPosition.ts';

test('repayment projections keep principal and interest separate, anchored on month-end, with integer rounding',()=>{
  const installments=projectDebtRepayments({principalMinor:1_000_000,installmentAmountMinor:200_000,frequency:'monthly',firstDueDate:'2024-01-31',installmentCount:4,interestMethod:'declining',annualRateBps:1200},'2024-02-29');
  assert.deepEqual(installments.map((item)=>item.dueDate),['2024-01-31','2024-02-29','2024-03-31','2024-04-30']);
  assert.equal(installments[0].interestMinor,10_000);
  assert.equal(installments[0].principalMinor,190_000);
  assert.equal(installments[0].status,'overdue');
  assert.equal(installments[1].status,'planned');
  assert.equal(installments[3].remainingPrincipalMinor,228_524);
  const halfUnit=projectDebtRepayments({principalMinor:10,installmentAmountMinor:2,frequency:'monthly',firstDueDate:'2024-02-29',installmentCount:1,interestMethod:'fixed',annualRateBps:6000},'2024-02-29')[0];
  assert.equal(halfUnit.interestMinor,1,'half minor units round up once per installment');
  assert.equal(halfUnit.principalMinor,1);
});

test('repayment projection refuses invented/incomplete or negative-amortization terms',()=>{
  assert.throws(()=>projectDebtRepayments({principalMinor:1000,installmentAmountMinor:5,frequency:'monthly',firstDueDate:'2024-02-29',installmentCount:12,interestMethod:'declining',annualRateBps:1200},'2024-02-29'),/does not cover/);
  assert.throws(()=>projectDebtRepayments({principalMinor:1000,installmentAmountMinor:100,frequency:'monthly',firstDueDate:'2024-02-30',installmentCount:12,interestMethod:'fixed',annualRateBps:1200},'2024-02-29'),/valid calendar/);
  assert.throws(()=>projectDebtRepayments({principalMinor:1000,installmentAmountMinor:100,frequency:'monthly',firstDueDate:'2024-02-29',installmentCount:12,interestMethod:'none',annualRateBps:100},'2024-02-29'),/terms are invalid/);
});

test('borrowed principal offsets cash with a liability; lent principal is a receivable and currencies stay separate',()=>{
  const positions=calculateDebtPositions([
    {direction:'borrowed',principalMinor:100_000,principalSettledMinor:0,currency:'PKR'},
    {direction:'lent',principalMinor:20_000,principalSettledMinor:0,currency:'PKR'},
    {direction:'lent',principalMinor:10_000,principalSettledMinor:2_500,currency:'USD'},
  ]);
  assert.deepEqual(positions,[
    {currency:'PKR',receivablesMinor:20_000,liabilitiesMinor:100_000,netWorthEffectMinor:-80_000},
    {currency:'USD',receivablesMinor:7_500,liabilitiesMinor:0,netWorthEffectMinor:7_500},
  ]);
  const accrued=calculateDebtPositions([{direction:'borrowed',principalMinor:100_000,principalSettledMinor:0,interestAccruedMinor:10_000,interestPaidMinor:5_000,currency:'PKR'}]);
  assert.equal(accrued[0].liabilitiesMinor,105_000,'unpaid interest charged increases outstanding debt; payment reduces it');
  assert.equal((100_000-20_000)+positions[0].receivablesMinor-positions[0].liabilitiesMinor,0,'borrowed cash offsets liabilities and lent cash is replaced by a receivable');
  assert.throws(()=>calculateDebtPositions([{direction:'borrowed',principalMinor:5,principalSettledMinor:6,currency:'PKR'}]),/invalid/);
});

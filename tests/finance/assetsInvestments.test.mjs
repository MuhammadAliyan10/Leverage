import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateHoldingPosition, calculateNetWorthHistory, calculateNetWorthPositions, calculateQuantityMicros, formatQuantityMicros, ownedAssetValue } from '../../src/finance/assetsInvestments.ts';

test('average cost, fees, partial sales, splits and dividends use integer minor units',()=>{
  const events=[
    {eventType:'buy',quantityMicros:10_000_000,unitPriceMinor:10_000,feeMinor:500,amountMinor:100_000,splitNumerator:0,splitDenominator:0},
    {eventType:'sell',quantityMicros:4_000_000,unitPriceMinor:12_000,feeMinor:100,amountMinor:48_000,splitNumerator:0,splitDenominator:0},
    {eventType:'split',quantityMicros:0,unitPriceMinor:0,feeMinor:0,amountMinor:0,splitNumerator:2,splitDenominator:1},
    {eventType:'dividend',quantityMicros:0,unitPriceMinor:0,feeMinor:0,amountMinor:2_500,splitNumerator:0,splitDenominator:0},
  ];
  assert.deepEqual(calculateHoldingPosition(events,6_000),{quantityMicros:12_000_000,costBasisMinor:60_300,marketValueMinor:72_000,realizedGainMinor:7_700,unrealizedGainMinor:11_700,dividendsMinor:2_500,feesMinor:600});
});

test('final sale consumes remaining basis exactly and rejects oversales',()=>{
  const events=[{eventType:'buy',quantityMicros:3,unitPriceMinor:10,feeMinor:0,amountMinor:0,splitNumerator:0,splitDenominator:0},{eventType:'sell',quantityMicros:1,unitPriceMinor:10,feeMinor:0,amountMinor:0,splitNumerator:0,splitDenominator:0},{eventType:'sell',quantityMicros:2,unitPriceMinor:10,feeMinor:0,amountMinor:0,splitNumerator:0,splitDenominator:0}];
  assert.equal(calculateHoldingPosition(events,10).costBasisMinor,0);
  assert.throws(()=>calculateHoldingPosition([...events,{eventType:'sell',quantityMicros:1,unitPriceMinor:10,feeMinor:0,amountMinor:0,splitNumerator:0,splitDenominator:0}],10),/available holding/);
});

test('ownership values and net worth preserve currency boundaries and asset purchase neutrality',()=>{
  assert.equal(ownedAssetValue({currency:'PKR',ownershipBps:5000,currentValueMinor:1_000_001}),500_001);
  const rows=calculateNetWorthPositions([
    {currency:'PKR',cashMinor:500_000,investmentsMinor:0,physicalAssetsMinor:500_000,receivablesMinor:0,liabilitiesMinor:0},
    {currency:'USD',cashMinor:10_000,investmentsMinor:2_000,physicalAssetsMinor:0,receivablesMinor:0,liabilitiesMinor:3_000},
  ]);
  assert.equal(rows.find((row)=>row.currency==='PKR').netWorthMinor,1_000_000);
  assert.equal(rows.find((row)=>row.currency==='USD').netWorthMinor,9_000);
  assert.throws(()=>calculateNetWorthPositions([{currency:'PKR',cashMinor:1.1,investmentsMinor:0,physicalAssetsMinor:0,receivablesMinor:0,liabilitiesMinor:0}]),/integer minor units/);
});

test('quantity parsing round-trips six decimal places without float arithmetic',()=>{
  assert.equal(calculateQuantityMicros('2.000001'),2_000_001);
  assert.equal(formatQuantityMicros(2_000_001),'2.000001');
  assert.throws(()=>calculateQuantityMicros('0'),/positive/);
  assert.throws(()=>calculateQuantityMicros('1.0000001'),/six decimal/);
});

test('historical net worth rebuilds cash, asset prices, investment value and outstanding debt by date',()=>{
  const history=calculateNetWorthHistory({
    dates:['2026-02-28T23:59:59.999Z','2026-06-30T23:59:59.999Z'],
    accounts:[{id:'cash',ownerId:'u',name:'Bank',type:'bank',balanceMinor:1_000_000,currency:'PKR',createdAt:'2026-01-01T00:00:00.000Z'}],
    transactions:[
      {id:'asset-buy',ownerId:'u',amountMinor:200_000,type:'Expense',accountId:'cash',toAccountId:null,reversalOfId:null,date:'2026-01-10T00:00:00.000Z'},
      {id:'investment-buy',ownerId:'u',amountMinor:100_000,type:'Expense',accountId:'cash',toAccountId:null,reversalOfId:null,date:'2026-01-11T00:00:00.000Z'},
      {id:'borrow',ownerId:'u',amountMinor:500_000,type:'Income',accountId:'cash',toAccountId:null,reversalOfId:null,date:'2026-01-12T00:00:00.000Z'},
      {id:'repayment',ownerId:'u',amountMinor:102_000,type:'Expense',accountId:'cash',toAccountId:null,reversalOfId:null,date:'2026-05-01T00:00:00.000Z'},
    ],
    assets:[{id:'home',currency:'PKR',purchaseDate:'2026-01-10T00:00:00.000Z',purchaseValueMinor:200_000,ownershipBps:10_000,valuations:[{valueMinor:200_000,date:'2026-01-10T00:00:00.000Z'},{valueMinor:250_000,date:'2026-04-01T00:00:00.000Z'}],disposals:[]}],
    holdings:[{id:'stock',currency:'PKR',events:[{eventType:'buy',quantityMicros:10_000_000,unitPriceMinor:10_000,feeMinor:0,amountMinor:100_000,splitNumerator:0,splitDenominator:0,date:'2026-01-11T00:00:00.000Z'}],prices:[{unitPriceMinor:10_000,date:'2026-01-11T00:00:00.000Z'},{unitPriceMinor:12_000,date:'2026-04-01T00:00:00.000Z'}]}],
    debts:[{id:'debt',direction:'borrowed',currency:'PKR',principalMinor:500_000,openedAt:'2026-01-12T00:00:00.000Z',events:[{eventType:'principal_repayment',principalMinor:100_000,interestMinor:0,eventDate:'2026-05-01T00:00:00.000Z'},{eventType:'interest',principalMinor:0,interestMinor:2_000,eventDate:'2026-05-01T00:00:00.000Z'}],interestEvents:[{eventType:'charge',amountMinor:5_000,eventDate:'2026-04-01T00:00:00.000Z'}]}],
  });
  assert.equal(history[0].positions[0].netWorthMinor,1_000_000);
  assert.equal(history[1].positions[0].cashMinor,1_098_000);
  assert.equal(history[1].positions[0].investmentsMinor,120_000);
  assert.equal(history[1].positions[0].physicalAssetsMinor,250_000);
  assert.equal(history[1].positions[0].liabilitiesMinor,403_000);
  assert.equal(history[1].positions[0].netWorthMinor,1_065_000);
});

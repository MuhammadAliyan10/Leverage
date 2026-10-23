import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocalDatabase } from '../../src/db/local/migrations.ts';
import { createAssetsInvestmentsStore } from '../../src/db/local/assetsInvestmentsStore.ts';
import { calculateFinancialReport, buildFinancialReportQuery } from '../../src/finance/reporting.ts';
import { calculateAccountBalances } from '../../src/finance/balances.ts';

function fixture() {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  const sql={
    async execAsync(query){db.exec(query);},async runAsync(query,params=[]){return db.prepare(query).run(...params);},
    async getFirstAsync(query,params=[]){return db.prepare(query).get(...params)??null;},async getAllAsync(query,params=[]){return db.prepare(query).all(...params);},
    async withTransactionAsync(task){db.exec('BEGIN IMMEDIATE');try{const result=await task();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
  };
  return {db,sql};
}
async function initialized() {
  const {db,sql}=fixture();await migrateLocalDatabase(sql);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('cash','u','Bank','bank',1_000_000,'PKR','2026-01-01');
  const store=createAssetsInvestmentsStore(async()=>sql,(task)=>sql.withTransactionAsync(()=>task(sql)));
  return {db,sql,store};
}
function cashBalance(db){
  const accounts=db.prepare('SELECT id,ownerId,name,type,balanceMinor,currency FROM Account').all();
  const tx=db.prepare('SELECT id,ownerId,amountMinor,type,accountId,toAccountId,reversalOfId FROM "Transaction" ORDER BY date,id').all();
  return calculateAccountBalances(accounts,tx)[0].balanceMinor;
}

test('asset purchase exchanges cash for owned property value; partial disposal preserves ownership and audit history',async()=>{
  const {db,store}=await initialized();
  await store.asset.create({id:'home',ownerId:'u',name:'Family home',category:'property',currency:'PKR',purchaseValueMinor:500_000,purchaseDate:'2026-01-01',ownershipBps:10_000,fundingAccountId:'cash',idempotencyKey:'home-open'});
  let assets=await store.asset.list('u');
  assert.equal(cashBalance(db),500_000);
  assert.equal(assets[0].ownedValueMinor,500_000);
  await store.asset.addValuation({id:'v2',ownerId:'u',assetId:'home',valueMinor:600_000,valuationDate:'2026-06-01',source:'Agent appraisal',idempotencyKey:'v2'});
  await store.asset.dispose({id:'d1',ownerId:'u',assetId:'home',portionBps:5_000,proceedsMinor:310_000,accountId:'cash',eventDate:'2026-07-01',idempotencyKey:'d1'});
  assets=await store.asset.list('u');
  assert.equal(cashBalance(db),810_000);
  assert.equal(assets[0].currentOwnershipBps,5_000);
  assert.equal(assets[0].ownedValueMinor,300_000);
  assert.equal(assets[0].status,'active');
  assert.equal((await store.asset.history('u','home')).length,2);
  assert.throws(()=>db.prepare('UPDATE AssetActivity SET proceedsMinor=1 WHERE id=?').run('d1'),/append-only/);
  const query=buildFinancialReportQuery('u','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z');
  const report=calculateFinancialReport(db.prepare(query.sql).all(...query.params),'PKR',{startDate:'2026-01-01T00:00:00.000Z',endDate:'2027-01-01T00:00:00.000Z'});
  assert.equal(report.incomeMinor,0,'asset sale proceeds are not earnings');
  assert.equal(report.expenseMinor,0,'asset acquisition is not ordinary spending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AssetActivity').get().n,2);
  db.close();
});

test('investment buys, partial sales, stock splits and dividends reconcile cash and average cost',async()=>{
  const {db,store}=await initialized();
  await store.portfolio.create({id:'p',ownerId:'u',name:'PK portfolio',currency:'PKR',cashAccountId:'cash'});
  await store.holding.create({id:'h',ownerId:'u',portfolioId:'p',symbol:'HLOG',name:'HouseLog Ltd',category:'stock'});
  const buy={id:'buy',ownerId:'u',holdingId:'h',eventType:'buy',quantityMicros:10_000_000,unitPriceMinor:10_000,feeMinor:500,eventDate:'2026-01-01',idempotencyKey:'buy'};
  await store.holding.recordEvent(buy);
  await store.holding.recordEvent(buy);
  assert.equal(cashBalance(db),899_500);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM InvestmentEvent').get().n,1,'retrying the same event does not duplicate trades or cash');
  await store.holding.setPrice({id:'price-1',ownerId:'u',holdingId:'h',unitPriceMinor:12_000,priceDate:'2026-02-01',source:'Manual quote',idempotencyKey:'price-1'});
  await store.holding.recordEvent({id:'sell',ownerId:'u',holdingId:'h',eventType:'sell',quantityMicros:4_000_000,unitPriceMinor:12_000,feeMinor:100,eventDate:'2026-03-01',idempotencyKey:'sell'});
  await store.holding.recordEvent({id:'split',ownerId:'u',holdingId:'h',eventType:'split',splitNumerator:2,splitDenominator:1,eventDate:'2026-03-02',idempotencyKey:'split'});
  await store.holding.setPrice({id:'price-2',ownerId:'u',holdingId:'h',unitPriceMinor:6_000,priceDate:'2026-03-02',source:'Manual quote',idempotencyKey:'price-2'});
  await store.holding.recordEvent({id:'dividend',ownerId:'u',holdingId:'h',eventType:'dividend',amountMinor:2_500,eventDate:'2026-03-03',idempotencyKey:'dividend'});
  const [holding]=await store.holding.list('u');
  assert.equal(cashBalance(db),949_900);
  assert.equal(holding.quantityMicros,12_000_000);
  assert.equal(holding.costBasisMinor,60_300);
  assert.equal(holding.marketValueMinor,72_000);
  assert.equal(holding.realizedGainMinor,7_700);
  assert.equal(holding.unrealizedGainMinor,11_700);
  assert.equal(holding.dividendsMinor,2_500);
  const query=buildFinancialReportQuery('u','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z');
  const report=calculateFinancialReport(db.prepare(query.sql).all(...query.params),'PKR',{startDate:'2026-01-01T00:00:00.000Z',endDate:'2027-01-01T00:00:00.000Z'});
  assert.equal(report.incomeMinor,2_500,'sale principal is excluded while dividends remain income');
  assert.equal(report.expenseMinor,0,'investment purchase cost is not ordinary spending');
  await assert.rejects(store.holding.recordEvent({id:'oversell',ownerId:'u',holdingId:'h',eventType:'sell',quantityMicros:13_000_000,unitPriceMinor:6_000,eventDate:'2026-03-04',idempotencyKey:'oversell'}),/available holding/);
  db.close();
});

test('assets and portfolios reject cross-profile and cross-currency funding',async()=>{
  const {db,store}=await initialized();
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('other','Other','other@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('usd','u','USD','bank',100,'USD','2026-01-01');
  await store.asset.create({id:'private',ownerId:'other',name:'Other profile asset',category:'property',currency:'PKR',purchaseValueMinor:100,purchaseDate:'2026-01-01',ownershipBps:10_000,idempotencyKey:'private'});
  assert.equal((await store.asset.list('u')).length,0,'another profile cannot see the asset');
  assert.equal((await store.asset.list('other')).length,1);
  await assert.rejects(store.asset.addValuation({id:'cross',ownerId:'u',assetId:'private',valueMinor:200,valuationDate:'2026-02-01',source:'Manual',idempotencyKey:'cross'}),/profile mismatch/);
  await assert.rejects(store.portfolio.create({id:'p',ownerId:'u',name:'USD',currency:'USD',cashAccountId:'cash'}),/same currency/);
  await assert.rejects(store.portfolio.create({id:'p-other',ownerId:'other',name:'Other',currency:'USD',cashAccountId:'usd'}),/active account owned by this profile/);
  db.close();
});

test('insufficient cash rolls back asset and investment purchases atomically',async()=>{
  const {db,store}=await initialized();
  await assert.rejects(store.asset.create({id:'too-expensive',ownerId:'u',name:'Land',category:'property',currency:'PKR',purchaseValueMinor:1_100_000,purchaseDate:'2026-01-01',ownershipBps:10_000,fundingAccountId:'cash',idempotencyKey:'too-expensive'}),/exceed the available account balance/);
  await store.portfolio.create({id:'p',ownerId:'u',name:'PK Portfolio',currency:'PKR',cashAccountId:'cash'});
  await store.holding.create({id:'h',ownerId:'u',portfolioId:'p',symbol:'STK',name:'Stock',category:'stock'});
  await assert.rejects(store.holding.recordEvent({id:'too-many',ownerId:'u',holdingId:'h',eventType:'buy',quantityMicros:100_000_000,unitPriceMinor:11_000,feeMinor:0,eventDate:'2026-01-01',idempotencyKey:'too-many'}),/exceed the available account balance/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Asset').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AssetActivity').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM InvestmentEvent').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,0);
  assert.equal(cashBalance(db),1_000_000);
  db.close();
});

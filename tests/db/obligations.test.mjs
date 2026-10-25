import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocalDatabase } from '../../src/db/local/migrations.ts';
import { createObligationsStore } from '../../src/db/local/obligationsStore.ts';
import { createLocalWriteQueue } from '../../src/db/local/writeQueue.ts';

function setup() {
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const adapter={
    async execAsync(sql){db.exec(sql);},
    async runAsync(sql,params=[]){return db.prepare(sql).run(...params);},
    async getFirstAsync(sql,params=[]){return db.prepare(sql).get(...params)??null;},
    async getAllAsync(sql,params=[]){return db.prepare(sql).all(...params);},
    async withTransactionAsync(task){db.exec('BEGIN IMMEDIATE');try{await task();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}},
  };
  return {db,adapter};
}

test('released migrations preserve v1-v5 paths and roll back new schema on late failure',async()=>{
  const {db,adapter}=setup();
  const get=adapter.getFirstAsync;
  adapter.getFirstAsync=async(sql,params=[])=>sql==='PRAGMA integrity_check'?{integrity_check:'broken'}:get(sql,params);
  await assert.rejects(migrateLocalDatabase(adapter),/integrity check failed/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='RecurringSchedule'").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='Asset'").get().n,0);
  adapter.getFirstAsync=get;
  await migrateLocalDatabase(adapter);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
  db.close();
});

test('missed schedules generate persistent pending occurrences once; posting requires explicit action',async()=>{
  const {db,adapter}=setup();
  await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const queue=createLocalWriteQueue();
  const read=async()=>adapter;
  const write=(task)=>queue(async()=>adapter.withTransactionAsync(()=>task(adapter)));
  const store=createObligationsStore(read,write);
  await store.schedule.save({id:'s',ownerId:'u',scheduleType:'income',name:'Salary',amountMinor:2500000,currency:'PKR',accountId:'a',frequency:'monthly',startDate:'2026-01-31'});
  await Promise.all([store.schedule.generateDue('u','2026-04-30'),store.schedule.generateDue('u','2026-04-30')]);
  const rows=await store.schedule.occurrences('u');
  assert.equal(rows.length,4);
  assert.ok(rows.every((item)=>item.status==='pending'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,0,'due dates do not post cash');
  await store.schedule.postOccurrence('u','s:2026-04-30','tx:apr',async(sql,schedule,occurrence)=>{
    await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx:apr','u',schedule.amountMinor/100,schedule.amountMinor,'Income','salary','salary','a',`${occurrence.occurrenceDate}T12:00:00.000Z`,'unreviewed']);
  });
  await assert.rejects(store.schedule.postOccurrence('u','s:2026-04-30','tx:apr',async()=>{}),/already resolved/);
  assert.equal(db.prepare('SELECT status FROM ScheduleOccurrence WHERE id=?').get('s:2026-04-30').status,'posted');
  db.close();
});

test('bill creation does not post funds; partial payments are atomic, idempotent and capped',async()=>{
  const {db,adapter}=setup();
  await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const store=createObligationsStore(async()=>adapter,(task)=>adapter.withTransactionAsync(()=>task(adapter)));
  await store.bill.create({id:'b',ownerId:'u',name:'Electricity',categoryId:'bills',amountMinor:10000,currency:'PKR',dueDate:'2026-10-25',accountId:'a'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,0);
  await store.bill.recordPayment({id:'p1',ownerId:'u',billId:'b',amountMinor:4000,transactionId:'t1',idempotencyKey:'key-1',paidAt:'2026-10-21'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,0)',['t1','u',40,4000,'Expense','bills','a','2026-10-21','unreviewed']));
  await assert.rejects(store.bill.recordPayment({id:'p2',ownerId:'u',billId:'b',amountMinor:7000,transactionId:'t2',idempotencyKey:'key-2',paidAt:'2026-10-21'},async()=>{}),/exceeds/);
  const bill=(await store.bill.list('u','2026-10-21'))[0];
  assert.equal(bill.paidMinor,4000);
  assert.equal(bill.status,'partial');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,1,'rejected payment rolls back its ledger write');
  db.close();
});

test('debt principal is explicit and repayment history cannot exceed the obligation',async()=>{
  const {db,adapter}=setup();
  await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const store=createObligationsStore(async()=>adapter,(task)=>adapter.withTransactionAsync(()=>task(adapter)));
  await store.debt.create({id:'d',ownerId:'u',direction:'borrowed',counterparty:'Family',principalMinor:5000000,currency:'PKR',accountId:'a',interestRateBps:1200,openedAt:'2026-10-21',transactionId:'opening-tx',eventId:'opening-event',idempotencyKey:'open'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,0)',['opening-tx','u',50000,5000000,'Income','debt_borrowing','a','2026-10-21','unreviewed']));
  await store.debt.recordEvent({id:'r1',ownerId:'u',debtId:'d',eventType:'principal_repayment',principalMinor:1000000,interestMinor:0,accountId:'a',transactionId:'repay-tx',eventDate:'2026-11-01',idempotencyKey:'repay'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,0)',['repay-tx','u',10000,1000000,'Expense','debt_principal_repayment','a','2026-11-01','unreviewed']));
  await assert.rejects(store.debt.recordEvent({id:'r2',ownerId:'u',debtId:'d',eventType:'principal_repayment',principalMinor:4000001,interestMinor:0,accountId:'a',transactionId:'repay2-tx',eventDate:'2026-11-02',idempotencyKey:'repay2'},async()=>{}),/exceeds/);
  const debt=(await store.debt.list('u'))[0];
  assert.equal(debt.principalMinor-debt.principalSettledMinor,4000000);
  assert.equal((await store.debt.history('u','d')).length,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,2);
  db.close();
});

test('recurring bills create unpaid obligations on month-end dates and collections reduce lent principal',async()=>{
  const {db,adapter}=setup();
  await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const store=createObligationsStore(async()=>adapter,(task)=>adapter.withTransactionAsync(()=>task(adapter)));
  await store.bill.createRecurring({bill:{id:'bill-template',ownerId:'u',name:'Rent',categoryId:'housing',amountMinor:3000000,currency:'PKR',dueDate:'2026-01-31',accountId:'a'},schedule:{id:'rent-schedule',frequency:'monthly'}});
  await store.schedule.generateDue('u','2026-03-31');
  const bills=await store.bill.list('u','2026-03-31');
  assert.deepEqual(bills.map((bill)=>bill.dueDate),['2026-01-31','2026-02-28','2026-03-31']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,0,'recurring bill occurrences are unpaid obligations');
  const occurrences=await store.schedule.occurrences('u','pending');
  assert.deepEqual(occurrences.map((item)=>item.occurrenceDate),['2026-02-28','2026-03-31']);
  await store.schedule.skipOccurrence('u','rent-schedule:2026-02-28');
  assert.equal((await store.bill.list('u','2026-03-31')).find((bill)=>bill.dueDate==='2026-02-28').status,'skipped');

  await store.debt.create({id:'lent',ownerId:'u',direction:'lent',counterparty:'Friend',principalMinor:20000,currency:'PKR',accountId:'a',openedAt:'2026-01-01',transactionId:'lend-tx',eventId:'lend-event',idempotencyKey:'lend'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,0)',['lend-tx','u',200,20000,'Expense','debt_lending','a','2026-01-01','unreviewed']));
  await store.debt.recordEvent({id:'collect',ownerId:'u',debtId:'lent',eventType:'receivable_payment',principalMinor:5000,interestMinor:0,accountId:'a',transactionId:'collect-tx',eventDate:'2026-02-01',idempotencyKey:'collect'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,0)',['collect-tx','u',50,5000,'Income','debt_receivable_payment','a','2026-02-01','unreviewed']));
  const debt=(await store.debt.list('u')).find((item)=>item.id==='lent');
  assert.equal(debt.principalSettledMinor,5000);
  assert.equal(debt.principalMinor-debt.principalSettledMinor,15000);
  db.close();
});

test('bill payment corrections reverse and replace atomically, recompute paid totals, and block duplicate corrections',async()=>{
  const {db,adapter}=setup();await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const store=createObligationsStore(async()=>adapter,(task)=>adapter.withTransactionAsync(()=>task(adapter)));
  await store.bill.create({id:'b',ownerId:'u',name:'Power',categoryId:'bills',amountMinor:10000,currency:'PKR',dueDate:'2026-10-31',accountId:'a'});
  await store.bill.recordPayment({id:'p',ownerId:'u',billId:'b',amountMinor:7000,transactionId:'tx-p',idempotencyKey:'pay-p',paidAt:'2026-10-21'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-p','u',70,7000,'Expense','bills','bills','a','2026-10-21','unreviewed']));
  const insertReversal=async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)',['reverse-p','u',70,7000,'Reversal','Obligation correction','correction_reversal','a','2026-10-22','fix','unreviewed','tx-p']);
  const insertReplacement=async(sql,bill,replacement)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-p2','u',replacement.amountMinor/100,replacement.amountMinor,'Expense',bill.categoryId,bill.categoryId,'a',replacement.paidAt,'unreviewed']);
  await store.bill.correctPayment({id:'c1',ownerId:'u',billId:'b',paymentId:'p',reversalTransactionId:'reverse-p',reason:'Wrong amount',replacement:{id:'p2',transactionId:'tx-p2',amountMinor:3000,idempotencyKey:'pay-p2',paidAt:'2026-10-22'}},insertReversal,insertReplacement);
  const bill=(await store.bill.list('u','2026-10-22'))[0];
  assert.equal(bill.paidMinor,3000);assert.equal(bill.status,'partial');
  const history=await store.bill.history('u','b');assert.equal(history.length,2);assert.equal(history.find(x=>x.id==='p').corrected,1);
  await assert.rejects(store.bill.correctPayment({id:'c2',ownerId:'u',billId:'b',paymentId:'p',reversalTransactionId:'reverse-again',reason:'again'},async()=>{},async()=>{}),/already corrected/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,3);
  db.close();
});

test('debt event correction restores principal, replaces cash atomically, and recalculates settlement state',async()=>{
  const {db,adapter}=setup();await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const store=createObligationsStore(async()=>adapter,(task)=>adapter.withTransactionAsync(()=>task(adapter)));
  await store.debt.create({id:'d',ownerId:'u',direction:'borrowed',counterparty:'Family',principalMinor:100000,currency:'PKR',accountId:'a',openedAt:'2026-01-01',transactionId:'tx-borrow',eventId:'e-borrow',idempotencyKey:'borrow'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-borrow','u',1000,100000,'Income','debt_borrowing','debt_borrowing','a','2026-01-01','unreviewed']));
  await store.debt.recordEvent({id:'e-pay',ownerId:'u',debtId:'d',eventType:'principal_repayment',principalMinor:20000,interestMinor:0,accountId:'a',transactionId:'tx-pay',eventDate:'2026-02-01',idempotencyKey:'pay'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-pay','u',200,20000,'Expense','debt_principal_repayment','debt_principal_repayment','a','2026-02-01','unreviewed']));
  const reversal=async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)',['tx-reverse','u',200,20000,'Reversal','Obligation correction','correction_reversal','a','2026-02-02','fix','unreviewed','tx-pay']);
  const replacement=async(sql,event)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-pay2','u',100,10000,'Expense','debt_principal_repayment','debt_principal_repayment','a',event.eventDate,'unreviewed']);
  await store.debt.correctEvent({id:'dc1',ownerId:'u',debtId:'d',eventId:'e-pay',reversalTransactionId:'tx-reverse',reason:'Wrong amount',replacement:{id:'e-pay2',eventType:'principal_repayment',principalMinor:10000,interestMinor:0,accountId:'a',transactionId:'tx-pay2',eventDate:'2026-02-02',idempotencyKey:'pay2'}},reversal,replacement);
  const debt=(await store.debt.list('u'))[0];assert.equal(debt.principalMinor-debt.principalSettledMinor,90000);assert.equal(debt.status,'open');
  assert.equal((await store.debt.history('u','d')).find(x=>x.id==='e-pay').corrected,1);
  await assert.rejects(store.debt.correctEvent({id:'dc2',ownerId:'u',debtId:'d',eventId:'e-pay',reversalTransactionId:'tx-reverse2',reason:'again'},async()=>{},async()=>{}),/already corrected/);
  await assert.rejects(store.debt.recordEvent({id:'partial-settle',ownerId:'u',debtId:'d',eventType:'settlement',principalMinor:89999,interestMinor:0,accountId:'a',transactionId:'tx-partial-settle',eventDate:'2026-03-01',idempotencyKey:'partial-settle'},async()=>{}),/full remaining principal/);
  await store.debt.recordEvent({id:'full-settle',ownerId:'u',debtId:'d',eventType:'settlement',principalMinor:90000,interestMinor:0,accountId:'a',transactionId:'tx-full-settle',eventDate:'2026-03-02',idempotencyKey:'full-settle'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-full-settle','u',900,90000,'Expense','debt_settlement','debt_settlement','a','2026-03-02','unreviewed']));
  assert.equal((await store.debt.list('u'))[0].status,'settled');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,5);
  db.close();
});

test('repayment schedule rows are projections and preserve explicit interest terms',async()=>{
  const {db,adapter}=setup();await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const store=createObligationsStore(async()=>adapter,(task)=>adapter.withTransactionAsync(()=>task(adapter)));
  await store.debt.create({id:'d',ownerId:'u',direction:'borrowed',counterparty:'Family',principalMinor:120000,currency:'PKR',accountId:'a',interestRateBps:1200,openedAt:'2026-01-01',transactionId:'tx-b',eventId:'e-b',idempotencyKey:'b'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-b','u',1200,120000,'Income','debt_borrowing','debt_borrowing','a','2026-01-01','unreviewed']));
  await store.debt.createRepaymentSchedule({id:'plan',ownerId:'u',debtId:'d',frequency:'monthly',firstDueDate:'2024-01-31',installmentAmountMinor:20000,interestMethod:'declining',rateBps:1200,installmentCount:3});
  const schedules=await store.debt.repaymentSchedules('u','2024-02-29');
  assert.deepEqual(schedules[0].installments.map(x=>x.dueDate),['2024-01-31','2024-02-29','2024-03-31']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,1,'projection never posts cash');
  db.close();
});

test('concurrent repayments serialize against outstanding principal and a failed correction fully rolls back',async()=>{
  const {db,adapter}=setup();await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const queue=createLocalWriteQueue();
  const store=createObligationsStore(async()=>adapter,(task)=>queue(async()=>adapter.withTransactionAsync(()=>task(adapter))));
  await store.debt.create({id:'d',ownerId:'u',direction:'borrowed',counterparty:'Family',principalMinor:100000,currency:'PKR',accountId:'a',openedAt:'2026-01-01',transactionId:'tx-open',eventId:'e-open',idempotencyKey:'open'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-open','u',1000,100000,'Income','debt_borrowing','debt_borrowing','a','2026-01-01','unreviewed']));
  const post=(id)=>store.debt.recordEvent({id,ownerId:'u',debtId:'d',eventType:'principal_repayment',principalMinor:60000,interestMinor:0,accountId:'a',transactionId:`tx-${id}`,eventDate:'2026-02-01',idempotencyKey:id},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',[`tx-${id}`,'u',600,60000,'Expense','debt_principal_repayment','debt_principal_repayment','a','2026-02-01','unreviewed']));
  const results=await Promise.allSettled([post('r1'),post('r2')]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.equal((await store.debt.list('u'))[0].principalSettledMinor,60000);

  await store.bill.create({id:'b',ownerId:'u',name:'Rent',categoryId:'bills',amountMinor:10000,currency:'PKR',dueDate:'2026-10-31',accountId:'a'});
  await store.bill.recordPayment({id:'p',ownerId:'u',billId:'b',amountMinor:7000,transactionId:'tx-bill',idempotencyKey:'bill',paidAt:'2026-10-21'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-bill','u',70,7000,'Expense','bills','bills','a','2026-10-21','unreviewed']));
  const reversal=async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)',['tx-bill-reversal','u',70,7000,'Reversal','Obligation correction','correction_reversal','a','2026-10-22','bad replacement','unreviewed','tx-bill']);
  await assert.rejects(store.bill.correctPayment({id:'bill-correction-failed',ownerId:'u',billId:'b',paymentId:'p',reversalTransactionId:'tx-bill-reversal',reason:'Wrong amount',replacement:{id:'p-new',transactionId:'tx-new',amountMinor:10001,idempotencyKey:'new',paidAt:'2026-10-22'}},reversal,async()=>{}),/exceeds/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM BillPaymentCorrection').get().n,0,'reversal and correction metadata roll back with an invalid replacement');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction" WHERE type=\'Reversal\'').get().n,0);
  assert.equal((await store.bill.list('u','2026-10-22'))[0].paidMinor,7000);
  db.close();
});

test('interest accrual is a non-cash debt event, payments cannot exceed accrued interest, and corrections preserve paid history',async()=>{
  const {db,adapter}=setup();await migrateLocalDatabase(adapter);
  db.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  db.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',0,'PKR','2026-01-01');
  const store=createObligationsStore(async()=>adapter,(task)=>adapter.withTransactionAsync(()=>task(adapter)));
  await store.debt.create({id:'d',ownerId:'u',direction:'borrowed',counterparty:'Family',principalMinor:100000,currency:'PKR',accountId:'a',openedAt:'2026-01-01',transactionId:'tx-open',eventId:'e-open',idempotencyKey:'open'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-open','u',1000,100000,'Income','debt_borrowing','debt_borrowing','a','2026-01-01','unreviewed']));
  const charge={id:'charge',ownerId:'u',debtId:'d',amountMinor:10000,eventDate:'2026-02-01',idempotencyKey:'charge-key',note:'Explicit interest'};
  await store.debt.chargeInterest(charge);await store.debt.chargeInterest(charge);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM DebtInterestEvent WHERE eventType=\'charge\'').get().n,1,'repeated charge request is idempotent');
  await store.debt.recordEvent({id:'principal-settlement',ownerId:'u',debtId:'d',eventType:'settlement',principalMinor:100000,interestMinor:0,accountId:'a',transactionId:'tx-principal-settlement',eventDate:'2026-02-01',idempotencyKey:'settlement'},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',['tx-principal-settlement','u',1000,100000,'Expense','debt_settlement','debt_settlement','a','2026-02-01','unreviewed']));
  assert.equal((await store.debt.list('u'))[0].status,'open','unpaid accrued interest keeps the obligation open after principal settles');
  const postInterest=(id,amount)=>store.debt.recordEvent({id,ownerId:'u',debtId:'d',eventType:'interest',principalMinor:0,interestMinor:amount,accountId:'a',transactionId:`tx-${id}`,eventDate:'2026-02-02',idempotencyKey:id},async(sql)=>sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)',[`tx-${id}`,'u',amount/100,amount,'Expense','debt_interest','debt_interest','a','2026-02-02','unreviewed']));
  await postInterest('paid-interest',5000);
  await assert.rejects(postInterest('overpaid-interest',5001),/exceeds interest charged/);
  await assert.rejects(store.debt.correctInterestCharge({id:'c-bad',ownerId:'u',debtId:'d',eventId:'charge',reason:'Wrong charge',replacement:{id:'charge-small',amountMinor:4000,eventDate:'2026-02-01',idempotencyKey:'small'} }),/lower than interest already paid/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM DebtInterestEvent WHERE eventType=\'reversal\'').get().n,0);
  await store.debt.correctInterestCharge({id:'c1',ownerId:'u',debtId:'d',eventId:'charge',reason:'Wrong charge',replacement:{id:'charge-new',amountMinor:7000,eventDate:'2026-02-01',idempotencyKey:'charge-new-key'}});
  const debt=(await store.debt.list('u'))[0];assert.equal(debt.interestAccruedMinor,7000);assert.equal(debt.interestPaidMinor,5000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,3,'interest accrual and its correction do not invent cash entries');
  db.close();
});

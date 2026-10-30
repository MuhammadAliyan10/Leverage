import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocalDatabase } from '../../src/db/local/migrations.ts';
import { createProjectsStore } from '../../src/db/local/projectsStore.ts';

function setup() {
  const database=new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const adapter={
    async execAsync(source){database.exec(source);},
    async runAsync(source,params=[]){return database.prepare(source).run(...params);},
    async getFirstAsync(source,params=[]){return database.prepare(source).get(...params)??null;},
    async getAllAsync(source,params=[]){return database.prepare(source).all(...params);},
    async withTransactionAsync(task){database.exec('BEGIN IMMEDIATE');try{await task();database.exec('COMMIT');}catch(error){database.exec('ROLLBACK');throw error;}},
  };
  return {database,adapter};
}

async function seedUser(adapter) {
  await adapter.runAsync('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)',['owner','Ali','ali@example.test','test','2026-01-01T00:00:00.000Z']);
  const members=[{id:'ali',displayName:'Ali',role:'owner'},{id:'ahmed',displayName:'Ahmed',role:'editor'},{id:'usman',displayName:'Usman',role:'editor'}];
  return members;
}

test('project store records shared expenses and derives exact member balances',async()=>{
  const {database,adapter}=setup();
  try{
    await migrateLocalDatabase(adapter);
    const members=await seedUser(adapter);
    const store=createProjectsStore(adapter,async(work)=>{let result;await adapter.withTransactionAsync(async()=>{result=await work(adapter);});return result;});
    await store.create({id:'trip',ownerId:'owner',name:'Trip',kind:'shared',currency:'PKR',startDate:'2026-10-01',budgetMinor:500_000,members});
    await store.addExpense({id:'meal',ownerId:'owner',projectId:'trip',amountMinor:200_000,currency:'PKR',occurredAt:'2026-10-02T12:00:00.000Z',category:'Food',description:'Dinner',payerMemberId:'ali',fundingSource:'member',splitMethod:'equal',participants:members.map(({id})=>({memberId:id})),recordedByMemberId:'ali'});
    const shares=await adapter.getAllAsync('SELECT memberId,amountMinor FROM ProjectExpenseShare WHERE expenseId=? ORDER BY rowid',['meal']);
    assert.deepEqual(shares.map((row)=>row.amountMinor),[66_666,66_666,66_668]);
    assert.deepEqual((await store.memberBalances('owner','trip')).map(({memberId,balanceMinor})=>[memberId,balanceMinor]),[['ahmed',-66_666],['ali',133_334],['usman',-66_668]]);
    assert.equal((await store.get('owner','trip')).expenseMinor,200_000);
    await store.addRefund({id:'partial-refund',idempotencyKey:'partial-refund-key',ownerId:'owner',projectId:'trip',expenseId:'meal',amountMinor:10_000,currency:'PKR',occurredAt:'2026-10-03T12:00:00.000Z'});
    assert.deepEqual((await store.memberBalances('owner','trip')).map(({memberId,balanceMinor})=>[memberId,balanceMinor]),[['ahmed',-63_332],['ali',126_668],['usman',-63_336]]);
    await store.setCategoryBudget({id:'food-budget',ownerId:'owner',projectId:'trip',category:'Food',amountMinor:100_000,currency:'PKR'});
    assert.deepEqual((await store.categoryBudgets('owner','trip')).map(({category,spentMinor,remainingMinor})=>[category,spentMinor,remainingMinor]),[['Food',190_000,-90_000]]);
    await store.addSettlement({id:'settlement',idempotencyKey:'settlement-key',ownerId:'owner',projectId:'trip',fromMemberId:'ahmed',toMemberId:'ali',amountMinor:10_000,currency:'PKR',occurredAt:'2026-10-03T13:00:00.000Z'});
    await store.addSettlement({id:'settlement',idempotencyKey:'settlement-key',ownerId:'owner',projectId:'trip',fromMemberId:'ahmed',toMemberId:'ali',amountMinor:10_000,currency:'PKR',occurredAt:'2026-10-03T13:00:00.000Z'});
    assert.equal((await store.memberBalances('owner','trip')).find(({memberId})=>memberId==='ahmed')?.balanceMinor,-53_332);
    await assert.rejects(store.addSettlement({id:'over-settlement',idempotencyKey:'over-settlement-key',ownerId:'owner',projectId:'trip',fromMemberId:'ahmed',toMemberId:'ali',amountMinor:100_000,currency:'PKR',occurredAt:'2026-10-03T13:00:00.000Z'}),/exceeds the outstanding balance/);
    await assert.rejects(store.addExpense({id:'bad',ownerId:'owner',projectId:'trip',amountMinor:1,currency:'USD',occurredAt:'2026-10-02T12:00:00.000Z',category:'Food',description:'Invalid currency',payerMemberId:'ali',fundingSource:'member',splitMethod:'equal',participants:[{memberId:'ali'}],recordedByMemberId:'ali'}),/match the project currency/);
  }finally{database.close();}
});

test('a linked personal-account expense is written atomically with the project record and replays idempotently',async()=>{
  const {database,adapter}=setup();
  try{
    await migrateLocalDatabase(adapter);
    const members=await seedUser(adapter);
    await adapter.runAsync('INSERT INTO Account(id,ownerId,name,type,balance,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,?,0)',['wallet','owner','Travel wallet','wallet',50_000,5_000_000,'PKR','2026-10-01']);
    const store=createProjectsStore(adapter,async(work)=>{let result;await adapter.withTransactionAsync(async()=>{result=await work(adapter);});return result;},async(sql,input)=>{
      const transactionId=`project-expense:${input.expenseId}`;
      const existing=await sql.getFirstAsync('SELECT id FROM "Transaction" WHERE id=?',[transactionId]);
      if(!existing)await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,date,note,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)',[transactionId,input.ownerId,input.amountMinor/100,input.amountMinor,'Expense','Other expense','other_expense','other_expense',input.accountId,input.occurredAt,input.description,'unreviewed']);
      return transactionId;
    },()=>{},async(sql,input)=>{
      const transactionId=`project-refund:${input.refundId}`;
      const existing=await sql.getFirstAsync('SELECT id FROM "Transaction" WHERE id=?',[transactionId]);
      if(!existing)await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)',[transactionId,input.ownerId,input.amountMinor/100,input.amountMinor,'Refund','Expense refund','expense_refund','expense_refund',input.accountId,input.occurredAt,input.note??'','unreviewed',input.expenseTransactionId]);
      return transactionId;
    });
    await store.create({id:'trip',ownerId:'owner',name:'Trip',kind:'shared',currency:'PKR',startDate:'2026-10-01',members});
    const expense={id:'linked',ownerId:'owner',projectId:'trip',amountMinor:200_000,currency:'PKR',occurredAt:'2026-10-02T12:00:00.000Z',category:'Food',description:'Lunch',payerMemberId:'ali',fundingSource:'member',splitMethod:'equal',participants:members.map(({id})=>({memberId:id})),recordedByMemberId:'ali',accountId:'wallet'};
    await store.addExpense(expense);
    await store.addExpense(expense);
    assert.equal((await adapter.getFirstAsync('SELECT COUNT(*) AS count FROM "Transaction" WHERE id=?',['project-expense:linked'])).count,1);
    const linked=await adapter.getFirstAsync('SELECT accountId,transactionId FROM ProjectExpense WHERE id=?',['linked']);
    assert.deepEqual({...linked},{accountId:'wallet',transactionId:'project-expense:linked'});
    await assert.rejects(store.addExpense({...expense,description:'Changed details'}),/already used for different financial details/);
    const refund={id:'linked-refund',idempotencyKey:'linked-refund-key',ownerId:'owner',projectId:'trip',expenseId:'linked',amountMinor:10_000,currency:'PKR',occurredAt:'2026-10-03T12:00:00.000Z',note:'Hotel adjustment'};
    await store.addRefund(refund);await store.addRefund(refund);
    assert.equal((await adapter.getFirstAsync('SELECT COUNT(*) AS count FROM "Transaction" WHERE type=\'Refund\'')).count,1);
    assert.equal((await adapter.getFirstAsync('SELECT transactionId FROM ProjectExpenseRefund WHERE id=?',['linked-refund'])).transactionId,'project-refund:linked-refund');
  }finally{database.close();}
});

test('group-fund contributions are capital, while fund spending reduces cash once',async()=>{
  const {database,adapter}=setup();
  try{
    await migrateLocalDatabase(adapter);
    const members=await seedUser(adapter);
    members[0].targetContributionMinor=2_000_000;
    members[1].targetContributionMinor=2_000_000;
    members[2].targetContributionMinor=2_000_000;
    const store=createProjectsStore(adapter,async(work)=>{let result;await adapter.withTransactionAsync(async()=>{result=await work(adapter);});return result;});
    await store.create({id:'trip',ownerId:'owner',name:'Summit trip',kind:'shared',currency:'PKR',startDate:'2026-10-01',budgetMinor:6_000_000,members});
    for(const [member,amountMinor] of members.map((member,index)=>[member,[3_000_000,4_000_000,2_000_000][index]])) {
      const contribution={id:`contrib-${member.id}`,idempotencyKey:`key-${member.id}`,ownerId:'owner',projectId:'trip',memberId:member.id,eventType:'contribution',amountMinor,currency:'PKR',occurredAt:'2026-10-01T00:00:00.000Z'};
      await store.addCashEvent(contribution);
      await store.addCashEvent(contribution);
    }
    await store.setMemberContributionTarget({ownerId:'owner',projectId:'trip',memberId:'ahmed',targetContributionMinor:2_500_000});
    assert.equal((await store.get('owner','trip')).members.find(({id})=>id==='ahmed')?.targetContributionMinor,2_500_000);
    await store.addExpense({id:'hotel',ownerId:'owner',projectId:'trip',amountMinor:2_000_000,currency:'PKR',occurredAt:'2026-10-02T12:00:00.000Z',category:'Accommodation',description:'Two nights hotel',payerMemberId:'ali',fundingSource:'group_fund',splitMethod:'equal',participants:members.map(({id})=>({memberId:id})),recordedByMemberId:'ali'});
    const project=await store.get('owner','trip');
    assert.equal(project.budgetMinor,6_000_000);
    assert.equal(project.contributionMinor,9_000_000);
    assert.equal(project.expenseMinor,2_000_000);
    assert.equal(project.fundBalanceMinor,7_000_000);
    assert.equal(project.remainingBudgetMinor,4_000_000);
    assert.deepEqual(Object.fromEntries((await store.contributionTotals('owner','trip')).map(({memberId,amountMinor})=>[memberId,amountMinor])),{ali:3_000_000,ahmed:4_000_000,usman:2_000_000});
    assert.deepEqual((await adapter.getAllAsync('SELECT amountMinor FROM ProjectExpenseShare WHERE expenseId=? ORDER BY rowid',['hotel'])).map((row)=>row.amountMinor),[666_666,666_666,666_668]);
    assert.deepEqual((await store.memberBalances('owner','trip')).map(({balanceMinor})=>balanceMinor),[0,0,0]);
    await store.addRefund({id:'refund',idempotencyKey:'refund-key',ownerId:'owner',projectId:'trip',expenseId:'hotel',amountMinor:10_000,currency:'PKR',occurredAt:'2026-10-03T12:00:00.000Z'});
    assert.equal((await store.get('owner','trip')).refundMinor,10_000);
    assert.equal((await store.get('owner','trip')).fundBalanceMinor,7_010_000);
    await assert.rejects(store.addRefund({id:'over-refund',idempotencyKey:'over-refund-key',ownerId:'owner',projectId:'trip',expenseId:'hotel',amountMinor:2_000_000,currency:'PKR',occurredAt:'2026-10-03T12:00:00.000Z'}),/cannot exceed/);
    await assert.rejects(store.addExpense({id:'too-much',ownerId:'owner',projectId:'trip',amountMinor:8_000_000,currency:'PKR',occurredAt:'2026-10-03T12:00:00.000Z',category:'Travel',description:'Excessive',payerMemberId:'ali',fundingSource:'group_fund',splitMethod:'equal',participants:[{memberId:'ali'}],recordedByMemberId:'ali'}),/not have enough recorded balance/);
  }finally{database.close();}
});

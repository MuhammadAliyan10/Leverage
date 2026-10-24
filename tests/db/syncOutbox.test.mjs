import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocalDatabase } from '../../src/db/local/migrations.ts';
import { activeCloudUser, computeRetryDelayMs, countLocalFinancialRecords, enqueueCloudMutation, validateCloudChangePage } from '../../src/db/local/syncOutbox.ts';

function adapter(database) {
  return {
    async execAsync(sql) { database.exec(sql); },
    async runAsync(sql, params = []) { database.prepare(sql).run(...params); },
    async getFirstAsync(sql, params = []) { return database.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, params = []) { return database.prepare(sql).all(...params); },
    async withTransactionAsync(task) { database.exec('BEGIN IMMEDIATE'); try { await task(); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; } },
  };
}

async function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  await migrateLocalDatabase(adapter(database));
  database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)')
    .run('local-user','Local User','local@example.test','hash','2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO CloudIdentity(ownerId,cloudUserId,linkedAt,syncEnabled) VALUES(?,?,?,1)')
    .run('local-user','cloud-user','2026-01-02T00:00:00.000Z');
  return { database, sql: adapter(database) };
}

test('sync cursor idempotency uses its actual owner primary key', async () => {
  const { database } = await setup();
  const insertCursor = database.prepare(`INSERT INTO SyncCursor(ownerId,cloudUserId,cursor,lastSuccessfulAt)
    VALUES(?,?, '0', NULL) ON CONFLICT(ownerId) DO NOTHING`);
  insertCursor.run('local-user','cloud-user');
  insertCursor.run('local-user','cloud-user');
  const cursor = database.prepare('SELECT ownerId,cloudUserId,cursor FROM SyncCursor WHERE ownerId=?').get('local-user');
  assert.equal(cursor.ownerId,'local-user');
  assert.equal(cursor.cloudUserId,'cloud-user');
  assert.equal(cursor.cursor,'0');
  database.close();
});

test('local financial row and durable outbox row roll back together', async () => {
  const { database, sql } = await setup();
  database.exec('BEGIN IMMEDIATE');
  try {
    await enqueueCloudMutation(sql, { mutationId:'account-mutation',ownerId:'local-user',cloudUserId:'cloud-user',entityType:'account',entityId:'account-1',operation:'account.create',payload:{id:'account-1'} });
    database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)')
      .run('account-1','local-user','Main','bank',0,'PKR','2026-01-03T00:00:00.000Z');
    await enqueueCloudMutation(sql, { mutationId:'mutation-1',ownerId:'local-user',cloudUserId:'cloud-user',entityType:'transaction',entityId:'tx-1',operation:'transaction.create',payload:{id:'tx-1',amountMinor:'1250'},dependencyEntityId:'account-1' });
    database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)')
      .run('tx-1','local-user',12.5,1250,'Expense','Food','food','account-1','2026-01-04T00:00:00.000Z','Lunch','unreviewed');
    throw new Error('simulated outbox failure after posting');
  } catch {
    database.exec('ROLLBACK');
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM "Transaction"').get().n,0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM SyncOutbox').get().n,0);
  database.close();
});

test('pending financial write and idempotency identity survive closing and reopening SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(),'houselog-outbox-restart-'));
  const path = join(directory,'finance.db');
  let database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA foreign_keys=ON');
    const sql = adapter(database);
    await migrateLocalDatabase(sql);
    database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)')
      .run('local-user','Local User','local@example.test','hash','2026-01-01T00:00:00.000Z');
    database.prepare('INSERT INTO CloudIdentity(ownerId,cloudUserId,linkedAt,syncEnabled) VALUES(?,?,?,1)')
      .run('local-user','cloud-user','2026-01-02T00:00:00.000Z');
    database.exec('BEGIN IMMEDIATE');
    await enqueueCloudMutation(sql, { mutationId:'restart-mutation',ownerId:'local-user',cloudUserId:'cloud-user',entityType:'account',entityId:'restart-account',operation:'account.create',payload:{id:'restart-account'} });
    database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)')
      .run('restart-account','local-user','Main','bank',0,'PKR','2026-01-03T00:00:00.000Z');
    database.exec('COMMIT');
    database.close();

    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=ON');
    assert.equal(database.prepare('SELECT status FROM SyncOutbox WHERE mutationId=?').get('restart-mutation').status,'pending');
    assert.equal(database.prepare('SELECT id FROM Account WHERE ownerId=?').get('local-user').id,'restart-account');
  } finally {
    database.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('outbox keeps stable mutation identity, exact JSON payload, dependency and valid state', async () => {
  const { database, sql } = await setup();
  assert.equal(await activeCloudUser(sql,'local-user'),'cloud-user');
  assert.equal(await activeCloudUser(sql,'other-user'),null);
  assert.throws(() => database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)')
    .run('untracked','local-user','Untracked','bank',0,'PKR','2026-01-04'),/outbox mutation/);
  database.prepare('INSERT INTO Budget(id,ownerId,categoryId,amountMinor,currency,periodStart,periodEnd,rolloverPolicy,revision,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('budget','local-user','food',100,'PKR','2026-01-01','2026-02-01','reset',1,'2026-01-01');
  const budgetMutation = database.prepare('SELECT mutationId,entityType,entityId,operation,payloadJson,status FROM SyncOutbox WHERE entityType=?').get('budget');
  assert.equal(budgetMutation.mutationId,'budget.create:budget');
  assert.equal(budgetMutation.entityType,'budget');
  assert.equal(budgetMutation.entityId,'budget');
  assert.equal(budgetMutation.operation,'budget.create');
  assert.deepEqual(JSON.parse(budgetMutation.payloadJson),{id:'budget',categoryId:'food',amountMinor:'100',currency:'PKR',periodStart:'2026-01-01',periodEnd:'2026-02-01',rolloverPolicy:'reset'});
  assert.equal(budgetMutation.status,'pending');
  database.prepare('UPDATE Budget SET supersededAt=? WHERE id=?').run('2026-01-06','budget');
  database.prepare('INSERT INTO Budget(id,ownerId,categoryId,amountMinor,currency,periodStart,periodEnd,rolloverPolicy,revision,supersedesId,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('budget-revision','local-user','food',200,'PKR','2026-01-01','2026-02-01','carry_unused',2,'budget','2026-01-06');
  const revisionMutation=database.prepare('SELECT mutationId,entityId,operation,payloadJson FROM SyncOutbox WHERE operation=?').get('budget.revise');
  assert.equal(revisionMutation.mutationId,'budget.revise:budget-revision');
  assert.equal(revisionMutation.entityId,'budget-revision');
  assert.deepEqual(JSON.parse(revisionMutation.payloadJson),{budgetId:'budget',expectedRevision:1,categoryId:'food',amountMinor:'200',currency:'PKR',periodStart:'2026-01-01',periodEnd:'2026-02-01',rolloverPolicy:'carry_unused'});
  database.prepare('UPDATE Budget SET archivedAt=? WHERE id=?').run('2026-01-07','budget-revision');
  const archiveMutation=database.prepare('SELECT mutationId,operation,payloadJson FROM SyncOutbox WHERE operation=?').get('budget.archive');
  assert.equal(archiveMutation.mutationId,'budget.archive:budget-revision');
  assert.deepEqual(JSON.parse(archiveMutation.payloadJson),{id:'budget-revision'});
  await enqueueCloudMutation(sql, { mutationId:'mutation-stable',ownerId:'local-user',cloudUserId:'cloud-user',entityType:'account',entityId:'acct-1',operation:'account.create',payload:{id:'acct-1',openingBalanceMinor:'9007199254740991'},now:'2026-01-05T00:00:00.000Z' });
  const row=database.prepare('SELECT mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount FROM SyncOutbox WHERE mutationId=?').get('mutation-stable');
  assert.deepEqual({...row},{mutationId:'mutation-stable',ownerId:'local-user',cloudUserId:'cloud-user',entityType:'account',entityId:'acct-1',operation:'account.create',payloadVersion:1,payloadJson:'{"id":"acct-1","openingBalanceMinor":"9007199254740991"}',status:'pending',attemptCount:0});
  assert.throws(() => database.prepare('UPDATE SyncOutbox SET status=? WHERE mutationId=?').run('other','mutation-stable'),/CHECK constraint failed/);
  database.close();
});

test('change-feed page validation requires contiguous deterministic cursors and exact page bounds', () => {
  const page = [
    { sequence:'1',entityType:'account',entityId:'a',revision:1 },
    { sequence:'2',entityType:'transaction',entityId:'t',revision:1 },
  ];
  assert.doesNotThrow(() => validateCloudChangePage('0','2',page));
  assert.doesNotThrow(() => validateCloudChangePage('2','2',[]));
  assert.throws(() => validateCloudChangePage('0','3',page),/cursor does not match/);
  assert.throws(() => validateCloudChangePage('0','2',[page[1]]),/gap or is out of order/);
  assert.throws(() => validateCloudChangePage('2','3',[page[1]]),/gap or is out of order/);
  assert.throws(() => validateCloudChangePage('0','1',[{...page[0],revision:0}]),/invalid entity metadata/);
});

test('outbox retries use bounded exponential jitter and reject invalid attempts', () => {
  assert.equal(computeRetryDelayMs(1,() => 0),500);
  assert.equal(computeRetryDelayMs(1,() => 1),1500);
  assert.equal(computeRetryDelayMs(20,() => 1),450000);
  assert.throws(() => computeRetryDelayMs(21),/outside the supported range/);
});

test('recurring schedules, bill schedules and occurrence history enqueue stable sync operations', async () => {
  const { database } = await setup();
  const accountId='00000000-0000-4000-8000-000000000001';
  const scheduleId='00000000-0000-4000-8000-000000000002';
  const occurrenceId='00000000-0000-4000-8000-000000000003';
  database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,1)')
    .run(accountId,'local-user','Main','bank',0,'PKR','2026-01-01T00:00:00.000Z');
  database.prepare("INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,'account',?,?,1)")
    .run('local-user',accountId,accountId);
  database.prepare(`INSERT INTO RecurringSchedule(id,ownerId,scheduleType,name,amountMinor,currency,classificationId,accountId,frequency,startDate,nextDueDate,status,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(scheduleId,'local-user','income','Salary',250000,'PKR','salary',accountId,'monthly','2026-01-01','2026-02-01','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  const create=database.prepare("SELECT mutationId,operation,payloadJson FROM SyncOutbox WHERE entityType='recurring_schedule'").get();
  assert.equal(create.mutationId,`recurring.schedule.create:${scheduleId}`);
  assert.equal(create.operation,'recurring.schedule.create');
  assert.equal(JSON.parse(create.payloadJson).amountMinor,'250000');
  database.prepare('UPDATE RecurringSchedule SET name=?,updatedAt=? WHERE id=?').run('Salary updated','2026-01-02T00:00:00.000Z',scheduleId);
  const update=database.prepare("SELECT operation,payloadJson FROM SyncOutbox WHERE entityType='recurring_schedule' AND operation='recurring.schedule.update'").get();
  assert.equal(update.operation,'recurring.schedule.update');
  assert.equal(JSON.parse(update.payloadJson).expectedUpdatedAt,'2026-01-01T00:00:00.000Z');
  database.prepare(`INSERT INTO ScheduleOccurrence(id,ownerId,scheduleId,occurrenceDate,status,createdAt) VALUES(?,?,?,?,?,?)`)
    .run(occurrenceId,'local-user',scheduleId,'2026-02-01','pending','2026-02-01T00:00:00.000Z');
  const occurrenceCreate=database.prepare("SELECT operation,payloadJson FROM SyncOutbox WHERE entityType='schedule_occurrence'").get();
  assert.equal(occurrenceCreate.operation,'schedule.occurrence.create');
  assert.equal(JSON.parse(occurrenceCreate.payloadJson).scheduleId,scheduleId);
  database.prepare("UPDATE ScheduleOccurrence SET status='skipped',resolvedAt=? WHERE id=?").run('2026-02-01T10:00:00.000Z',occurrenceId);
  const resolve=database.prepare("SELECT operation,payloadJson FROM SyncOutbox WHERE entityType='schedule_occurrence' AND operation='schedule.occurrence.resolve'").get();
  assert.equal(resolve.operation,'schedule.occurrence.resolve');
  assert.equal(JSON.parse(resolve.payloadJson).expectedRevision,1);
  database.prepare('INSERT INTO Bill(id,ownerId,name,categoryId,amountMinor,currency,dueDate,accountId,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('bill-template','local-user','Rent','housing',15000,'PKR','2026-01-01',accountId,'upcoming','2026-01-01','2026-01-01');
  database.prepare(`INSERT INTO RecurringSchedule(id,ownerId,scheduleType,name,amountMinor,currency,accountId,billId,frequency,startDate,nextDueDate,status,createdAt,updatedAt)
    VALUES(?,?,'bill',?,100,'PKR',?,?, 'monthly','2026-01-01','2026-02-01','active','2026-01-01','2026-01-01')`)
    .run('bill-schedule','local-user','Rent',accountId,'bill-template');
  const billSchedule=database.prepare("SELECT operation,payloadJson FROM SyncOutbox WHERE entityType='recurring_schedule' AND entityId='bill-schedule'").get();
  assert.equal(billSchedule.operation,'recurring.schedule.create');
  assert.equal(JSON.parse(billSchedule.payloadJson).billId,'bill-template');
  database.close();
});

test('bills, debts, assets and investments enter the existing outbox with linked IDs and immutable history guards', async () => {
  const { database } = await setup();
  const accountId='00000000-0000-4000-8000-000000000101';
  const txId='00000000-0000-4000-8000-000000000102';
  database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,1)')
    .run(accountId,'local-user','Cloud main','bank',50000,'PKR','2026-01-01T00:00:00.000Z');
  database.prepare(`INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(txId,'local-user',1,100,'Expense','Utilities','utilities',accountId,'2026-01-02T00:00:00.000Z','bill', 'not_applicable');
  database.prepare('INSERT INTO Bill(id,ownerId,name,categoryId,amountMinor,currency,dueDate,accountId,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('bill-1','local-user','Power bill','utilities',1000,'PKR','2026-02-01',accountId,'upcoming','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  const bill = database.prepare("SELECT entityType,operation,payloadJson FROM SyncOutbox WHERE entityType='bill'").get();
  assert.equal(bill.operation,'domain.create');
  assert.equal(JSON.parse(bill.payloadJson).data.amountMinor,1000);
  assert.equal(JSON.parse(bill.payloadJson).accountId,accountId);
  database.prepare('INSERT INTO Debt(id,ownerId,direction,counterparty,principalMinor,currency,accountId,interestRateBps,openedAt,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('debt-1','local-user','borrowed','friend',5000,'PKR',accountId,0,'2026-01-01','open','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO Asset(id,ownerId,name,category,currency,purchaseValueMinor,purchaseDate,ownershipBps,notes,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('asset-1','local-user','Laptop','valuable','PKR',10000,'2026-01-01',10000,'','2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO InvestmentPortfolio(id,ownerId,name,currency,cashAccountId,createdAt) VALUES(?,?,?,?,?,?)')
    .run('portfolio-1','local-user','Long term','PKR',accountId,'2026-01-01T00:00:00.000Z');
  const records = database.prepare("SELECT entityType,payloadJson FROM SyncOutbox WHERE operation='domain.create' ORDER BY entityType").all();
  assert.deepEqual(records.map((row) => row.entityType),['asset','bill','debt','investment_portfolio']);
  const portfolio = JSON.parse(records.find((row) => row.entityType==='investment_portfolio').payloadJson);
  assert.equal(portfolio.accountId,accountId);
  assert.throws(() => database.prepare('UPDATE Asset SET notes=? WHERE id=?').run('overwritten','asset-1'),/cannot be overwritten/);
  database.prepare('INSERT INTO Bill(id,ownerId,name,categoryId,amountMinor,currency,dueDate,accountId,status,createdAt,updatedAt,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)')
    .run('bill-remote','local-user','Remote bill','utilities',500,'PKR','2026-03-01',accountId,'upcoming','2026-01-01','2026-01-01');
  database.prepare("UPDATE Bill SET status='due',updatedAt=? WHERE id=?").run('2026-01-02','bill-remote');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM SyncOutbox WHERE entityId='bill-remote'").get().n,0,'pull application does not echo back to the cloud');
  database.close();
});

test('empty-profile linking guard counts schedules and asset history, not only core ledger rows', async () => {
  const { database, sql } = await setup();
  database.prepare('DELETE FROM SyncCursor WHERE ownerId=?').run('local-user');
  database.prepare('DELETE FROM CloudIdentity WHERE ownerId=?').run('local-user');
  assert.equal(await countLocalFinancialRecords(sql,'local-user'),0);
  database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)')
    .run('asset-cash','local-user','Cash','cash',0,'PKR','2026-01-03T00:00:00.000Z');
  database.prepare(`INSERT INTO RecurringSchedule(id,ownerId,scheduleType,name,amountMinor,currency,accountId,frequency,startDate,nextDueDate,status,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('schedule','local-user','income','Monthly salary',10000,'PKR','asset-cash','monthly','2026-01-01','2026-02-01','active','2026-01-01','2026-01-01');
  assert.equal(await countLocalFinancialRecords(sql,'local-user'),2);
  database.prepare(`INSERT INTO Asset(id,ownerId,name,category,currency,purchaseValueMinor,purchaseDate,ownershipBps,notes,createdAt)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('asset','local-user','Laptop','valuable','PKR',100000,'2026-01-01',10000,'','2026-01-01');
  database.prepare(`INSERT INTO AssetValuation(id,ownerId,assetId,valueMinor,valuationDate,source,idempotencyKey,createdAt)
    VALUES(?,?,?,?,?,?,?,?)`).run('valuation','local-user','asset',90000,'2026-02-01','estimate','valuation-key','2026-02-01');
  assert.equal(await countLocalFinancialRecords(sql,'local-user'),4);
  assert.equal(await countLocalFinancialRecords(sql,'another-user'),0);
  database.close();
});

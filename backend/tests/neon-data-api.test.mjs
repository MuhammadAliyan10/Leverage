import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = await PGlite.create();
await db.exec(`CREATE ROLE anonymous; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA neon_auth;
  CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.neon_user_id',true),'') $$;
  CREATE TABLE neon_auth."user" (id text PRIMARY KEY,email text,name text);
  INSERT INTO neon_auth."user" VALUES ('neon-user-1','one@example.invalid','One'),('neon-user-2','two@example.invalid','Two');`);
const root = resolve(project, 'prisma/migrations');
for (const folder of (await readdir(root, { withFileTypes: true })).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
  await db.exec(await readFile(resolve(root, folder, 'migration.sql'), 'utf8'));
}

async function rpc(operation, id, payload, key) {
  const result = await db.query('SELECT public.mizan_apply_mutation($1,$2,$3::jsonb,$4) AS result', [operation, id, JSON.stringify(payload), key]);
  return result.rows[0].result;
}

test('Neon RPC bridge posts accounts and transactions atomically with idempotent receipts and ordered changes', async () => {
  await db.query("SELECT set_config('test.neon_user_id','neon-user-1',false)");
  const accountId = '11111111-1111-4111-8111-111111111111';
  const account = { id: accountId, name: 'Main bank', type: 'bank', currency: 'PKR', openingBalanceMinor: '100000' };
  const created = await rpc('account.create', accountId, account, 'account-create-one');
  assert.equal(created.data.id, accountId);
  assert.equal((await rpc('account.create', accountId, account, 'account-create-one')).data.id, accountId);
  await assert.rejects(rpc('account.create', accountId, { ...account, name: 'Changed payload' }, 'account-create-one'), /idempotency key reused/);

  const expenseId = '22222222-2222-4222-8222-222222222222';
  const expense = { id: expenseId, type: 'expense', amountMinor: '2500', currency: 'PKR', classificationId: 'food', categoryLabel: 'Food', accountId, occurredAt: '2026-10-24T10:00:00.000Z', taxStatus: 'unreviewed' };
  assert.equal((await rpc('transaction.create', expenseId, expense, 'expense-create-one')).data.id, expenseId);
  const changes = await db.query('SELECT public.mizan_sync_changes(0,1) AS result');
  assert.equal(changes.rows[0].result.data.length, 1);
  assert.equal(changes.rows[0].result.nextCursor, '1');
  assert.equal(changes.rows[0].result.hasMore, true);

  await db.query("SELECT set_config('test.neon_user_id','neon-user-2',false)");
  const otherIdentity = (await db.query('SELECT public.mizan_sync_identity() AS result')).rows[0].result;
  assert.equal(otherIdentity.userId, 'neon-user-2');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM public."FinanceAccount" WHERE "userId"='neon-user-1'`)).rows[0].n, 1);
});

test('Neon transaction RPC preserves transfer, partial-refund, and correction constraints', async () => {
  await db.query("SELECT set_config('test.neon_user_id','neon-user-1',false)");
  const accountId = '11111111-1111-4111-8111-111111111111';
  const secondId = '33333333-3333-4333-8333-333333333333';
  await rpc('account.create', secondId, { id: secondId, name: 'Savings', type: 'savings', currency: 'PKR', openingBalanceMinor: '0' }, 'account-create-two');
  const transferId = '44444444-4444-4444-8444-444444444444';
  await rpc('transaction.create', transferId, { id: transferId, type: 'transfer', amountMinor: '500', currency: 'PKR', classificationId: 'internal_transfer', categoryLabel: 'Internal transfer', accountId, toAccountId: secondId, occurredAt: '2026-10-24T11:00:00.000Z', taxStatus: 'not_applicable' }, 'transfer-1');

  const refundOneId = '55555555-5555-4555-8555-555555555555';
  const refundTwoId = '66666666-6666-4666-8666-666666666666';
  for (const [id,key] of [[refundOneId,'refund-1'],[refundTwoId,'refund-2']]) {
    await rpc('transaction.create', id, { id, type: 'refund', amountMinor: '1000', currency: 'PKR', classificationId: 'expense_refund', categoryLabel: 'Expense refund', accountId, refundOfId: '22222222-2222-4222-8222-222222222222', occurredAt: '2026-10-24T12:00:00.000Z', taxStatus: 'not_applicable' }, key);
  }
  await assert.rejects(rpc('transaction.create', '77777777-7777-4777-8777-777777777777', { id: '77777777-7777-4777-8777-777777777777', type: 'refund', amountMinor: '501', currency: 'PKR', classificationId: 'expense_refund', categoryLabel: 'Expense refund', accountId, refundOfId: '22222222-2222-4222-8222-222222222222', occurredAt: '2026-10-24T13:00:00.000Z', taxStatus: 'not_applicable' }, 'refund-overflow'), /refund exceeds/);

  const incomeId = '88888888-8888-4888-8888-888888888888';
  await rpc('transaction.create', incomeId, { id: incomeId, type: 'income', amountMinor: '9000', currency: 'PKR', classificationId: 'salary', categoryLabel: 'Salary', accountId, occurredAt: '2026-10-24T14:00:00.000Z', taxStatus: 'taxable' }, 'income-1');
  const reversalId = '99999999-9999-4999-8999-999999999999';
  await rpc('transaction.create', reversalId, { id: reversalId, type: 'reversal', amountMinor: '9000', currency: 'PKR', classificationId: 'correction_reversal', categoryLabel: 'Correction reversal', accountId, reversalOfId: incomeId, occurredAt: '2026-10-24T14:01:00.000Z', taxStatus: 'not_applicable' }, 'reversal-1');
  const replacementId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await rpc('transaction.create', replacementId, { id: replacementId, type: 'income', amountMinor: '9500', currency: 'PKR', classificationId: 'salary', categoryLabel: 'Salary', accountId, correctionOfId: incomeId, occurredAt: '2026-10-24T14:02:00.000Z', taxStatus: 'taxable' }, 'replacement-1');

  const sums = await db.query(`SELECT
    (SELECT count(*)::int FROM public."FinanceTransaction" WHERE "userId"='neon-user-1' AND type='refund') AS refunds,
    (SELECT count(*)::int FROM public."FinanceTransaction" WHERE "userId"='neon-user-1' AND type='transfer') AS transfers,
    (SELECT count(*)::int FROM public."FinanceTransaction" WHERE "userId"='neon-user-1' AND "correctionOfId"=$1) AS replacements`, [incomeId]);
  assert.deepEqual(sums.rows[0], { refunds: 2, transfers: 1, replacements: 1 });
});

test('Neon RPC persists budgets, savings, emergency funds, and recurring schedule history', async () => {
  await db.query("SELECT set_config('test.neon_user_id','neon-user-1',false)");
  const accountId = '11111111-1111-4111-8111-111111111111';
  const budgetId = 'b1111111-1111-4111-8111-111111111111';
  const budget = { id: budgetId, categoryId: 'food', amountMinor: '50000', currency: 'PKR', periodStart: '2026-10-01', periodEnd: '2026-11-01', rolloverPolicy: 'reset' };
  assert.equal((await rpc('budget.create', budgetId, budget, 'budget-create')).data.revision, 1);
  const revisedBudgetId = 'b2222222-2222-4222-8222-222222222222';
  const revised = await rpc('budget.revise', budgetId, { ...budget, id: revisedBudgetId, budgetId, expectedRevision: 1, amountMinor: '60000' }, 'budget-revise');
  assert.equal(revised.data.supersedesId, budgetId);
  assert.equal(revised.data.revision, 2);
  const archived = await rpc('budget.archive', revisedBudgetId, { id: revisedBudgetId }, 'budget-archive');
  assert.ok(archived.data.archivedAt);

  const goalId = 'c1111111-1111-4111-8111-111111111111';
  const goal = await rpc('saving.goal.create', goalId, { id: goalId, name: 'Emergency cushion', targetMinor: '250000', currency: 'PKR', targetDate: '2027-01-01', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' }, 'goal-create');
  assert.equal(goal.data.id, goalId);
  await rpc('saving.goal.event', 'c2222222-2222-4222-8222-222222222222', { id: 'c2222222-2222-4222-8222-222222222222', goalId, eventType: 'planned', amountMinor: '10000', currency: 'PKR', idempotencyKey: 'plan-1', eventDate: '2026-10-24T00:00:00Z', note: 'monthly plan' }, 'goal-event');
  await rpc('emergency.config.save', null, { currency: 'PKR', coverageMonths: 3, essentialMonthlyMinor: '80000' }, 'emergency-config');
  await rpc('emergency.event', 'd2222222-2222-4222-8222-222222222222', { id: 'd2222222-2222-4222-8222-222222222222', eventType: 'allocate', amountMinor: '1000', currency: 'PKR', accountId, idempotencyKey: 'ef-allocate-1', eventDate: '2026-10-24T00:00:00Z', note: 'reserve' }, 'emergency-event');

  const scheduleId = 'monthly-rent';
  const schedule = await rpc('recurring.schedule.create', scheduleId, { id: scheduleId, scheduleType: 'expense', name: 'Rent', amountMinor: '15000', currency: 'PKR', classificationId: 'housing', accountId, frequency: 'monthly', startDate: '2026-10-01', nextDueDate: '2026-11-01', status: 'active', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' }, 'schedule-create');
  assert.equal(schedule.data.id, scheduleId);
  const occurrenceId = 'monthly-rent:2026-11-01';
  const occurrence = await rpc('schedule.occurrence.create', scheduleId, { id: occurrenceId, scheduleId, occurrenceDate: '2026-11-01', status: 'pending', createdAt: '2026-10-24T00:00:00Z' }, 'occurrence-create');
  assert.equal(occurrence.data.status, 'pending');
  const resolved = await rpc('schedule.occurrence.resolve', occurrenceId, { id: occurrenceId, scheduleId, status: 'skipped', resolvedAt: '2026-10-24T01:00:00Z', expectedRevision: 1 }, 'occurrence-resolve');
  assert.equal(resolved.data.status, 'skipped');

  const types = await db.query(`SELECT "entityType",count(*)::int AS n FROM public."ChangeLog" WHERE "userId"='neon-user-1' GROUP BY "entityType"`);
  const totals = Object.fromEntries(types.rows.map((row) => [row.entityType, row.n]));
  assert.equal(totals.budget, 3);
  assert.equal(totals.savings_goal, 1);
  assert.equal(totals.emergency_config, 1);
  assert.equal(totals.recurring_schedule, 1);
  assert.equal(totals.schedule_occurrence, 2);
});

test('Neon RPC synchronizes obligations, assets and investments with owner-scoped linked records and replay safety', async () => {
  await db.query("SELECT set_config('test.neon_user_id','neon-user-1',false)");
  const accountId='11111111-1111-4111-8111-111111111111';
  const billId='e1111111-1111-4111-8111-111111111111';
  const bill={entityType:'bill',id:billId,parentType:null,parentId:null,accountId,transactionId:null,scheduleId:null,data:{id:billId,name:'Power',categoryId:'utilities',amountMinor:'5000',currency:'PKR',dueDate:'2026-11-01',accountId,status:'upcoming'}};
  const billResult=await rpc('domain.create',billId,bill,'domain-bill-create');
  assert.equal(billResult.data.entityType,'bill');
  assert.equal((await rpc('domain.create',billId,bill,'domain-bill-create')).data.id,billId);
  const scheduleId='monthly-power-bill';
  const billSchedule=await rpc('recurring.schedule.create',scheduleId,{id:scheduleId,scheduleType:'bill',name:'Monthly power',amountMinor:'5000',currency:'PKR',classificationId:null,accountId,toAccountId:null,billId,frequency:'monthly',startDate:'2026-10-01',endDate:null,nextDueDate:'2026-11-01',status:'active',createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z'},'bill-schedule-create');
  assert.equal(billSchedule.data.billId,billId);

  const paymentId='e2222222-2222-4222-8222-222222222222';
  const paymentTx='e7777777-7777-4777-8777-777777777777';
  await rpc('transaction.create',paymentTx,{id:paymentTx,type:'expense',amountMinor:'1000',currency:'PKR',classificationId:'utilities',categoryLabel:'Utilities',accountId,occurredAt:'2026-10-24T00:00:00Z',taxStatus:'not_applicable'},'domain-bill-cash-tx');
  const payment={entityType:'bill_payment',id:paymentId,parentType:'bill',parentId:billId,accountId,transactionId:paymentTx,scheduleId:null,data:{id:paymentId,billId,amountMinor:'1000',transactionId:paymentTx,paidAt:'2026-10-24T00:00:00Z',idempotencyKey:'bill-pay-1'}};
  await rpc('domain.create',paymentId,payment,'domain-bill-payment');
  const assetId='e3333333-3333-4333-8333-333333333333';
  await rpc('domain.create',assetId,{entityType:'asset',id:assetId,parentType:null,parentId:null,accountId:null,transactionId:null,scheduleId:null,data:{id:assetId,name:'Laptop',category:'valuable',currency:'PKR',purchaseValueMinor:'8000000',ownershipBps:10000}},'domain-asset-create');
  const valuationId='e4444444-4444-4444-8444-444444444444';
  await rpc('domain.create',valuationId,{entityType:'asset_valuation',id:valuationId,parentType:'asset',parentId:assetId,accountId:null,transactionId:null,scheduleId:null,data:{id:valuationId,assetId,valueMinor:'7000000',valuationDate:'2026-10-24',source:'manual',idempotencyKey:'valuation-1'}},'domain-asset-valuation');
  const portfolioId='e5555555-5555-4555-8555-555555555555';
  await rpc('domain.create',portfolioId,{entityType:'investment_portfolio',id:portfolioId,parentType:null,parentId:null,accountId,data:{id:portfolioId,name:'Portfolio',currency:'PKR',cashAccountId:accountId}},'domain-portfolio-create');
  const holdingId='e6666666-6666-4666-8666-666666666666';
  await rpc('domain.create',holdingId,{entityType:'investment_holding',id:holdingId,parentType:'investment_portfolio',parentId:portfolioId,accountId:null,transactionId:null,scheduleId:null,data:{id:holdingId,portfolioId,symbol:'ABC',name:'Example',category:'stock',currency:'PKR'}},'domain-holding-create');

  const rows=await db.query(`SELECT "entityType",count(*)::int AS n FROM public."FinanceDomainRecord" WHERE "userId"='neon-user-1' GROUP BY "entityType" ORDER BY "entityType"`);
  assert.deepEqual(rows.rows.map((row)=>[row.entityType,row.n]),[['asset',1],['asset_valuation',1],['bill',1],['bill_payment',1],['investment_holding',1],['investment_portfolio',1]]);
  await db.query("SELECT set_config('test.neon_user_id','neon-user-2',false)");
  await assert.rejects(rpc('domain.create','cross-owner',{entityType:'asset_valuation',id:'cross-owner',parentType:'asset',parentId:assetId,accountId:null,transactionId:null,scheduleId:null,data:{id:'cross-owner',assetId,valueMinor:'1',valuationDate:'2026-10-24',source:'manual',idempotencyKey:'x'}},'cross-owner-domain'),/foreign key|violates/);
  await db.query("SELECT set_config('test.neon_user_id','neon-user-1',false)");
  const feed=await db.query(`SELECT public.mizan_sync_changes(0,500) AS result`);
  assert.ok(feed.rows[0].result.data.some((entry)=>entry.entityType==='bill_payment'&&entry.payload.id===paymentId));
});

test.after(async () => { await db.close(); });

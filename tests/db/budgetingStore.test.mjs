import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetingStore } from '../../src/db/local/budgetingStore.ts';
import { migrateLocalDatabase } from '../../src/db/local/migrations.ts';
import { createLocalWriteQueue } from '../../src/db/local/writeQueue.ts';

function createDatabase(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON');
  const adapter = {
    async execAsync(source) { database.exec(source); },
    async runAsync(source, params = []) { return database.prepare(source).run(...params); },
    async getFirstAsync(source, params = []) { return database.prepare(source).get(...params) ?? null; },
    async getAllAsync(source, params = []) { return database.prepare(source).all(...params); },
    async withTransactionAsync(task) {
      database.exec('BEGIN IMMEDIATE');
      try { await task(); database.exec('COMMIT'); }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  return { database, adapter };
}

async function makeStore(path = ':memory:') {
  const { database, adapter } = createDatabase(path);
  await migrateLocalDatabase(adapter);
  database.prepare('INSERT INTO User (id, fullName, email, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'Test User', 'test@example.test', 'synthetic', '2026-01-01T00:00:00.000Z');
  const insertAccount = database.prepare(`INSERT INTO Account
    (id, ownerId, name, type, balanceMinor, currency, createdAt, synced) VALUES (?, 'u1', ?, 'bank', ?, 'PKR', ?, 0)`);
  insertAccount.run('spend', 'Spending', 100000, '2026-01-01T00:00:00.000Z');
  insertAccount.run('save', 'Savings', 0, '2026-01-01T00:00:00.000Z');

  const runQueue = createLocalWriteQueue();
  const asSql = (db) => ({
    async getFirstAsync(sql, params = []) { return db.getFirstAsync(sql, [...params]); },
    async getAllAsync(sql, params = []) { return db.getAllAsync(sql, [...params]); },
    async runAsync(sql, params = []) { return db.runAsync(sql, [...params]); },
  });
  const store = createBudgetingStore(async () => asSql(adapter), (task) => runQueue(async () => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = await task(asSql(adapter)); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }));
  return { database, store };
}

test('budget revisions are immutable, profile-scoped, idempotent, and historied', async () => {
  const { database, store } = await makeStore();
  const initial = {
    id: 'budget-rev-1', ownerId: 'u1', categoryId: 'food', amountMinor: 25000, currency: 'PKR',
    periodStart: '2026-05-01', periodEnd: '2026-06-01', rolloverPolicy: 'carry_unused',
  };
  const first = await store.budget.save(initial);
  assert.equal((await store.budget.save(initial)).id, first.id, 'repeated stable IDs do not duplicate definitions');
  const edited = await store.budget.save({ ...initial, id: 'budget-rev-2', amountMinor: 30000, replacesBudgetId: first.id });
  assert.equal(edited.revision, 2);
  assert.equal(edited.supersedesId, first.id);
  assert.equal((await store.budget.list('u1', '2026-05-01')).length, 1);
  assert.equal((await store.budget.list('u1', '2026-05-01', true)).length, 2);
  assert.equal((await store.budget.list('other')).length, 0);
  await assert.rejects(() => store.budget.save({ ...initial, id: 'cross-profile', ownerId: 'other' }), /profile|UNIQUE|owner/i);
  await store.budget.archive('u1', edited.id);
  assert.equal((await store.budget.list('u1', '2026-05-01')).length, 0);
  await assert.rejects(() => store.budget.deleteUnused('u1', edited.id), /history exists/);

  const unused = await store.budget.save({ ...initial, id: 'future-budget', periodStart: '2027-01-01', periodEnd: '2027-02-01' });
  await store.budget.deleteUnused('u1', unused.id);
  assert.equal((await store.budget.list('u1', '2027-01-01')).length, 0);
  database.close();
});

test('budget rollover calculates complete-period actuals and carries unused category amounts atomically', async () => {
  const { database, store } = await makeStore();
  await store.budget.save({ id: 'may-food', ownerId: 'u1', categoryId: 'food', amountMinor: 20000,
    currency: 'PKR', periodStart: '2026-05-01', periodEnd: '2026-06-01', rolloverPolicy: 'carry_unused' });
  database.prepare(`INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId,
    classificationId, accountId, date, note, taxStatus, synced)
    VALUES ('expense', 'u1', 50, 5000, 'Expense', 'Food', 'food', 'food', 'spend', '2026-05-15T12:00:00.000Z', '', 'unreviewed', 0)`).run();
  const result = await store.budget.rollover({ ownerId: 'u1', sourcePeriodStart: '2026-05-01',
    targetPeriodStart: '2026-06-01', requestId: 'rollover-1', policy: 'carry_unused' });
  assert.equal(result.length, 1);
  assert.equal(result[0].amountMinor, 35000);
  assert.equal(result[0].periodStart, '2026-06-01');
  const replay = await store.budget.rollover({ ownerId: 'u1', sourcePeriodStart: '2026-05-01',
    targetPeriodStart: '2026-06-01', requestId: 'rollover-1', policy: 'carry_unused' });
  assert.equal(replay[0].id, result[0].id);
  database.close();
});

test('savings plans do not count as saved money; earmarks and transfers are distinct, idempotent ledger events', async () => {
  const { database, store } = await makeStore();
  await store.savings.save({ id: 'goal', ownerId: 'u1', name: 'Laptop', targetMinor: 60000, currency: 'PKR', targetDate: '2026-12-31' });
  await store.savings.addEvent({ id: 'planned', ownerId: 'u1', goalId: 'goal', eventType: 'planned', amountMinor: 5000, eventDate: '2026-05-01T00:00:00.000Z' });
  let goal = (await store.savings.goals('u1'))[0];
  assert.equal(goal.actualMinor, 0);
  assert.equal(goal.plannedMinor, 5000);

  await store.savings.addEvent({ id: 'earmark', ownerId: 'u1', goalId: 'goal', eventType: 'allocate', amountMinor: 20000, accountId: 'spend', eventDate: '2026-05-02T00:00:00.000Z' });
  await assert.rejects(() => store.savings.addEvent({ id: 'earmark', ownerId: 'u1', goalId: 'goal', eventType: 'allocate', amountMinor: 20000, accountId: 'spend', eventDate: '2026-05-02T00:00:00.000Z', note: 'changed' }), /different details/);
  await store.savings.addEvent({ id: 'earmark', ownerId: 'u1', goalId: 'goal', eventType: 'allocate', amountMinor: 20000, accountId: 'spend', eventDate: '2026-05-02T00:00:00.000Z' });
  await assert.rejects(() => store.savings.addEvent({ id: 'double-allocate', ownerId: 'u1', goalId: 'goal', eventType: 'allocate', amountMinor: 80001, accountId: 'spend', eventDate: '2026-05-02T00:00:00.000Z' }), /not enough unallocated/);
  const sql = {
    getFirstAsync: async (sql, params = []) => database.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => database.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => database.prepare(sql).run(...params),
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, category, categoryId, classificationId, accountId, date, note, taxStatus, synced)
      VALUES ('blocked-expense', 'u1', 800.01, 80001, 'Expense', 'Food', 'food', 'food', 'spend', '2026-05-02', '', 'unreviewed', 0)`).run();
    await assert.rejects(() => store.validatePostTransaction(sql, 'u1', 'spend'), /would spend money/);
    database.exec('ROLLBACK');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 0);
  assert.equal(database.prepare('SELECT balanceMinor FROM Account WHERE id = ?').get('spend').balanceMinor, 100000);

  await store.savings.addEvent({ id: 'transfer-in', ownerId: 'u1', goalId: 'goal', eventType: 'transfer_in', amountMinor: 10000,
    sourceAccountId: 'spend', destinationAccountId: 'save', eventDate: '2026-05-03T00:00:00.000Z', note: 'Monthly saving' });
  await store.savings.addEvent({ id: 'transfer-in', ownerId: 'u1', goalId: 'goal', eventType: 'transfer_in', amountMinor: 10000,
    sourceAccountId: 'spend', destinationAccountId: 'save', eventDate: '2026-05-03T00:00:00.000Z', note: 'Monthly saving' });
  goal = (await store.savings.goals('u1'))[0];
  assert.equal(goal.actualMinor, 30000);
  assert.equal(goal.plannedMinor, 5000);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction" WHERE type = ?').get('Transfer').count, 1);
  assert.equal((await store.savings.history('u1', 'goal')).length, 3);

  await store.savings.addEvent({ id: 'withdrawal', ownerId: 'u1', goalId: 'goal', eventType: 'transfer_out', amountMinor: 5000,
    sourceAccountId: 'save', destinationAccountId: 'spend', eventDate: '2026-05-04T00:00:00.000Z' });
  goal = (await store.savings.goals('u1'))[0];
  assert.equal(goal.actualMinor, 25000);
  await store.savings.save({ id: 'goal', ownerId: 'u1', name: 'Laptop', targetMinor: 25000, currency: 'PKR', targetDate: null });
  await store.savings.setStatus('u1', 'goal', 'completed');
  await assert.rejects(() => store.savings.save({ id: 'goal', ownerId: 'u1', name: 'Changed', targetMinor: 25000, currency: 'PKR', targetDate: null }), /Only active/);
  await store.savings.addEvent({ id: 'completed-release', ownerId: 'u1', goalId: 'goal', eventType: 'release', amountMinor: 5000,
    accountId: 'save', eventDate: '2026-05-05T00:00:00.000Z' });
  goal = (await store.savings.goals('u1'))[0];
  assert.equal(goal.status, 'active', 'a withdrawal below target reopens a previously completed goal');
  await store.savings.setStatus('u1', 'goal', 'archived');
  await store.savings.addEvent({ id: 'archived-release', ownerId: 'u1', goalId: 'goal', eventType: 'release', amountMinor: 20000,
    accountId: 'spend', eventDate: '2026-05-06T00:00:00.000Z' });
  assert.equal((await store.savings.goals('u1'))[0].actualMinor, 0, 'archived goals can release prior earmarks');
  database.close();
});

test('emergency-fund setup and allocations are currency-scoped and cannot double-count goal earmarks', async () => {
  const { database, store } = await makeStore();
  await store.savings.save({ id: 'goal', ownerId: 'u1', name: 'Laptop', targetMinor: 50000, currency: 'PKR', targetDate: null });
  await store.savings.addEvent({ id: 'goal-allocation', ownerId: 'u1', goalId: 'goal', eventType: 'allocate', amountMinor: 60000, accountId: 'spend', eventDate: '2026-05-01T00:00:00.000Z' });
  await store.emergency.saveConfig({ ownerId: 'u1', currency: 'PKR', coverageMonths: 6, essentialMonthlyMinor: 12000 });
  await assert.rejects(() => store.emergency.addEvent({ id: 'overlap', ownerId: 'u1', eventType: 'allocate', amountMinor: 40001,
    accountId: 'spend', eventDate: '2026-05-01T00:00:00.000Z' }), /not enough unallocated/);
  await store.emergency.addEvent({ id: 'emergency-allocation', ownerId: 'u1', eventType: 'allocate', amountMinor: 40000,
    accountId: 'spend', eventDate: '2026-05-01T00:00:00.000Z' });
  await assert.rejects(() => store.emergency.addEvent({ id: 'emergency-allocation', ownerId: 'u1', eventType: 'allocate', amountMinor: 40000,
    accountId: 'spend', eventDate: '2026-05-01T00:00:00.000Z', note: 'different request' }), /different details/);
  const record = await store.emergency.get('u1');
  assert.deepEqual({ requiredMinor: record.requiredMinor, allocatedMinor: record.allocatedMinor, remainingMinor: record.remainingMinor, coverageMonthsActual: record.coverageMonthsActual },
    { requiredMinor: 72000, allocatedMinor: 40000, remainingMinor: 32000, coverageMonthsActual: 3.33 });
  assert.equal((await store.emergency.history('u1')).length, 1);
  database.close();
});

test('concurrent earmarks serialize, failed event writes roll back transfers, and history survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'houselog-budget-persistence-'));
  const path = join(directory, 'synthetic.sqlite');
  try {
    const { database, store } = await makeStore(path);
    await store.savings.save({ id: 'goal', ownerId: 'u1', name: 'Trip', targetMinor: 50000, currency: 'PKR', targetDate: null });
    const requests = Array.from({ length: 10 }, (_, index) => store.savings.addEvent({
      id: `parallel-${index}`, ownerId: 'u1', goalId: 'goal', eventType: 'allocate', amountMinor: 10000,
      accountId: 'spend', eventDate: '2026-05-01T00:00:00.000Z',
    }));
    await Promise.all(requests);
    await assert.rejects(() => store.savings.addEvent({ id: 'excess', ownerId: 'u1', goalId: 'goal', eventType: 'allocate',
      amountMinor: 1, accountId: 'spend', eventDate: '2026-05-01T00:00:00.000Z' }), /not enough unallocated/);
    assert.equal((await store.savings.goals('u1'))[0].actualMinor, 100000);

    database.prepare(`INSERT INTO SavingsGoalEvent (id, ownerId, goalId, eventType, amountMinor, currency, idempotencyKey, eventDate, note, createdAt)
      VALUES ('planned-collision', 'u1', 'goal', 'planned', 100, 'PKR', 'collision', '2026-05-01T00:00:00.000Z', '', '2026-05-01T00:00:00.000Z')`).run();
    database.prepare('UPDATE Account SET balanceMinor = 1000 WHERE id = ?').run('save');
    await assert.rejects(() => store.savings.addEvent({ id: 'collision', ownerId: 'u1', goalId: 'goal', eventType: 'transfer_in', amountMinor: 100,
      sourceAccountId: 'save', destinationAccountId: 'spend', eventDate: '2026-05-02T00:00:00.000Z' }), /UNIQUE constraint/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 0);
    database.close();

    const reopened = createDatabase(path);
    const readOnly = createBudgetingStore(async () => ({
      getFirstAsync: async (sql, params = []) => reopened.adapter.getFirstAsync(sql, params),
      getAllAsync: async (sql, params = []) => reopened.adapter.getAllAsync(sql, params),
      runAsync: async (sql, params = []) => reopened.adapter.runAsync(sql, params),
    }), async () => { throw new Error('This test only reads after restart.'); });
    assert.equal((await readOnly.savings.goals('u1'))[0].actualMinor, 100000);
    assert.equal((await readOnly.savings.history('u1', 'goal')).length, 11);
    assert.equal(reopened.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    reopened.database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

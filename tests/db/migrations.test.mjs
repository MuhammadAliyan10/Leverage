import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_DATABASE_VERSION, migrateLocalDatabase } from '../../src/db/local/migrations.ts';

function migrationAdapter(database) {
  return {
    async execAsync(source) { database.exec(source); },
    async runAsync(source, params = []) { database.prepare(source).run(...params); },
    async getFirstAsync(source, params = []) { return database.prepare(source).get(...params) ?? null; },
    async getAllAsync(source, params = []) { return database.prepare(source).all(...params); },
    async withTransactionAsync(task) {
      database.exec('BEGIN IMMEDIATE');
      try {
        await task();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function createReleasedSchema(databasePath = ':memory:') {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE Account (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Bank',
      balance REAL NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      synced BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE TABLE "Transaction" (
      id TEXT PRIMARY KEY NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL DEFAULT 'Expense',
      category TEXT NOT NULL,
      accountId TEXT,
      note TEXT,
      date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      synced BOOLEAN NOT NULL DEFAULT 0
    );
    INSERT INTO Account (id, name, type, balance) VALUES ('acct-1', 'Main bank', 'Bank', 1250.75);
    INSERT INTO "Transaction" (id, amount, type, category, accountId, note, date)
      VALUES ('tx-1', 20000, 'Income', 'Family gift / support', 'acct-1', 'From mother', '2026-05-01T12:00:00.000Z');
    INSERT INTO "Transaction" (id, amount, type, category, accountId, note, date)
      VALUES ('tx-2', 5000, 'Expense', 'Banking expense', 'acct-1', 'Card fee', '2026-05-02T12:00:00.000Z');
  `);
  return database;
}

function createIntermediateSchema() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE User (id TEXT PRIMARY KEY, fullName TEXT, email TEXT, passwordHash TEXT, createdAt TEXT);
    CREATE TABLE Account (
      id TEXT PRIMARY KEY, ownerId TEXT, name TEXT, type TEXT, balance REAL, balanceMinor INTEGER,
      currency TEXT, createdAt TEXT, synced INTEGER
    );
    CREATE TABLE "Transaction" (
      id TEXT PRIMARY KEY, ownerId TEXT, amount REAL, amountMinor INTEGER, type TEXT,
      category TEXT, categoryId TEXT, accountId TEXT, toAccountId TEXT, date TEXT,
      note TEXT, sourceName TEXT, paymentMethod TEXT, sourceAmountMinor INTEGER,
      sourceCurrency TEXT, exchangeRate TEXT, referenceNumber TEXT, taxStatus TEXT,
      taxYear INTEGER, synced INTEGER
    );
    INSERT INTO User VALUES ('user-1', 'A User', 'a@example.test', 'legacy-hash', '2026-01-01T00:00:00.000Z');
    INSERT INTO Account VALUES ('acct-1', 'user-1', 'Main bank', 'bank', 100.50, NULL, 'PKR', '2026-01-01T00:00:00.000Z', 1);
    INSERT INTO "Transaction" VALUES (
      'tx-1', 'user-1', 125.25, NULL, 'Income', 'Salary', 'Salary', 'acct-1', NULL,
      '2026-02-01T00:00:00.000Z', 'February pay', 'Employer', 'bank', NULL, NULL, NULL, NULL,
      'unreviewed', 2026, 1
    );
  `);
  return database;
}

function removeExtendedSyncTriggers(database) {
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'CloudSync_Bill%' OR name LIKE 'CloudSync_Debt%' OR name LIKE 'CloudSync_Asset%' OR name LIKE 'CloudSync_Investment%' OR name='CloudSync_ScheduleOccurrence_outbox_resolve')").all();
  for (const { name } of names) database.exec(`DROP TRIGGER "${name.replaceAll('"','""')}"`);
}

test('versioned migration preserves released records, maps classifications, and is repeatable', async () => {
  const database = createReleasedSchema();
  const adapter = migrationAdapter(database);

  await migrateLocalDatabase(adapter);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, LOCAL_DATABASE_VERSION);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM Account').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 2);

  const account = database.prepare('SELECT ownerId, balanceMinor, currency FROM Account WHERE id = ?').get('acct-1');
  assert.equal(account.ownerId, null, 'ownership remains unclaimed until the user flow can safely claim it');
  assert.equal(account.balanceMinor, 125075);
  assert.equal(account.currency, 'PKR');

  const gift = database.prepare('SELECT amountMinor, categoryId, classificationId, synced FROM "Transaction" WHERE id = ?').get('tx-1');
  assert.equal(gift.amountMinor, 2_000_000);
  assert.equal(gift.categoryId, 'Family gift / support', 'legacy display label stays unchanged');
  assert.equal(gift.classificationId, 'family_gift');
  assert.equal(gift.synced, 0);
  const fee = database.prepare('SELECT categoryId, classificationId FROM "Transaction" WHERE id = ?').get('tx-2');
  assert.equal(fee.categoryId, 'Banking expense');
  assert.equal(fee.classificationId, 'bank_fee');

  await migrateLocalDatabase(adapter);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 2);
  assert.equal(database.prepare('SELECT classificationId FROM "Transaction" WHERE id = ?').get('tx-1').classificationId, 'family_gift');
  database.close();
});

test('fresh databases receive the same schema without creating sample financial records', async () => {
  const database = new DatabaseSync(':memory:');
  await migrateLocalDatabase(migrationAdapter(database));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM Account').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 0);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(LOCAL_DATABASE_VERSION, 18);
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProfileSetup'").get());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='AuthLoginAttempt'").get());
  assert.ok(database.prepare('PRAGMA table_info(Account)').all().some((column) => column.name === 'archivedAt'));
  assert.ok(database.prepare('PRAGMA table_info("Transaction")').all().some((column) => column.name === 'reversalOfId'));
  assert.ok(database.prepare('PRAGMA table_info("Transaction")').all().some((column) => column.name === 'correctionOfId'));
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'Transaction_owner_date_id_idx'").get());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'Transaction_owner_account_history_idx'").get());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'Transaction_owner_destination_history_idx'").get());
  for (const table of ['Budget', 'SavingsGoal', 'SavingsGoalEvent', 'EmergencyFundConfig', 'EmergencyFundEvent']) {
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} exists`);
  }
  for (const table of ['RecurringSchedule','ScheduleOccurrence','Bill','BillPayment','Debt','DebtEvent','BillPaymentCorrection','DebtEventCorrection','DebtRepaymentSchedule','DebtInterestEvent']) {
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} exists`);
  }
  for (const table of ['Asset','AssetValuation','AssetActivity','InvestmentPortfolio','InvestmentHolding','InvestmentEvent','InvestmentPrice']) {
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} exists`);
  }
  for (const table of ['Project','ProjectMember','ProjectBudget','ProjectExpense','ProjectExpenseShare','ProjectExpenseRefund','ProjectCashEvent','ProjectSettlement']) {
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} exists`);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count, 0, `${table} starts empty`);
  }
  database.close();
});

test('v9 to v12 cloud migrations preserve account mappings and pending queue rows', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const adapter = migrationAdapter(database);
  await migrateLocalDatabase(adapter);
  database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)').run('v9-user','V9 User','v9@example.test','hash','2026-01-01');
  database.prepare('INSERT INTO CloudIdentity(ownerId,cloudUserId,linkedAt,syncEnabled) VALUES(?,?,?,1)').run('v9-user','cloud-v9-user','2026-01-02');
  database.prepare('INSERT INTO CloudEntityMap(ownerId,entityType,localId,cloudId,serverRevision) VALUES(?,?,?,?,?)').run('v9-user','account','account-1','cloud-account-1',4);
  database.prepare(`INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,1,?,'pending',0,0,?,?)`).run('tx-pending-v9','v9-user','cloud-v9-user','transaction','tx-1','transaction.create','{"id":"tx-1"}','2026-01-03','2026-01-03');
  removeExtendedSyncTriggers(database);
  database.exec('PRAGMA user_version=9');
  await migrateLocalDatabase(adapter);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version,18);
  assert.deepEqual({...database.prepare('SELECT cloudId,serverRevision FROM CloudEntityMap WHERE ownerId=? AND localId=?').get('v9-user','account-1')},{cloudId:'cloud-account-1',serverRevision:4});
  assert.deepEqual({...database.prepare('SELECT mutationId,entityType,operation,payloadJson,status FROM SyncOutbox WHERE mutationId=?').get('tx-pending-v9')},
    {mutationId:'tx-pending-v9',entityType:'transaction',operation:'transaction.create',payloadJson:'{"id":"tx-1"}',status:'pending'});
  assert.ok(database.prepare('PRAGMA table_info(Budget)').all().some((column) => column.name === 'synced'));
  assert.ok(database.prepare('PRAGMA table_info(RecurringSchedule)').all().some((column) => column.name === 'synced'));
  assert.ok(database.prepare('PRAGMA table_info(ScheduleOccurrence)').all().some((column) => column.name === 'synced'));
  assert.ok(database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='SyncOutbox'").get().sql.includes('schedule.occurrence.resolve'));
  database.close();
});

test('v6 to v7 migration marks profiles with active or archived accounts as already onboarded', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const adapter = migrationAdapter(database);
  await migrateLocalDatabase(adapter);
  database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)').run('active-user','Active User','active@example.test','hash','2026-01-01');
  database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)').run('archived-user','Archived User','archived@example.test','hash','2026-01-02');
  database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('active-account','active-user','Wallet','cash',500,'PKR','2026-01-03');
  database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,archivedAt,synced) VALUES(?,?,?,?,?,?,?,?,0)').run('archived-account','archived-user','Old wallet','cash',0,'PKR','2026-01-04','2026-02-01');
  removeExtendedSyncTriggers(database);
  database.exec('DROP TABLE ProfileSetup; DROP TABLE AuthLoginAttempt; PRAGMA user_version=6');
  await migrateLocalDatabase(adapter);
  assert.equal(database.prepare('SELECT firstAccountId FROM ProfileSetup WHERE ownerId=?').get('active-user').firstAccountId, 'active-account');
  assert.equal(database.prepare('SELECT firstAccountId FROM ProfileSetup WHERE ownerId=?').get('archived-user').firstAccountId, 'archived-account');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM Account').get().n, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM User').get().n, 2);
  database.close();
});

test('schema v4 upgrades through v5 to v6 transactionally and leaves existing financial rows intact',async()=>{
  const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');
  const adapter=migrationAdapter(database);
  await migrateLocalDatabase(adapter);
  database.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  database.exec(`DROP TRIGGER IF EXISTS DebtEvent_semantics_guard; DROP TRIGGER IF EXISTS Transaction_obligation_adjustment_guard;
    DROP TRIGGER IF EXISTS BillPayment_profile_guard; DROP TRIGGER IF EXISTS BillPayment_obligation_limit_guard;`);
  for(const name of ['BillPaymentCorrectionReplacement_profile_guard','BillPaymentCorrectionReplacement_append_only_update','BillPaymentCorrectionReplacement_append_only_delete','DebtEventCorrectionReplacement_profile_guard','DebtEventCorrectionReplacement_append_only_update','DebtEventCorrectionReplacement_append_only_delete','BillPaymentCorrection_profile_guard','BillPaymentCorrection_replacement_guard','BillPaymentCorrection_append_only_update','BillPaymentCorrection_append_only_delete','DebtEventCorrection_profile_guard','DebtEventCorrection_replacement_guard','DebtEventCorrection_append_only_update','DebtEventCorrection_append_only_delete','DebtRepaymentSchedule_profile_guard','DebtRepaymentSchedule_history_update_guard','DebtRepaymentSchedule_delete_guard','DebtInterestEvent_profile_guard','DebtInterestEvent_append_only_update','DebtInterestEvent_append_only_delete']) database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  for(const table of ['BillPaymentCorrectionReplacement','DebtEventCorrectionReplacement','BillPaymentCorrection','DebtEventCorrection','DebtRepaymentSchedule','DebtInterestEvent']) database.exec(`DROP TABLE IF EXISTS "${table}"`);
  removeExtendedSyncTriggers(database);
  database.exec('PRAGMA user_version=4');
  await migrateLocalDatabase(adapter);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version,18);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM User WHERE id=?').get('u').n,1);
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='DebtEventCorrection'").get());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='DebtInterestEvent'").get());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='AssetValuation'").get());
  database.close();
});

test('a schema v5 database receives v6 asset and investment tables without changing ledger rows',async()=>{
  const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');const adapter=migrationAdapter(database);
  await migrateLocalDatabase(adapter);
  database.prepare('INSERT INTO User VALUES(?,?,?,?,?)').run('u','User','u@example.test','hash','2026-01-01');
  database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)').run('a','u','Bank','bank',10000,'PKR','2026-01-01');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run('t','u',10,1000,'Income','salary','salary','a','2026-01-02T00:00:00.000Z','unreviewed');
  for(const name of ['Asset_profile_guard','Asset_purchase_immutable','AssetValuation_profile_guard','AssetValuation_append_only_update','AssetValuation_append_only_delete','AssetActivity_profile_guard','AssetActivity_append_only_update','AssetActivity_append_only_delete','Portfolio_profile_guard','Portfolio_update_guard','Holding_profile_guard','Holding_immutable','InvestmentEvent_profile_guard','InvestmentEvent_append_only_update','InvestmentEvent_append_only_delete','InvestmentPrice_profile_guard','InvestmentPrice_append_only_update','InvestmentPrice_append_only_delete','Transaction_asset_investment_adjustment_guard'])database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  for(const name of ['Account_insert_integrity_guard','Account_update_integrity_guard','Transaction_insert_integrity_guard','Transaction_append_only_delete','Transaction_financial_update_guard','Transaction_account_update_guard_v8'])database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  for(const name of ['InvestmentPrice','InvestmentEvent','InvestmentHolding','InvestmentPortfolio','AssetActivity','AssetValuation','Asset'])database.exec(`DROP TABLE "${name}"`);
  removeExtendedSyncTriggers(database);
  database.exec('PRAGMA user_version=5');
  await migrateLocalDatabase(adapter);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version,18);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM "Transaction" WHERE id=\'t\'').get().n,1);
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='InvestmentEvent'").get());
  database.close();
});

test('budget, goal and emergency-fund migration is repeatable and protects profile history', async () => {
  const database = createIntermediateSchema();
  database.exec('PRAGMA foreign_keys = ON');
  const adapter = migrationAdapter(database);
  await migrateLocalDatabase(adapter);
  await migrateLocalDatabase(adapter);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 18);

  database.prepare(`INSERT INTO Budget
    (id, ownerId, categoryId, amountMinor, currency, periodStart, periodEnd, rolloverPolicy, revision, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'budget-1', 'user-1', 'food', 10000, 'PKR', '2026-05-01', '2026-06-01', 'reset', 1, '2026-05-01T00:00:00.000Z',
  );
  assert.throws(() => database.prepare(`INSERT INTO Budget
    (id, ownerId, categoryId, amountMinor, currency, periodStart, periodEnd, rolloverPolicy, revision, createdAt)
    VALUES ('budget-duplicate', 'user-1', 'food', 15000, 'PKR', '2026-05-01', '2026-06-01', 'reset', 1, '2026-05-02T00:00:00.000Z')`).run(), /UNIQUE constraint failed/);
  assert.throws(() => database.prepare('UPDATE Budget SET amountMinor = 20000 WHERE id = ?').run('budget-1'), /immutable/);

  database.prepare(`INSERT INTO SavingsGoal
    (id, ownerId, name, targetMinor, currency, status, createdAt, updatedAt)
    VALUES ('goal-1', 'user-1', 'Laptop', 500000, 'PKR', 'active', '2026-05-01', '2026-05-01')`).run();
  database.prepare(`INSERT INTO SavingsGoalEvent
    (id, ownerId, goalId, eventType, amountMinor, currency, idempotencyKey, eventDate, note, createdAt)
    VALUES ('planned-1', 'user-1', 'goal-1', 'planned', 25000, 'PKR', 'planned-1', '2026-05-01', '', '2026-05-01')`).run();
  database.prepare(`INSERT INTO SavingsGoalEvent
    (id, ownerId, goalId, eventType, amountMinor, currency, accountId, idempotencyKey, eventDate, note, createdAt)
    VALUES ('allocate-1', 'user-1', 'goal-1', 'allocate', 10000, 'PKR', 'acct-1', 'allocate-1', '2026-05-01', '', '2026-05-01')`).run();
  assert.throws(() => database.prepare('UPDATE SavingsGoalEvent SET amountMinor = 1 WHERE id = ?').run('allocate-1'), /append-only/);
  assert.throws(() => database.prepare('DELETE FROM SavingsGoalEvent WHERE id = ?').run('allocate-1'), /append-only/);
  assert.throws(() => database.prepare(`INSERT INTO SavingsGoalEvent
    (id, ownerId, goalId, eventType, amountMinor, currency, accountId, idempotencyKey, eventDate, note, createdAt)
    VALUES ('wrong-profile', 'user-2', 'goal-1', 'allocate', 10000, 'PKR', 'acct-1', 'wrong-profile', '2026-05-01', '', '2026-05-01')`).run(), /savings event owner/);
  database.prepare(`INSERT INTO EmergencyFundConfig (ownerId, currency, coverageMonths, essentialMonthlyMinor, updatedAt)
    VALUES ('user-1', 'PKR', 3, 50000, '2026-05-01')`).run();
  database.prepare(`INSERT INTO EmergencyFundEvent
    (id, ownerId, eventType, amountMinor, currency, accountId, idempotencyKey, eventDate, note, createdAt)
    VALUES ('emergency-1', 'user-1', 'allocate', 5000, 'PKR', 'acct-1', 'emergency-1', '2026-05-01', '', '2026-05-01')`).run();
  assert.throws(() => database.prepare('UPDATE EmergencyFundEvent SET amountMinor = 1 WHERE id = ?').run('emergency-1'), /append-only/);
  assert.throws(() => database.prepare('DELETE FROM EmergencyFundEvent WHERE id = ?').run('emergency-1'), /append-only/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 1, 'migration retains existing financial history');
  database.close();
});

test('financial core migration blocks cross-profile account references and retains linked event foreign keys', async () => {
  const database = createIntermediateSchema();
  database.exec('PRAGMA foreign_keys = ON');
  await migrateLocalDatabase(migrationAdapter(database));
  database.prepare('INSERT INTO User VALUES (?, ?, ?, ?, ?)').run('user-2', 'B User', 'b@example.test', 'hash', '2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO Account (id, ownerId, name, type, balanceMinor, currency, createdAt, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('acct-2', 'user-2', 'Other', 'bank', 0, 'PKR', '2026-01-01T00:00:00.000Z', 0);
  assert.throws(() => database.prepare(`INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, categoryId, accountId, date, note, taxStatus, synced)
    VALUES ('bad-tx', 'user-1', 1, 100, 'Expense', 'food', 'missing-account', '2026-01-01T00:00:00.000Z', '', 'unreviewed', 0)`).run(), /unavailable to this profile|cash-ledger integrity/);
  assert.throws(() => database.prepare(`INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, categoryId, accountId, date, note, taxStatus, synced)
    VALUES ('wrong-owner', 'user-1', 1, 100, 'Expense', 'food', 'acct-2', '2026-01-01T00:00:00.000Z', '', 'unreviewed', 0)`).run(), /unavailable to this profile|cash-ledger integrity/);
  const columns = database.prepare('PRAGMA table_info("Transaction")').all().map((column) => column.name);
  assert.ok(columns.includes('reversalOfId'));
  assert.ok(columns.includes('correctionOfId'));
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'Transaction_account_insert_guard'").get());
  database.prepare(`INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, categoryId, accountId, date, note, taxStatus, synced, reversalOfId)
    VALUES ('undo-tx', 'user-1', 125.25, 12525, 'Reversal', 'correction_reversal', 'acct-1', '2026-03-01T00:00:00.000Z', 'Undo', 'unreviewed', 0, 'tx-1')`).run();
  assert.throws(() => database.prepare('DELETE FROM "Transaction" WHERE id = ?').run('tx-1'), /append-only/);
  assert.throws(() => database.prepare('DELETE FROM Account WHERE id = ?').run('acct-1'), /cannot be deleted/);
  database.close();
});

test('migration upgrades the intermediate unversioned local schema without losing ownership or money', async () => {
  const database = createIntermediateSchema();
  await migrateLocalDatabase(migrationAdapter(database));
  const user = database.prepare('SELECT id FROM User').get();
  const account = database.prepare('SELECT ownerId, balanceMinor FROM Account WHERE id = ?').get('acct-1');
  const transaction = database.prepare('SELECT ownerId, amountMinor, classificationId, categoryId, synced FROM "Transaction" WHERE id = ?').get('tx-1');
  assert.equal(user.id, 'user-1');
  assert.equal(account.ownerId, 'user-1');
  assert.equal(account.balanceMinor, 10050);
  assert.equal(transaction.ownerId, 'user-1');
  assert.equal(transaction.amountMinor, 12525);
  assert.equal(transaction.classificationId, 'salary');
  assert.equal(transaction.categoryId, 'Salary');
  assert.equal(transaction.synced, 0, 'legacy sync flags are reset because no server acknowledgement exists');
  database.close();
});

test('unsafe legacy money aborts and rolls back all schema and data changes', async () => {
  const database = createReleasedSchema();
  database.prepare('UPDATE "Transaction" SET amount = ? WHERE id = ?').run(90_071_992_547_409.92, 'tx-1');
  const adapter = migrationAdapter(database);

  await assert.rejects(migrateLocalDatabase(adapter), /outside the supported range/);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 2);
  const columns = database.prepare('PRAGMA table_info("Transaction")').all().map((column) => column.name);
  assert.equal(columns.includes('classificationId'), false, 'ALTER statements roll back with the data migration');
  assert.equal(database.prepare('SELECT amount FROM "Transaction" WHERE id = ?').get('tx-1').amount, 90_071_992_547_409.92);
  database.close();
});

test('late migration integrity failure rolls back DDL, backfills, and version atomically', async () => {
  const database = createReleasedSchema();
  const adapter = migrationAdapter(database);
  const getFirstAsync = adapter.getFirstAsync.bind(adapter);
  adapter.getFirstAsync = async (source, params = []) => {
    if (source === 'PRAGMA integrity_check') return { integrity_check: 'simulated failure' };
    return getFirstAsync(source, params);
  };

  await assert.rejects(migrateLocalDatabase(adapter), /integrity check failed/);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(database.prepare('SELECT balance FROM Account WHERE id = ?').get('acct-1').balance, 1250.75);
  assert.equal(database.prepare('SELECT amount FROM "Transaction" WHERE id = ?').get('tx-1').amount, 20_000);
  assert.equal(database.prepare('PRAGMA table_info(Account)').all().some((column) => column.name === 'archivedAt'), false);
  assert.equal(database.prepare('PRAGMA table_info("Transaction")').all().some((column) => column.name === 'reversalOfId'), false);
  database.close();
});

test('a database created by a newer app is rejected without being modified', async () => {
  const database = createReleasedSchema();
  database.exec('PRAGMA user_version = 99');
  await assert.rejects(migrateLocalDatabase(migrationAdapter(database)), /newer than this app supports/);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 2);
  database.close();
});

test('migrated database reopens with its version, transaction totals, and opening balance intact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'houselog-migration-reopen-'));
  const databasePath = join(directory, 'legacy.sqlite');
  try {
    const before = createReleasedSchema(databasePath);
    const original = {
      accountBalance: before.prepare('SELECT balance FROM Account WHERE id = ?').get('acct-1').balance,
      transactionAmount: before.prepare('SELECT SUM(amount) AS amount FROM "Transaction"').get().amount,
      accounts: before.prepare('SELECT COUNT(*) AS count FROM Account').get().count,
      transactions: before.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count,
    };
    await migrateLocalDatabase(migrationAdapter(before));
    before.close();

    const reopened = new DatabaseSync(databasePath);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, LOCAL_DATABASE_VERSION);
    assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM Account').get().count, original.accounts);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, original.transactions);
    assert.equal(reopened.prepare('SELECT balanceMinor FROM Account WHERE id = ?').get('acct-1').balanceMinor, Math.round(original.accountBalance * 100));
    assert.equal(reopened.prepare('SELECT SUM(amountMinor) AS amount FROM "Transaction"').get().amount, original.transactionAmount * 100);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v8 normalizes only interpretable timestamp instants and preserves ambiguous civil dates', async () => {
  const database = createIntermediateSchema();
  database.prepare('UPDATE "Transaction" SET date=? WHERE id=?').run('2026-10-01 12:34:56', 'tx-1');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)')
    .run('offset', 'user-1', 1, 100, 'Income', 'salary', 'salary', 'acct-1', '2026-03-01T00:30:00+05:30', '', 'unreviewed');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)')
    .run('civil', 'user-1', 1, 100, 'Income', 'salary', 'salary', 'acct-1', '2026-10-02', '', 'unreviewed');
  await migrateLocalDatabase(migrationAdapter(database));
  assert.equal(database.prepare('SELECT date FROM "Transaction" WHERE id=?').get('tx-1').date, '2026-10-01T12:34:56.000Z');
  assert.equal(database.prepare('SELECT date FROM "Transaction" WHERE id=?').get('offset').date, '2026-02-28T19:00:00.000Z');
  assert.equal(database.prepare('SELECT date FROM "Transaction" WHERE id=?').get('civil').date, '2026-10-02');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('the supported v7 to v8 upgrade preserves posted financial values and installs hardening idempotently', async () => {
  const database = createIntermediateSchema();
  const adapter = migrationAdapter(database);
  await migrateLocalDatabase(adapter);
  const before = database.prepare('SELECT id,ownerId,amountMinor,type,accountId FROM "Transaction" WHERE id=?').get('tx-1');
  for (const name of ['Account_insert_integrity_guard','Account_update_integrity_guard','Account_history_currency_guard','Transaction_insert_integrity_guard','Transaction_append_only_delete','Transaction_financial_update_guard','Transaction_account_update_guard_v8']) {
    database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
  removeExtendedSyncTriggers(database);
  database.exec('DROP INDEX IF EXISTS Transaction_owner_correction_idx; PRAGMA user_version=7');
  database.prepare('UPDATE "Transaction" SET date=? WHERE id=?').run('2026-02-01 12:00:00', 'tx-1');
  await migrateLocalDatabase(adapter);
  await migrateLocalDatabase(adapter);
  const after = database.prepare('SELECT id,ownerId,amountMinor,type,accountId,date FROM "Transaction" WHERE id=?').get('tx-1');
  assert.deepEqual([after.id,after.ownerId,after.amountMinor,after.type,after.accountId], [before.id,before.ownerId,before.amountMinor,before.type,before.accountId]);
  assert.equal(after.date, '2026-02-01T12:00:00.000Z');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 18);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('v8 protects posted cash history while permitting valid refunds, reversals, replacements, and sync metadata', async () => {
  const database = createIntermediateSchema();
  database.exec('PRAGMA foreign_keys=ON');
  await migrateLocalDatabase(migrationAdapter(database));
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)')
    .run('expense', 'user-1', 100, 10_000, 'Expense', 'food', 'food', 'acct-1', '2026-02-02T00:00:00.000Z', 'Purchase', 'unreviewed');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)')
    .run('refund-a', 'user-1', 40, 4_000, 'Refund', 'refund', 'refund', 'acct-1', '2026-02-03T00:00:00.000Z', 'Partial refund', 'unreviewed', 'expense');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)')
    .run('refund-b', 'user-1', 60, 6_000, 'Refund', 'refund', 'refund', 'acct-1', '2026-02-04T00:00:00.000Z', 'Remaining refund', 'unreviewed', 'expense');
  assert.throws(() => database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)')
    .run('refund-over', 'user-1', 0.01, 1, 'Refund', 'refund', 'refund', 'acct-1', '2026-02-05T00:00:00.000Z', '', 'unreviewed', 'expense'), /cash-ledger integrity/);

  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,reversalOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)')
    .run('income-reversal', 'user-1', 125.25, 12_525, 'Reversal', 'correction', 'correction_reversal', 'acct-1', '2026-02-06T00:00:00.000Z', '', 'unreviewed', 'tx-1');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,note,taxStatus,synced,correctionOfId) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)')
    .run('replacement', 'user-1', 120, 12_000, 'Income', 'salary', 'salary', 'acct-1', '2026-02-07T00:00:00.000Z', 'Corrected income', 'unreviewed', 'tx-1');

  assert.throws(() => database.prepare('UPDATE "Transaction" SET amountMinor=1 WHERE id=?').run('expense'), /immutable/);
  assert.throws(() => database.prepare('UPDATE "Transaction" SET note=? WHERE id=?').run('rewritten', 'expense'), /immutable/);
  assert.throws(() => database.prepare('DELETE FROM "Transaction" WHERE id=?').run('expense'), /append-only/);
  assert.throws(() => database.prepare('UPDATE "Transaction" SET correctionOfId=? WHERE id=?').run('tx-1', 'replacement'), /immutable/);
  assert.throws(() => database.prepare('UPDATE Account SET currency=? WHERE id=?').run('USD', 'acct-1'), /locked after transaction history/);
  assert.throws(() => database.prepare('UPDATE Account SET balanceMinor=? WHERE id=?').run(1, 'acct-1'), /locked after transaction history/);
  assert.throws(() => database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)')
    .run('unsupported-currency', 'user-1', 'Invalid', 'bank', 0, 'XXX', '2026-01-01'), /currency integrity/);
  database.prepare('UPDATE "Transaction" SET synced=1 WHERE id=?').run('expense');
  assert.equal(database.prepare('SELECT synced FROM "Transaction" WHERE id=?').get('expense').synced, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM "Transaction" WHERE type=\'Refund\' AND reversalOfId=\'expense\'').get().n, 2);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { prepareBackupCandidate } from '../../src/db/local/backupCandidate.ts';
import { LOCAL_DATABASE_VERSION, migrateLocalDatabase } from '../../src/db/local/migrations.ts';

function adapter(database) {
  return {
    async execAsync(sql) { database.exec(sql); },
    async runAsync(sql, params = []) { database.prepare(sql).run(...params); },
    async getFirstAsync(sql, params = []) { return database.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, params = []) { return database.prepare(sql).all(...params); },
    async withTransactionAsync(task) {
      database.exec('BEGIN IMMEDIATE');
      try { await task(); database.exec('COMMIT'); }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function removeExtendedSyncTriggers(database) {
  const rows=database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'CloudSync_Bill%' OR name LIKE 'CloudSync_Debt%' OR name LIKE 'CloudSync_Asset%' OR name LIKE 'CloudSync_Investment%' OR name='CloudSync_ScheduleOccurrence_outbox_resolve')").all();
  for(const {name} of rows)database.exec(`DROP TRIGGER "${name.replaceAll('"','""')}"`);
}

async function candidate() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const sql = adapter(database);
  await migrateLocalDatabase(sql);
  database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)')
    .run('backup-owner','Backup Owner','backup@example.test','hash','2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)')
    .run('backup-account','backup-owner','Main','bank',100000,'PKR','2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,date,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)')
    .run('backup-transaction','backup-owner',25,2500,'Expense','Food','food','food','backup-account','2026-01-02T00:00:00.000Z','unreviewed');
  return { database, sql };
}

test('backup candidate migrates an older supported image before it can replace the active database', async () => {
  const { database, sql } = await candidate();
  try {
    removeExtendedSyncTriggers(database);
    database.exec('PRAGMA user_version=8');
    await prepareBackupCandidate(sql,'backup-owner',8);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version,LOCAL_DATABASE_VERSION);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM Account').get().count,1);
    assert.equal(database.prepare('SELECT amountMinor FROM "Transaction" WHERE id=?').get('backup-transaction').amountMinor,2500);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally { database.close(); }
});

test('backup candidate rejects metadata mismatch, wrong profile, and future schema without modifying the image', async () => {
  const { database, sql } = await candidate();
  try {
    removeExtendedSyncTriggers(database);
    database.exec('PRAGMA user_version=8');
    await assert.rejects(prepareBackupCandidate(sql,'backup-owner',9),/incompatible/);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version,8);
    await assert.rejects(prepareBackupCandidate(sql,'other-owner',8),/different profile/);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version,8);
    database.exec('PRAGMA user_version=14');
    await assert.rejects(prepareBackupCandidate(sql,'backup-owner',14),/incompatible/);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version,14);
  } finally { database.close(); }
});

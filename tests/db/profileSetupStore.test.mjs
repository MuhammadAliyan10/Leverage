import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocalDatabase } from '../../src/db/local/migrations.ts';
import { createProfileSetupStore } from '../../src/db/local/profileSetupStore.ts';

function adapter(database) {
  const sql = {
    async getFirstAsync(source, params = []) { return database.prepare(source).get(...params) ?? null; },
    async runAsync(source, params = []) { return database.prepare(source).run(...params); },
  };
  return {
    sql,
    async withWrite(task) {
      database.exec('BEGIN IMMEDIATE');
      try { const result = await task(sql); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

async function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  await migrateLocalDatabase({
    async execAsync(source) { database.exec(source); },
    async runAsync(source, params = []) { database.prepare(source).run(...params); },
    async getFirstAsync(source, params = []) { return database.prepare(source).get(...params) ?? null; },
    async getAllAsync(source, params = []) { return database.prepare(source).all(...params); },
    async withTransactionAsync(task) { database.exec('BEGIN IMMEDIATE'); try { await task(); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; } },
  });
  database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)').run('u1','Test User','u1@example.test','hash','2026-01-01');
  const { sql, withWrite } = adapter(database);
  return { database, store: createProfileSetupStore(async () => sql, withWrite) };
}

test('first-account completion is atomic, profile scoped, and idempotent across retries', async () => {
  const { database, store } = await fixture();
  const draft = { name: 'Main bank', type: 'bank', balanceMinor: 12_345, currency: 'PKR' };
  const first = await store.complete('u1', draft);
  const retry = await store.complete('u1', { ...draft, name: 'Changed during retry', balanceMinor: 90_000 });
  assert.equal(first.alreadyComplete, false);
  assert.equal(retry.alreadyComplete, true);
  assert.equal(first.account.id, 'first-account:u1');
  assert.equal(retry.account.name, 'Main bank');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM Account WHERE ownerId=?').get('u1').n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ProfileSetup WHERE ownerId=?').get('u1').n, 1);
  assert.equal(await store.isComplete('u1'), true);
  database.close();
});

test('failed setup metadata write rolls back the account and allows a safe retry', async () => {
  const { database, store } = await fixture();
  database.exec("CREATE TRIGGER reject_profile_setup BEFORE INSERT ON ProfileSetup BEGIN SELECT RAISE(ABORT,'synthetic setup write failure'); END");
  await assert.rejects(store.complete('u1', { name: 'Wallet', type: 'cash', balanceMinor: 0, currency: 'PKR' }));
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM Account WHERE ownerId=?').get('u1').n, 0);
  database.exec('DROP TRIGGER reject_profile_setup');
  const result = await store.complete('u1', { name: 'Wallet', type: 'cash', balanceMinor: 0, currency: 'PKR' });
  assert.equal(result.account.name, 'Wallet');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM Account WHERE ownerId=?').get('u1').n, 1);
  database.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeSyncDiagnosticSql } from '../../src/db/local/syncSqliteDiagnostics.ts';
import { migrateLocalDatabase } from '../../src/db/local/migrations.ts';
import { markTransactionCloudConfirmed } from '../../src/db/local/transactionSyncMetadata.ts';

function fakeDatabase({ execute, finalize } = {}) {
  const calls = [];
  return {
    calls,
    async prepareAsync(sql) {
      calls.push(['prepare', sql]);
      return {
        async executeAsync(params) {
          calls.push(['execute', params]);
          if (execute) return execute(params);
          return {
            changes: 1,
            lastInsertRowId: 0,
            async getFirstAsync() { return { value: 7 }; },
            async getAllAsync() { return [{ value: 7 }]; },
          };
        },
        async finalizeAsync() {
          calls.push(['finalize']);
          if (finalize) return finalize();
        },
      };
    },
  };
}

test('sync SQL preserves the original execution error when finalization also fails', async () => {
  const queryError = Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT' });
  const database = fakeDatabase({ execute: async () => { throw queryError; }, finalize: async () => { throw new Error('Error finalizing statement'); } });
  await assert.rejects(
    executeSyncDiagnosticSql(database, 'apply_cloud_change', 'INSERT INTO Account VALUES(?)', ['secret-value'], 'run'),
    (error) => {
      assert.match(error.message, /SYNC_SQL_EXECUTE_FAILED:apply_cloud_change:INSERT Account:SQLITE_CONSTRAINT:UNIQUE constraint failed/);
      assert.equal(error.cause, queryError);
      return true;
    },
  );
  assert.deepEqual(database.calls.map(([call]) => call), ['prepare', 'execute', 'finalize']);
});

test('sync SQL reports a standalone finalization error and still closes the statement', async () => {
  const database = fakeDatabase({ finalize: async () => { throw new Error('Error finalizing statement'); } });
  await assert.rejects(
    executeSyncDiagnosticSql(database, 'read_sync_cursor', 'SELECT cursor FROM SyncCursor', [], 'first'),
    /SYNC_SQL_FINALIZE_FAILED:read_sync_cursor:SELECT SyncCursor/,
  );
  assert.deepEqual(database.calls.map(([call]) => call), ['prepare', 'execute', 'finalize']);
});

test('sync SQL returns the expected result for reads and writes and binds values without logging them', async () => {
  const database = fakeDatabase();
  const first = await executeSyncDiagnosticSql(database, 'read', 'SELECT value FROM Account WHERE id=?', ['private-id'], 'first');
  const all = await executeSyncDiagnosticSql(database, 'read', 'SELECT value FROM Account', [], 'all');
  const run = await executeSyncDiagnosticSql(database, 'write', 'UPDATE SyncCursor SET cursor=?', ['42'], 'run');
  assert.deepEqual(first, { value: 7 });
  assert.deepEqual(all, [{ value: 7 }]);
  assert.equal(run.changes, 1);
  assert.ok(database.calls.some(([name, value]) => name === 'execute' && JSON.stringify(value).includes('private-id')));
});

test('cloud confirmation transitions transaction metadata once and skips immutable no-op updates', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const sql = {
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

  try {
    await migrateLocalDatabase(sql);
    database.prepare('INSERT INTO User(id,fullName,email,passwordHash,createdAt) VALUES(?,?,?,?,?)')
      .run('owner', 'Test Owner', 'owner@example.test', 'test-only', '2026-01-01T00:00:00.000Z');
    database.prepare('INSERT INTO Account(id,ownerId,name,type,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,0)')
      .run('account', 'owner', 'Test account', 'bank', 10000, 'PKR', '2026-01-01T00:00:00.000Z');
    database.prepare(`INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,accountId,date,taxStatus,synced)
      VALUES(?,?,?,?,?,?,?,?,?,?,0)`)
      .run('transaction', 'owner', 10, 1000, 'Income', 'Employment income', 'salary', 'account', '2026-01-02T00:00:00.000Z', 'unreviewed');

    await markTransactionCloudConfirmed(sql, 'transaction', 'owner');
    assert.equal(database.prepare('SELECT synced FROM "Transaction" WHERE id=?').get('transaction').synced, 1);
    await assert.doesNotReject(markTransactionCloudConfirmed(sql, 'transaction', 'owner'));
    assert.equal(database.prepare('SELECT synced FROM "Transaction" WHERE id=?').get('transaction').synced, 1);
    assert.equal(database.prepare('SELECT amountMinor FROM "Transaction" WHERE id=?').get('transaction').amountMinor, 1000);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

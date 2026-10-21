import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { archiveAccount, editAccount } from '../../src/finance/accountOperations.ts';

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE Account (id TEXT PRIMARY KEY, ownerId TEXT, name TEXT, type TEXT, balanceMinor INTEGER, currency TEXT, createdAt TEXT, archivedAt TEXT);
    CREATE TABLE "Transaction" (id TEXT PRIMARY KEY, ownerId TEXT, accountId TEXT, toAccountId TEXT);
    INSERT INTO Account VALUES ('a1', 'u1', 'Cash', 'cash', 10000, 'PKR', '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO Account VALUES ('other', 'u2', 'Other', 'cash', 3000, 'PKR', '2026-01-01T00:00:00.000Z', NULL);`);
  const store = {
    async findAccount(ownerId, accountId) { return database.prepare('SELECT * FROM Account WHERE ownerId = ? AND id = ?').get(ownerId, accountId) ?? null; },
    async countTransactions(ownerId, accountId) { return database.prepare('SELECT COUNT(*) AS count FROM "Transaction" WHERE ownerId = ? AND (accountId = ? OR toAccountId = ?)').get(ownerId, accountId, accountId).count; },
    async updateAccount(account) { database.prepare('UPDATE Account SET name = ?, type = ?, balanceMinor = ?, currency = ? WHERE id = ? AND ownerId = ?').run(account.name, account.type, account.balanceMinor, account.currency, account.id, account.ownerId); },
    async archiveAccount(ownerId, accountId, at) { database.prepare('UPDATE Account SET archivedAt = ? WHERE ownerId = ? AND id = ? AND archivedAt IS NULL').run(at, ownerId, accountId); },
  };
  return { database, store };
}

test('account metadata, opening balance, and currency edit with supported values', async () => {
  const { database, store } = setup();
  const updated = await editAccount('u1', 'a1', { name: 'Daily wallet', type: 'wallet', balanceMinor: 12500, currency: 'PKR' }, store);
  assert.equal(updated.name, 'Daily wallet');
  assert.equal(updated.balanceMinor, 12500);
  assert.equal(database.prepare('SELECT name FROM Account WHERE id = ?').get('a1').name, 'Daily wallet');
  database.close();
});

test('account opening balance and currency lock after any posted history', async () => {
  const { database, store } = setup();
  database.prepare('INSERT INTO "Transaction" VALUES (?, ?, ?, ?)').run('tx1', 'u1', 'a1', null);
  await assert.rejects(editAccount('u1', 'a1', { balanceMinor: 11000 }, store), /locked after transactions/);
  await assert.rejects(editAccount('u1', 'a1', { currency: 'USD' }, store), /Currency cannot change/);
  assert.equal(database.prepare('SELECT balanceMinor FROM Account WHERE id = ?').get('a1').balanceMinor, 10000);
  database.close();
});

test('profile isolation, validation, archival, and history retention', async () => {
  const { database, store } = setup();
  await assert.rejects(editAccount('u1', 'other', { name: 'Takeover' }, store), /not available/);
  await assert.rejects(editAccount('u1', 'a1', { currency: 'XYZ' }, store), /supported ISO currency/);
  database.prepare('INSERT INTO "Transaction" VALUES (?, ?, ?, ?)').run('tx1', 'u1', 'a1', null);
  const at = new Date('2026-03-01T00:00:00.000Z');
  await archiveAccount('u1', 'a1', store, at);
  await archiveAccount('u1', 'a1', store, at);
  await assert.rejects(editAccount('u1', 'a1', { name: 'Archived' }, store), /Archived/);
  assert.equal(database.prepare('SELECT archivedAt FROM Account WHERE id = ?').get('a1').archivedAt, at.toISOString());
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 1);
  database.close();
});

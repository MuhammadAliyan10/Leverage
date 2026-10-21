import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createValidatedTransaction, normalizeTransactionDraft } from '../../src/finance/domain.ts';
import { calculateAccountBalances } from '../../src/finance/balances.ts';
import { assertCorrectionCanPost, resolveRefundAmount } from '../../src/finance/transactionOperations.ts';

function createStore(database) {
  return {
    async findAccount(id, ownerId) {
      return database.prepare('SELECT id, ownerId, currency, type FROM Account WHERE id = ? AND ownerId = ?').get(id, ownerId) ?? null;
    },
    async findTransaction(id, ownerId) {
      const row = database.prepare('SELECT * FROM "Transaction" WHERE id = ? AND ownerId = ?').get(id, ownerId);
      if (!row) return null;
      const source = await this.findAccount(row.accountId, ownerId);
      const destination = row.toAccountId ? await this.findAccount(row.toAccountId, ownerId) : undefined;
      return normalizeTransactionDraft({
        id: row.id,
        ownerId: row.ownerId,
        amountMinor: row.amountMinor,
        type: row.type,
        classificationId: undefined,
        accountId: row.accountId,
        toAccountId: row.toAccountId ?? undefined,
        date: row.date,
        note: row.note,
      }, source, destination ?? undefined);
    },
    async insertTransaction(record) {
      database.prepare(`INSERT INTO "Transaction" (id, ownerId, amountMinor, type, accountId, toAccountId, date, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id, record.ownerId, record.amountMinor, record.type,
        record.accountId, record.toAccountId, record.date, record.note,
      );
    },
  };
}

async function inSqliteTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = await operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function setup(databasePath = ':memory:') {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE Account (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL, type TEXT NOT NULL, balanceMinor INTEGER NOT NULL);
    CREATE TABLE "Transaction" (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, amountMinor INTEGER NOT NULL, type TEXT NOT NULL,
      accountId TEXT NOT NULL, toAccountId TEXT, date TEXT NOT NULL, note TEXT NOT NULL
    );
    INSERT INTO Account VALUES ('cash', 'user-1', 'Cash wallet', 'PKR', 'cash', 5000);
    INSERT INTO Account VALUES ('bank', 'user-1', 'Main bank', 'PKR', 'bank', 2000);
  `);
  return database;
}

test('transaction ID is idempotent against persisted SQLite rows', async () => {
  const database = setup();
  const store = createStore(database);
  const transfer = {
    ownerId: 'user-1', amountMinor: 2500, type: 'Transfer', accountId: 'cash',
    toAccountId: 'bank', date: '2026-04-01T00:00:00.000Z', note: 'Move cash',
  };

  await inSqliteTransaction(database, () => createValidatedTransaction(transfer, 'stable-1', store));
  await inSqliteTransaction(database, () => createValidatedTransaction(transfer, 'stable-1', store));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 1);
  await assert.rejects(inSqliteTransaction(database, () => createValidatedTransaction(
    { ...transfer, amountMinor: 3000 }, 'stable-1', store,
  )), /already used/);
  assert.equal(database.prepare('SELECT amountMinor FROM "Transaction" WHERE id = ?').get('stable-1').amountMinor, 2500);
  database.close();
});

test('SQLite rolls back a failed financial insert without reporting it as saved', async () => {
  const database = setup();
  database.exec(`CREATE TRIGGER reject_transaction BEFORE INSERT ON "Transaction"
    BEGIN SELECT RAISE(ABORT, 'storage failure'); END;`);
  const store = createStore(database);
  const transfer = {
    ownerId: 'user-1', amountMinor: 2500, type: 'Transfer', accountId: 'cash',
    toAccountId: 'bank', date: '2026-04-01T00:00:00.000Z', note: 'Move cash',
  };
  await assert.rejects(inSqliteTransaction(database, () => createValidatedTransaction(transfer, 'failed-1', store)), /storage failure/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 0);
  database.close();
});

test('income, expense, and transfer posts stay as distinct persisted events with exact balances', async () => {
  const database = setup();
  const store = createStore(database);
  await inSqliteTransaction(database, () => createValidatedTransaction({
    ownerId: 'user-1', amountMinor: 1000, type: 'Income', classificationId: 'salary', accountId: 'cash', date: '2026-04-01T00:00:00.000Z', note: 'Pay',
  }, 'income-1', store));
  await inSqliteTransaction(database, () => createValidatedTransaction({
    ownerId: 'user-1', amountMinor: 500, type: 'Expense', classificationId: 'food', accountId: 'cash', date: '2026-04-02T00:00:00.000Z', note: 'Lunch',
  }, 'expense-1', store));
  await inSqliteTransaction(database, () => createValidatedTransaction({
    ownerId: 'user-1', amountMinor: 1000, type: 'Transfer', accountId: 'cash', toAccountId: 'bank', date: '2026-04-03T00:00:00.000Z', note: 'Move savings',
  }, 'transfer-1', store));
  const rows = database.prepare('SELECT type, COUNT(*) AS count FROM "Transaction" GROUP BY type ORDER BY type').all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ type: 'Expense', count: 1 }, { type: 'Income', count: 1 }, { type: 'Transfer', count: 1 }]);
  const balances = calculateAccountBalances(
    database.prepare('SELECT id, ownerId, name, type, balanceMinor, currency FROM Account ORDER BY id').all(),
    database.prepare('SELECT id, ownerId, amountMinor, type, accountId, toAccountId FROM "Transaction"').all(),
  );
  assert.deepEqual(balances.map(({ id, balanceMinor }) => ({ id, balanceMinor })), [
    { id: 'bank', balanceMinor: 3000 }, { id: 'cash', balanceMinor: 4500 },
  ]);
  database.close();
});

test('an identical operation remains idempotent after closing and reopening SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'houselog-transaction-reopen-'));
  const databasePath = join(directory, 'test.sqlite');
  const transfer = {
    ownerId: 'user-1', amountMinor: 2500, type: 'Transfer', accountId: 'cash',
    toAccountId: 'bank', date: '2026-04-01T00:00:00.000Z', note: 'Move cash',
  };
  try {
    const firstOpen = setup(databasePath);
    await inSqliteTransaction(firstOpen, () => createValidatedTransaction(transfer, 'stable-after-reopen', createStore(firstOpen)));
    firstOpen.close();

    const reopened = new DatabaseSync(databasePath);
    await inSqliteTransaction(reopened, () => createValidatedTransaction(transfer, 'stable-after-reopen', createStore(reopened)));
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get().count, 1);
    const accounts = reopened.prepare('SELECT id, ownerId, name, type, currency, balanceMinor FROM Account ORDER BY id').all();
    const transactions = reopened.prepare('SELECT ownerId, amountMinor, type, accountId, toAccountId FROM "Transaction"').all();
    const balances = calculateAccountBalances(accounts, transactions);
    assert.deepEqual(balances.map(({ id, balanceMinor }) => ({ id, balanceMinor })), [
      { id: 'bank', balanceMinor: 4500 },
      { id: 'cash', balanceMinor: 2500 },
    ]);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('refunds reduce expense balances and linked reversals restore the original balance', () => {
  const accounts = [{ id: 'cash', ownerId: 'user-1', name: 'Cash', type: 'cash', balanceMinor: 2000, currency: 'PKR' }];
  const transactions = [
    { id: 'expense', ownerId: 'user-1', amountMinor: 700, type: 'Expense', accountId: 'cash', toAccountId: null },
    { id: 'refund', ownerId: 'user-1', amountMinor: 200, type: 'Refund', accountId: 'cash', toAccountId: null, reversalOfId: 'expense' },
  ];
  assert.equal(calculateAccountBalances(accounts, transactions)[0].balanceMinor, 1500);
  assert.equal(calculateAccountBalances(accounts, [transactions[0], { id: 'reversal', ownerId: 'user-1', amountMinor: 700, type: 'Reversal', accountId: 'cash', toAccountId: null, reversalOfId: 'expense' }])[0].balanceMinor, 2000);
  assert.throws(() => calculateAccountBalances(accounts, [{ id: 'reversal', ownerId: 'user-1', amountMinor: 700, type: 'Reversal', accountId: 'cash', toAccountId: null, reversalOfId: 'missing' }]), /unavailable original/);
});

test('partial and remaining refunds stay within an expense and reject unsafe totals', () => {
  assert.equal(resolveRefundAmount({ originalAmountMinor: 1000, alreadyRefundedMinor: 0, amountMinor: 200 }), 200);
  assert.equal(resolveRefundAmount({ originalAmountMinor: 1000, alreadyRefundedMinor: 200, amountMinor: 300 }), 300);
  assert.equal(resolveRefundAmount({ originalAmountMinor: 1000, alreadyRefundedMinor: 500, refundRemaining: true }), 500);
  assert.throws(() => resolveRefundAmount({ originalAmountMinor: 1000, alreadyRefundedMinor: 800, amountMinor: 201 }), /cannot exceed/);
  assert.throws(() => resolveRefundAmount({ originalAmountMinor: 1000, alreadyRefundedMinor: 1001, refundRemaining: true }), /exceed|invalid/);
  assert.throws(() => resolveRefundAmount({ originalAmountMinor: 1000, alreadyRefundedMinor: 1000, refundRemaining: true }), /no refundable/);
  assert.throws(() => resolveRefundAmount({ originalAmountMinor: Number.MAX_SAFE_INTEGER + 1, alreadyRefundedMinor: 0, amountMinor: 1 }), /invalid/);
});

test('correction checks reject prior refunds, duplicate reversals, and reused replacement IDs', () => {
  const valid = {
    originalTransactionId: 'expense-1', stableReversalId: 'correction:replacement-1:reversal',
    existingReversalId: null, priorRefundCount: 0, replacementAlreadyExists: false, existingReplacementCorrectionOfId: null,
  };
  assert.doesNotThrow(() => assertCorrectionCanPost(valid));
  assert.doesNotThrow(() => assertCorrectionCanPost({ ...valid, existingReversalId: valid.stableReversalId, replacementAlreadyExists: true, existingReplacementCorrectionOfId: 'expense-1' }));
  assert.throws(() => assertCorrectionCanPost({ ...valid, priorRefundCount: 1 }), /recorded refunds/);
  assert.throws(() => assertCorrectionCanPost({ ...valid, existingReversalId: 'other-reversal' }), /already has a correction/);
  assert.throws(() => assertCorrectionCanPost({ ...valid, replacementAlreadyExists: true, existingReplacementCorrectionOfId: null }), /already used/);
  assert.throws(() => assertCorrectionCanPost({ ...valid, replacementAlreadyExists: true, existingReplacementCorrectionOfId: 'other-expense' }), /already used/);
});

test('reversal event atomically mirrors the original transfer endpoints', () => {
  const accounts = [
    { id: 'cash', ownerId: 'user-1', name: 'Cash', type: 'cash', balanceMinor: 5000, currency: 'PKR' },
    { id: 'bank', ownerId: 'user-1', name: 'Bank', type: 'bank', balanceMinor: 1000, currency: 'PKR' },
  ];
  const transfer = { id: 'move', ownerId: 'user-1', amountMinor: 2000, type: 'Transfer', accountId: 'cash', toAccountId: 'bank' };
  const reversal = { id: 'undo', ownerId: 'user-1', amountMinor: 2000, type: 'Reversal', accountId: 'cash', toAccountId: 'bank', reversalOfId: 'move' };
  const result = calculateAccountBalances(accounts, [transfer, reversal]);
  assert.deepEqual(result.map(({ id, balanceMinor }) => ({ id, balanceMinor })), [
    { id: 'cash', balanceMinor: 5000 }, { id: 'bank', balanceMinor: 1000 },
  ]);
});

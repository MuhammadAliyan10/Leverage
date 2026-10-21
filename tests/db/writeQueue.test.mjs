import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createLocalWriteQueue } from '../../src/db/local/writeQueue.ts';

test('concurrent SQLite writes are serialized and each committed amount is retained', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE Ledger (id TEXT PRIMARY KEY, amountMinor INTEGER NOT NULL)');
  const runWrite = createLocalWriteQueue();

  await Promise.all(Array.from({ length: 20 }, (_, index) => runWrite(async () => {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('INSERT INTO Ledger VALUES (?, ?)').run(`tx-${index}`, 125);
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  })));

  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM Ledger').get().count, 20);
  assert.equal(database.prepare('SELECT SUM(amountMinor) AS total FROM Ledger').get().total, 2500);
  database.close();
});

test('a rejected write does not poison the queue and later writes still commit', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE Ledger (id TEXT PRIMARY KEY, amountMinor INTEGER NOT NULL)');
  const runWrite = createLocalWriteQueue();
  const rejected = runWrite(async () => {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('INSERT INTO Ledger VALUES (?, ?)').run('bad', 125);
      throw new Error('simulated failure');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
  const committed = runWrite(async () => {
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO Ledger VALUES (?, ?)').run('good', 250);
    database.exec('COMMIT');
  });

  await assert.rejects(rejected, /simulated failure/);
  await committed;
  const saved = database.prepare('SELECT id, amountMinor FROM Ledger').get();
  assert.equal(saved.id, 'good');
  assert.equal(saved.amountMinor, 250);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM Ledger').get().count, 1);
  database.close();
});

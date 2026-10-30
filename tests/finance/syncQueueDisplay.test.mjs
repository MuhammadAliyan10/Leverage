import test from 'node:test';
import assert from 'node:assert/strict';
import { explainSyncFailure, projectSyncQueueRow } from '../../src/finance/syncQueueDisplay.ts';

test('queued transaction is described with money, category, account, and saved time instead of internal IDs', () => {
  const item = projectSyncQueueRow({
    entityType: 'transaction', operation: 'transaction.create', status: 'pending', createdAt: '2026-10-25T08:00:00.000Z',
    payload: { type: 'expense', amountMinor: '1000000', currency: 'PKR', categoryLabel: 'Transport', occurredAt: '2026-10-25T07:00:00.000Z', note: 'Monthly pass' },
    accountName: 'Daily wallet', destinationName: null,
  });
  assert.equal(item.title, 'Expense · Transport');
  assert.equal(item.detail, 'PKR 10,000.00 · Transport · Daily wallet · Monthly pass');
  assert.equal(item.state, 'Waiting to sync');
  assert.equal(item.reason, null);
  assert.match(item.timestamp, /2026|10|25/);
});

test('queued transfer names both accounts and never describes it as income or spending', () => {
  const item = projectSyncQueueRow({
    entityType: 'transaction', operation: 'transaction.create', status: 'in_flight', createdAt: '2026-10-25T08:00:00.000Z',
    payload: { type: 'transfer', amountMinor: '500000', currency: 'PKR', categoryLabel: 'Internal transfer' },
    accountName: 'Bank', destinationName: 'Savings cash',
  });
  assert.equal(item.title, 'Account transfer');
  assert.match(item.detail, /PKR 5,000.00 · Bank → Savings cash/);
  assert.equal(item.state, 'Syncing now');
});

test('queued account change and rejection explanation are understandable without exposing IDs', () => {
  const item = projectSyncQueueRow({
    entityType: 'account', operation: 'account.create', status: 'rejected', createdAt: 'invalid', errorCategory: 'CLOUD_MUTATION_NOT_AVAILABLE',
    payload: { id: 'internal-id', name: 'JazzCash', type: 'wallet', currency: 'PKR', openingBalanceMinor: '250000' }, accountName: 'JazzCash',
  });
  assert.equal(item.title, 'New account: JazzCash');
  assert.equal(item.detail, 'Wallet · PKR · Opening balance PKR 2,500.00');
  assert.match(item.reason ?? '', /still saved on this device/);
  assert.equal(item.timestamp, 'Time unavailable');
  assert.equal(JSON.stringify(item).includes('internal-id'), false);
});

test('each supported failure class has a usable non-technical explanation', () => {
  for (const category of ['CLOUD_REQUEST_NOT_FOUND', 'CLOUD_FUNCTION_MISSING', 'CLOUD_SCHEMA_TYPE_MISMATCH', 'CLOUD_FUNCTION_UNDEFINED', 'RELATED_RECORD_MISSING', 'FINANCIAL_RECORD_CONFLICT', 'session_expired', 'INVALID_FINANCIAL_RECORD']) {
    const message = explainSyncFailure(category);
    assert.ok(message.length > 40);
    assert.ok(!message.includes('undefined'));
  }
  assert.match(explainSyncFailure('CLOUD_SCHEMA_TYPE_MISMATCH'), /value type did not match/i);
  assert.doesNotMatch(explainSyncFailure('CLOUD_FUNCTION_UNDEFINED'), /not installed/i);
  assert.match(explainSyncFailure('CLOUD_RECORD_ALREADY_EXISTS'), /record with this ID already exists/i);
});

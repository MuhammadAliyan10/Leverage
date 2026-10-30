import test from 'node:test';
import assert from 'node:assert/strict';
import { canRetryRejectedSyncChange, isQueueWideSyncBlock } from '../../src/cloud/syncFailurePolicy.ts';

test('shared API and authentication failures stop uploads before unrelated records are rejected', () => {
  for (const code of ['CLOUD_MUTATION_NOT_AVAILABLE', 'CLOUD_FUNCTION_MISSING', 'CLOUD_RPC_SIGNATURE_MISSING', 'CLOUD_FUNCTION_UNDEFINED', 'CLOUD_SCHEMA_TYPE_MISMATCH', 'CLOUD_REQUEST_NOT_FOUND', 'CLOUD_ENDPOINT_NOT_FOUND', 'CLOUD_PERMISSION_DENIED', 'AUTH_REQUIRED']) {
    assert.equal(isQueueWideSyncBlock(code), true, code);
  }
});

test('record-specific financial validation and revision failures allow unrelated records to proceed', () => {
  for (const code of ['INVALID_FINANCIAL_RECORD', 'FINANCIAL_RULE_REJECTED', 'RELATED_RECORD_MISSING', 'FINANCIAL_RECORD_CONFLICT', 'DUPLICATE_OR_IDEMPOTENCY_CONFLICT']) {
    assert.equal(isQueueWideSyncBlock(code), false, code);
  }
});

test('manual retry only releases transient and authentication failures, never duplicate or invalid financial writes', () => {
  for (const category of ['AUTH_REQUIRED','session_expired','network_or_timeout','DATABASE_UNAVAILABLE']) {
    assert.equal(canRetryRejectedSyncChange(category), true, `${category} should be safe to retry with the same idempotency key`);
  }
  for (const category of ['CLOUD_RECORD_ALREADY_EXISTS','DUPLICATE_OR_IDEMPOTENCY_CONFLICT','CLOUD_RECORD_CONFLICT','INVALID_FINANCIAL_RECORD','server_local_conflict']) {
    assert.equal(canRetryRejectedSyncChange(category), false, `${category} must not be blindly replayed`);
  }
});

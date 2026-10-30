import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNeonRpcDiagnostic, buildNeonRpcUrl, parseNeonRpcErrorBody, withPublicNeonRpcProfile } from '../../src/cloud/neonRpcDiagnostics.ts';

const apiBase = 'https://ep-abc.apirest.c-1.us-east-1.aws.neon.tech/neondb/rest/v1';

test('RPC URL preserves the configured database base path and appends exactly one RPC segment', () => {
  assert.equal(buildNeonRpcUrl(apiBase, 'mizan_apply_mutation'), `${apiBase}/rpc/mizan_apply_mutation`);
  assert.equal(buildNeonRpcUrl(`${apiBase}/`, 'mizan_sync_changes'), `${apiBase}/rpc/mizan_sync_changes`);
  assert.throws(() => buildNeonRpcUrl(`${apiBase}/rpc`, 'mizan_apply_mutation'), /base path/);
  assert.throws(() => buildNeonRpcUrl(apiBase, 'mizan/apply'), /RPC name/);
  assert.throws(() => buildNeonRpcUrl(apiBase.replace('https:', 'http:'), 'mizan_apply_mutation'), /Data API URL/);
});

test('RPC requests can explicitly target public without discarding auth headers', () => {
  const headers = withPublicNeonRpcProfile({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
  assert.equal(headers.get('content-profile'), 'public');
  assert.equal(headers.get('authorization'), 'Bearer test-token');
  assert.equal(headers.get('content-type'), 'application/json');
});

test('Neon error parsing handles PostgREST code/message/details/hint and redacts credentials', () => {
  const error = parseNeonRpcErrorBody(JSON.stringify({
    code: 'PGRST202',
    message: 'Could not find function called by ali@example.com?token=secret-value',
    details: 'Bearer eyJabcdefgh.abcdefgh.abcdefgh',
    hint: 'password=secret-value',
  }));
  assert.equal(error.code, 'PGRST202');
  assert.match(error.message, /\[redacted-email\]/);
  assert.doesNotMatch(error.message, /ali@example.com|secret-value/);
  assert.equal(error.details, 'Bearer [redacted]');
  assert.equal(error.hint, 'password=[redacted]');
});

test('Neon error parser safely handles plain text and malformed JSON once', () => {
  assert.deepEqual(parseNeonRpcErrorBody('Gateway timeout'), {
    code: null, message: 'Gateway timeout', details: null, hint: null,
  });
  assert.deepEqual(parseNeonRpcErrorBody('{broken'), {
    code: null, message: '{broken', details: null, hint: null,
  });
});

test('RPC diagnostics keep method, route and non-secret metadata but never include payload values', () => {
  const payload = JSON.stringify({
    p_operation: 'transaction.create', p_entity_id: null,
    p_payload: { amountMinor: '987654321', note: 'private note', email: 'ali@example.com' },
    p_idempotency_key: 'sensitive-mutation-id',
  });
  const diagnostic = buildNeonRpcDiagnostic({
    status: 404,
    error: { code: 'PGRST202', message: 'function missing', details: null, hint: null },
    method: 'POST',
    endpoint: `${apiBase}/rpc/mizan_apply_mutation?ignored=secret`,
    rpc: 'mizan_apply_mutation',
    contentType: 'application/json; charset=utf-8',
    authorizationPresent: true,
    idempotencyKeyPresent: true,
    body: payload,
  });
  assert.equal(diagnostic.status, 404);
  assert.equal(diagnostic.apiCode, 'PGRST202');
  assert.equal(diagnostic.endpoint, `${apiBase}/rpc/mizan_apply_mutation`);
  assert.equal(diagnostic.request.operation, 'transaction.create');
  assert.deepEqual(diagnostic.request.bodyKeys, ['p_entity_id', 'p_idempotency_key', 'p_operation', 'p_payload']);
  assert.equal(diagnostic.request.authorizationPresent, true);
  assert.equal(diagnostic.request.idempotencyKeyPresent, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /987654321|private note|ali@example.com|sensitive-mutation-id|ignored=secret/);
});

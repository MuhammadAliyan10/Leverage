import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectNeonJwt, readNeonAccessToken } from '../../src/cloud/neonToken.ts';

test('reads a Neon JWT from the managed session response or token endpoint response', () => {
  assert.equal(readNeonAccessToken({ data: { session: { access_token: 'header.session.signature' } } }), 'header.session.signature');
  assert.equal(readNeonAccessToken({ token: 'header.token.signature' }), 'header.token.signature');
  assert.equal(readNeonAccessToken({ data: { access_token: 'header.adapter.signature' } }), 'header.adapter.signature');
  assert.equal(readNeonAccessToken({ data: { session: { token: 'header.payload.signature' } } }), 'header.payload.signature');
});

test('never treats Better Auth opaque session tokens as Neon Data API JWTs', () => {
  assert.equal(readNeonAccessToken({ data: { session: { token: 'opaque-cookie-id' } } }), null);
  assert.equal(readNeonAccessToken(null), null);
  assert.equal(readNeonAccessToken({ data: { session: { access_token: '   ' } } }), null);
});

test('JWT diagnostics expose only claim presence and expiry state', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'private-user', role: 'authenticated', exp: 1 })).toString('base64url');
  assert.deepEqual(inspectNeonJwt(`header.${payload}.signature`), {
    jwtShapeValid: true, hasSubject: true, hasRole: true, hasAuthenticatedRole: true, hasExpiry: true, expired: true,
  });
  assert.deepEqual(inspectNeonJwt('not-a-jwt'), {
    jwtShapeValid: false, hasSubject: false, hasRole: false, hasAuthenticatedRole: false, hasExpiry: false, expired: false,
  });
});

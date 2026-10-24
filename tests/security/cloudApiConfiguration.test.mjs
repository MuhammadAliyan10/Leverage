import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertProductionCloudApiConfigured, assertProductionNeonConfigured, resolveCloudApiBaseUrl, resolveNativeAuthRequestOrigin, resolveNeonAuthUrl, resolveNeonDataApiUrl, withNativeAuthRequestOrigin } from '../../src/cloud/apiConfiguration.ts';

test('cloud API accepts a production HTTPS origin and normalizes its trailing slash', () => {
  assert.equal(resolveCloudApiBaseUrl(' https://mizan-api.fly.dev/ ', false), 'https://mizan-api.fly.dev');
});

test('documentation placeholders cannot enable cloud authentication or sync', () => {
  for (const url of ['https://api.example.invalid', 'https://api.example', 'https://api.example.com', 'https://api.mizan.example.org', 'https://api.example.test']) {
    assert.equal(resolveCloudApiBaseUrl(url, false), null);
  }
});

test('development permits localhost HTTP while production requires a real HTTPS origin', () => {
  assert.equal(resolveCloudApiBaseUrl('http://localhost:3001', true), 'http://localhost:3001');
  assert.equal(resolveCloudApiBaseUrl('http://localhost:3001', false), null);
  assert.equal(resolveCloudApiBaseUrl('https://localhost:3001', false), null);
});

test('malformed, credential-bearing, and path-scoped values fail closed', () => {
  for (const url of ['not a URL', 'https://user:secret@mizan-api.fly.dev', 'https://mizan-api.fly.dev/path', 'https://mizan-api.fly.dev/?token=value']) {
    assert.equal(resolveCloudApiBaseUrl(url, false), null);
  }
});

test('production EAS profiles fail before bundling when no real HTTPS API origin is configured', () => {
  assert.throws(() => assertProductionCloudApiConfigured('production-apk', undefined), /real HTTPS API origin/);
  assert.throws(() => assertProductionCloudApiConfigured('production', 'https://api.example.invalid'), /real HTTPS API origin/);
  assert.throws(() => assertProductionCloudApiConfigured('production', 'http://api.mizan.example'), /real HTTPS API origin/);
  assert.doesNotThrow(() => assertProductionCloudApiConfigured('production', 'https://api.mizan.app'));
  assert.doesNotThrow(() => assertProductionCloudApiConfigured('preview', undefined), 'disposable preview builds can remain offline-only');
});

test('Neon Auth and Data API URLs are accepted only for their expected HTTPS endpoints', () => {
  assert.equal(resolveNeonAuthUrl('https://ep-abc.neonauth.c-1.us-east-1.aws.neon.tech/neondb/auth'), 'https://ep-abc.neonauth.c-1.us-east-1.aws.neon.tech/neondb/auth');
  assert.equal(resolveNeonDataApiUrl('https://ep-abc.apirest.c-1.us-east-1.aws.neon.tech/neondb/rest/v1'), 'https://ep-abc.apirest.c-1.us-east-1.aws.neon.tech/neondb/rest/v1');
  assert.equal(resolveNeonAuthUrl('http://ep-abc.neonauth.c-1.us-east-1.aws.neon.tech/neondb/auth'), null);
  assert.equal(resolveNeonDataApiUrl('https://attacker.example/neondb/rest/v1'), null);
  assert.equal(resolveNeonDataApiUrl('https://ep-abc.apirest.c-1.us-east-1.aws.neon.tech/neondb/rest/v1?token=x'), null);
  assert.throws(() => assertProductionNeonConfigured('production-apk', undefined, undefined), /NEON_AUTH_URL/);
  assert.doesNotThrow(() => assertProductionNeonConfigured('production', 'https://ep-abc.neonauth.c-1.us-east-1.aws.neon.tech/neondb/auth', 'https://ep-abc.apirest.c-1.us-east-1.aws.neon.tech/neondb/rest/v1'));
});

test('native auth fallback origin is derived only from a valid configured Neon Auth endpoint', () => {
  assert.equal(resolveNativeAuthRequestOrigin('https://ep-abc.neonauth.c-1.us-east-1.aws.neon.tech/neondb/auth'), 'https://ep-abc.neonauth.c-1.us-east-1.aws.neon.tech');
  assert.equal(resolveNativeAuthRequestOrigin(undefined), null);
  assert.equal(resolveNativeAuthRequestOrigin('http://ep-abc.neonauth.c-1.us-east-1.aws.neon.tech/neondb/auth'), null);
});

test('only native auth requests missing a usable origin receive the auth-service origin', () => {
  assert.equal(withNativeAuthRequestOrigin(new Headers(), true, 'https://auth.example.test').get('origin'), 'https://auth.example.test');
  assert.equal(withNativeAuthRequestOrigin(new Headers({ origin: 'null' }), true, 'https://auth.example.test').get('origin'), 'https://auth.example.test');
  assert.equal(withNativeAuthRequestOrigin(new Headers({ origin: 'houselog://' }), true, 'https://auth.example.test').get('origin'), 'houselog://');
  assert.equal(withNativeAuthRequestOrigin(new Headers(), false, 'https://auth.example.test').get('origin'), null);
});

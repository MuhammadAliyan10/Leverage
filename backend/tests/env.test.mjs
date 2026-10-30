import assert from 'node:assert/strict';
import { test } from 'node:test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/leverage_test',
  BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  BETTER_AUTH_URL: 'http://localhost:3001',
  ALLOWED_ORIGINS: 'http://localhost:3001',
});
delete process.env.NEON_AUTH_BASE_URL;
delete process.env.NEON_AUTH_JWKS_URL;
delete process.env.NEON_AUTH_AUDIENCE;
delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
const { parseEnvironment } = await import('../src/env.ts');

const base = { ...process.env };
const neon = {
  ...base,
  NEON_AUTH_BASE_URL: 'https://auth.example.test/neondb/auth',
  NEON_AUTH_JWKS_URL: 'https://auth.example.test/neondb/auth/.well-known/jwks.json',
};

test('AI gateway requires a valid server-only encryption key with Neon Auth', () => {
  assert.doesNotThrow(() => parseEnvironment(base));
  assert.throws(() => parseEnvironment(neon), /AI_CREDENTIAL_ENCRYPTION_KEY/);
  assert.throws(() => parseEnvironment({ ...neon, AI_CREDENTIAL_ENCRYPTION_KEY: 'short' }), /AI_CREDENTIAL_ENCRYPTION_KEY/);
  assert.doesNotThrow(() => parseEnvironment({ ...neon, AI_CREDENTIAL_ENCRYPTION_KEY: 'ab'.repeat(32) }));
  assert.throws(() => parseEnvironment({ ...base, AI_CREDENTIAL_ENCRYPTION_KEY: 'ab'.repeat(32) }), /Configure Neon Auth/);
});

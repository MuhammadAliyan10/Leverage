import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginRateLimit } from '../../src/security/loginRateLimit.ts';
import { createPersistedLoginAttempts } from '../../src/security/persistedLoginAttempts.ts';

test('login backoff begins after five failures, increases, and has a bounded maximum', () => {
  const limiter = createLoginRateLimit();
  let attempt = limiter.next(0, 1_000);
  for (let index = 0; index < 3; index += 1) {
    attempt = limiter.next(attempt.failures, 1_000);
    assert.equal(attempt.delayMs, 0);
  }
  attempt = limiter.next(attempt.failures, 1_000);
  assert.equal(attempt.failures, 5);
  assert.equal(attempt.delayMs, 30_000);
  assert.equal(limiter.delayFor(attempt.failures, attempt.blockedUntil, 2_000), 29_000);
  assert.equal(limiter.delayFor(attempt.failures, attempt.blockedUntil, 32_000), 0);
  attempt = limiter.next(attempt.failures, 32_001);
  assert.equal(attempt.delayMs, 60_000);
  for (let index = 0; index < 20; index += 1) attempt = limiter.next(attempt.failures, 100_000);
  assert.equal(attempt.delayMs, 15 * 60_000);
});

test('successful authentication clears the persisted-attempt state in the repository flow', () => {
  const limiter = createLoginRateLimit();
  const blocked = limiter.next(4, 10_000);
  assert.equal(blocked.blockedUntil, 40_000);
  // Success is represented by deleting the database row; a fresh state has no delay.
  assert.equal(limiter.delayFor(0, 0, 10_000), 0);
});

test('persisted lockout survives policy recreation, isolates profiles, and clears after success', async () => {
  const rows = new Map();
  const port = {
    read: async (key) => rows.get(key) ?? null,
    update: async (key, change) => {
      const next = change(rows.get(key) ?? null);
      rows.set(key, next);
      return next;
    },
    clear: async (key) => { rows.delete(key); },
  };
  const policy = createLoginRateLimit();
  const firstRun = createPersistedLoginAttempts(port, policy);
  let retryAfter = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) retryAfter = await firstRun.recordFailure('profile-a', 1_000);
  assert.equal(retryAfter, 30_000);
  assert.equal(await firstRun.remainingDelay('profile-b', 2_000), 0);

  // Simulate app restart: the service object is recreated while durable state remains.
  const afterRestart = createPersistedLoginAttempts(port, createLoginRateLimit());
  assert.equal(await afterRestart.remainingDelay('profile-a', 2_000), 29_000);
  await afterRestart.recordSuccess('profile-a');
  assert.equal(await afterRestart.remainingDelay('profile-a', 2_000), 0);
  assert.equal(await afterRestart.remainingDelay('profile-b', 2_000), 0);
});

test('an interrupted verification does not count as an incorrect password', async () => {
  const rows = new Map();
  const port = {
    read: async (key) => rows.get(key) ?? null,
    update: async (key, change) => { const next=change(rows.get(key)??null); rows.set(key,next); return next; },
    clear: async (key) => { rows.delete(key); },
  };
  const attempts=createPersistedLoginAttempts(port,createLoginRateLimit());
  await attempts.recordFailure('profile-a',1_000);
  const before=await attempts.remainingDelay('profile-a',2_000);
  // Cancellation/verification interruption skips both recordFailure and recordSuccess.
  assert.equal(await attempts.remainingDelay('profile-a',2_000),before);
  assert.equal(rows.get('profile-a').failures,1);
});

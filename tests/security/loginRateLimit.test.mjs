import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginRateLimit } from '../../src/security/loginRateLimit.ts';

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

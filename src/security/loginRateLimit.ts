export interface LoginRateLimit {
  delayFor(failures: number, blockedUntil: number, now?: number): number;
  next(failures: number, now?: number): { failures: number; blockedUntil: number; delayMs: number };
}

const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;
const FAILURES_BEFORE_DELAY = 5;

/** Bounded backoff policy persisted by the local database; it never blocks permanently. */
export function createLoginRateLimit(): LoginRateLimit {
  return {
    delayFor(_failures, blockedUntil, now = Date.now()) {
      return Math.max(0, blockedUntil - now);
    },
    next(failures, now = Date.now()) {
      const nextFailures = failures + 1;
      const exponent = Math.min(Math.max(0, nextFailures - FAILURES_BEFORE_DELAY), 5);
      const delayMs = nextFailures >= FAILURES_BEFORE_DELAY
        ? Math.min(FIRST_DELAY_MS * 2 ** exponent, MAX_DELAY_MS)
        : 0;
      return { failures: nextFailures, blockedUntil: delayMs ? now + delayMs : 0, delayMs };
    },
  };
}

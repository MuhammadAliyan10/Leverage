const MAX_CONCURRENT_REQUESTS_PER_PROFILE = 1;
const activeWork = new Map<string, Set<AbortController>>();

export const AI_REQUEST_LIMITS = {
  maxInputTokens: 4_000,
  maxOutputTokens: 600,
  maxToolInvocations: 2,
  maxDurationMs: 20_000,
  maxConcurrentRequestsPerProfile: MAX_CONCURRENT_REQUESTS_PER_PROFILE,
} as const;

/** Register cancellable work only after the caller has passed local permission checks. */
export function registerAIProfileWork(profileId: string, controller: AbortController): () => void {
  if (!profileId.trim()) throw new Error('An active profile is required for AI work.');
  const tasks = activeWork.get(profileId) ?? new Set<AbortController>();
  if (tasks.size >= MAX_CONCURRENT_REQUESTS_PER_PROFILE) throw new Error('An AI request is already running for this profile.');
  tasks.add(controller);
  activeWork.set(profileId, tasks);
  return () => {
    tasks.delete(controller);
    if (tasks.size === 0) activeWork.delete(profileId);
  };
}

/** Enforces the local time and concurrency bounds for any future AI operation. */
export async function runBoundedAIWork<T>(profileId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const release = registerAIProfileWork(profileId, controller);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let deadlineExceeded = false;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(deadlineExceeded ? 'AI work exceeded its 20 second time limit.' : 'AI work was cancelled.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timedOut = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort();
      reject(new Error('AI work exceeded its 20 second time limit.'));
    }, AI_REQUEST_LIMITS.maxDurationMs);
  });
  try {
    return await Promise.race([work(controller.signal), aborted, timedOut]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
    release();
  }
}

/** Disabling AI, changing profile, or signing out aborts all local follow-up work. */
export function cancelAIProfileWork(profileId: string): void {
  const tasks = activeWork.get(profileId);
  if (!tasks) return;
  for (const controller of tasks) controller.abort();
  activeWork.delete(profileId);
}

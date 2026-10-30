import * as Crypto from 'expo-crypto';

type AuthTrace = { id: string; startedAt: number; lastStage?: string };
let activeTrace: AuthTrace | null = null;
const finishedTraceIds = new Set<string>();

function safeError(error: unknown): { name: string; code?: string; kind: string } {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const name = typeof candidate?.name === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,39}$/.test(candidate.name)
    ? candidate.name : 'Error';
  const code = typeof candidate?.code === 'string' && /^[A-Z0-9_.-]{1,40}$/i.test(candidate.code)
    ? candidate.code : undefined;
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';
  const kind = /timeout|timed out/.test(message) ? 'timeout'
    : /network|fetch|connect|dns|socket/.test(message) ? 'network'
      : /sqlite|database|secure.?store|storage|keychain/.test(message) ? 'local_storage'
        : /credential|unauthorized|invalid password|invalid email/.test(message) ? 'authentication_rejected'
          : 'operation_failed';
  return { name, ...(code ? { code } : {}), kind };
}

export function beginAuthTrace(): string {
  const id = Crypto.randomUUID();
  activeTrace = { id, startedAt: Date.now() };
  authTraceEvent('LOGIN_SUBMITTED');
  return id;
}

export function getActiveAuthTraceId(): string | null { return activeTrace?.id ?? null; }

export function authTraceEvent(
  stage: string,
  details: Record<string, string | number | boolean | null> = {},
  traceId = activeTrace?.id,
): void {
  if (!traceId || !/^[A-Z][A-Z0-9_]{0,63}$/.test(stage)) return;
  const trace = activeTrace?.id === traceId ? activeTrace : null;
  if (trace) trace.lastStage = stage;
  // Only fixed stage names and allowlisted scalar metadata are logged. No form,
  // financial, request, token, cookie, or storage-key values are accepted here.
  console.info('[LEVERAGE_AUTH_TRACE]', JSON.stringify({
    correlationId: traceId,
    stage,
    elapsedMs: trace ? Math.max(0, Date.now() - trace.startedAt) : null,
    ...details,
  }));
}

export async function authTraceOperation<T>(
  traceId: string | null | undefined,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!traceId) return operation();
  authTraceEvent(`${stage}_START`, {}, traceId);
  try {
    const result = await operation();
    authTraceEvent(`${stage}_END`, {}, traceId);
    return result;
  } catch (error) {
    const diagnostic = safeError(error);
    authTraceEvent(`${stage}_ERROR`, {
      errorName: diagnostic.name,
      errorKind: diagnostic.kind,
      ...(diagnostic.code ? { errorCode: diagnostic.code } : {}),
    }, traceId);
    throw error;
  }
}

export function finishAuthTrace(success: boolean, reason?: string, traceId = activeTrace?.id): void {
  if (!traceId || finishedTraceIds.has(traceId)) return;
  authTraceEvent('LOGIN_FINISHED', { success, ...(reason ? { reason } : {}) }, traceId);
  finishedTraceIds.add(traceId);
  if (finishedTraceIds.size > 32) finishedTraceIds.delete(finishedTraceIds.values().next().value!);
  if (activeTrace?.id === traceId) activeTrace = null;
}

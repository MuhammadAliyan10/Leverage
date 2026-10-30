import * as Network from 'expo-network';
import { localDb } from '../src/db/local/client';
import { cloudApiConfigured, cloudFetch } from '../src/cloud/authClient';
import { isQueueWideSyncBlock } from '../src/cloud/syncFailurePolicy';
import { computeRetryDelayMs } from '../src/db/local/syncOutbox';
import { authTraceOperation, getActiveAuthTraceId } from '../src/security/authDiagnostics';

export type CloudSyncState = 'not_configured' | 'offline' | 'syncing' | 'pending' | 'synced' | 'auth_required' | 'action_required';
const activeRuns = new Map<string, { promise: Promise<boolean>; controller: AbortController }>();
const states = new Map<string, CloudSyncState>();
type SyncFailurePhase = 'identity_check' | 'download_before_upload' | 'upload' | 'download_after_upload';
type SyncFailure = { phase: SyncFailurePhase; code: string };
const failures = new Map<string, SyncFailure>();
const subscribers = new Set<(ownerId: string, state: CloudSyncState) => void>();

function setState(ownerId: string, state: CloudSyncState): void {
  states.set(ownerId, state);
  for (const subscriber of subscribers) subscriber(ownerId, state);
}

export function getCloudSyncState(ownerId: string): CloudSyncState { return states.get(ownerId) ?? 'not_configured'; }
export function getCloudSyncFailure(ownerId: string): SyncFailure | null { return failures.get(ownerId) ?? null; }
export function describeCloudSyncFailure(failure: SyncFailure | null): string | null {
  if (!failure) return null;
  const when = failure.phase === 'identity_check' ? 'checking the cloud account'
    : failure.phase === 'download_before_upload' ? 'checking existing cloud records'
      : failure.phase === 'upload' ? 'uploading saved changes' : 'confirming uploaded changes';
  if (failure.code.startsWith('CLOUD_CHANGE_FEED_REJECTED:')) {
    return `Neon rejected the change feed while ${when} (${failure.code.slice('CLOUD_CHANGE_FEED_REJECTED:'.length)}). No unconfirmed local change was removed.`;
  }
  const details: Record<string, string> = {
    IDENTITY_UNAVAILABLE: `The cloud identity check failed before any financial changes were uploaded.`,
    INVALID_CHANGE_PAGE: `Neon returned an invalid change-feed page while ${when}.`,
    CHANGE_FEED_PAGE_LIMIT: `This sync run reached its safe page limit before finishing the cloud history.`,
    AUTH_REQUIRED: `The saved cloud session was not accepted while ${when}.`,
    TRANSIENT_SERVER: `Neon is temporarily unavailable while ${when}.`,
    network_or_timeout: `The connection timed out while ${when}.`,
  };
  return details[failure.code] ?? `Sync stopped while ${when} (${failure.code}). Local financial changes remain saved.`;
}
export function subscribeCloudSyncState(listener: (ownerId: string, state: CloudSyncState) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

async function request(ownerId: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  try { return await cloudFetch(ownerId,path, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

function logSyncDiagnostic(event: Record<string, unknown>): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[sync-diagnostic]', JSON.stringify(event));
}

function safeSyncFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown failure';
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>')
    .slice(0, 220);
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'SERVER_REJECTED';
}

async function upload(ownerId: string, cloudUserId: string, signal: AbortSignal): Promise<{ uploaded: number; blocked: CloudSyncState | null }> {
  let uploaded = 0;
  for (let count = 0; count < 50; count++) {
    if (signal.aborted) return { uploaded, blocked: null };
    const mutation = await localDb.syncOutbox.claimNext({ ownerId, cloudUserId });
    if (!mutation) break;
    let path: string;
    let method: string;
    let body: string | undefined;
    switch (mutation.operation) {
      case 'account.create': path = '/api/v1/finance/accounts'; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'account.update': path = `/api/v1/finance/accounts/${encodeURIComponent(mutation.entityId)}`; method = 'PATCH'; body = JSON.stringify(mutation.payload); break;
      case 'account.archive': path = `/api/v1/finance/accounts/${encodeURIComponent(mutation.entityId)}/archive`; method = 'POST'; break;
      case 'transaction.create': path = '/api/v1/finance/transactions'; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'budget.create': path = '/api/v1/finance/budgets'; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'budget.revise': path = `/api/v1/finance/budgets/${encodeURIComponent(String(mutation.payload.budgetId))}/revisions`; method = 'POST'; body = JSON.stringify({ ...mutation.payload, id: mutation.entityId }); break;
      case 'budget.archive': path = `/api/v1/finance/budgets/${encodeURIComponent(String(mutation.payload.id ?? mutation.entityId))}/archive`; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'saving.goal.create': path = '/api/v1/finance/savings/goals'; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'saving.goal.update': path = `/api/v1/finance/savings/goals/${encodeURIComponent(mutation.entityId)}`; method = 'PATCH'; body = JSON.stringify(mutation.payload); break;
      case 'saving.goal.event': path = `/api/v1/finance/savings/goals/${encodeURIComponent(String(mutation.payload.goalId))}/events`; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'emergency.config.save': path = '/api/v1/finance/emergency-fund/config'; method = 'PUT'; body = JSON.stringify(mutation.payload); break;
      case 'emergency.event': path = '/api/v1/finance/emergency-fund/events'; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'recurring.schedule.create': path = '/api/v1/finance/recurring-schedules'; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'recurring.schedule.update': path = `/api/v1/finance/recurring-schedules/${encodeURIComponent(mutation.entityId)}`; method = 'PATCH'; body = JSON.stringify(mutation.payload); break;
      case 'schedule.occurrence.create': path = `/api/v1/finance/recurring-schedules/${encodeURIComponent(String(mutation.payload.scheduleId))}/occurrences`; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'schedule.occurrence.resolve': path = `/api/v1/finance/recurring-schedules/${encodeURIComponent(String(mutation.payload.scheduleId))}/occurrences/${encodeURIComponent(mutation.entityId)}`; method = 'PUT'; body = JSON.stringify(mutation.payload); break;
      case 'domain.create': path = '/api/v1/finance/domain-records'; method = 'POST'; body = JSON.stringify(mutation.payload); break;
      case 'domain.update': path = `/api/v1/finance/domain-records/${encodeURIComponent(mutation.entityId)}`; method = 'PATCH'; body = JSON.stringify(mutation.payload); break;
      default: throw new Error('The local outbox contains an unsupported operation.');
    }
    try {
      const response = await request(ownerId,path, { method, headers: { 'Idempotency-Key': mutation.mutationId }, ...(body ? { body } : {}) },signal);
      const responseData = await responseBody(response);
      if (response.status === 401 || errorCode(responseData) === 'AUTH_REQUIRED') {
        // Treat Neon 403/28000 as an expired session too. Do not turn a shared
        // auth failure into a permanent rejected financial mutation.
        await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category: 'session_expired', retryAt: Date.now() + 30_000 });
        await localDb.syncOutbox.deferPendingAfterSharedFailure(ownerId);
        return { uploaded, blocked: 'auth_required' };
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const retryAt = Date.now() + computeRetryDelayMs(mutation.attemptCount);
        await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category: errorCode(responseData), retryAt });
        return { uploaded, blocked: null };
      }
      if (!response.ok) {
        const category = errorCode(responseData);
        logSyncDiagnostic({
          step: 'upload_rejected',
          status: response.status,
          operation: mutation.operation,
          entityType: mutation.entityType,
          code: category,
        });
        await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category, permanent: true });
        // A row-level validation or conflict should not hold unrelated records
        // hostage. A missing shared RPC/auth capability, however, must stop the
        // queue so a bad deployment does not mark every remaining row rejected.
        if (isQueueWideSyncBlock(category)) {
          await localDb.syncOutbox.deferPendingAfterSharedFailure(ownerId);
          return { uploaded, blocked: 'action_required' };
        }
        continue;
      }
      await localDb.syncOutbox.acknowledge({ ownerId, cloudUserId, mutationId: mutation.mutationId, response: responseData });
      uploaded++;
    } catch {
      if (signal.aborted) {
        await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category: 'sync_cancelled' });
        return { uploaded, blocked: null };
      }
      const retryAt = Date.now() + computeRetryDelayMs(mutation.attemptCount);
      await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category: 'network_or_timeout', retryAt });
      return { uploaded, blocked: null };
    }
  }
  return { uploaded, blocked: null };
}

async function download(ownerId: string, cloudUserId: string, signal: AbortSignal): Promise<void> {
  let step = 'read_local_cursor';
  let cursor: string;
  try {
    cursor = await localDb.syncOutbox.cursor({ ownerId, cloudUserId });
    logSyncDiagnostic({ step, result:'ok' });
  } catch (error) {
    throw new Error(`SYNC_DOWNLOAD_FAILED:${step}:${error instanceof Error ? error.message : 'unknown error'}`, { cause:error });
  }
  for (let page = 0; page < 1000; page++) {
    if (signal.aborted) throw new Error('SYNC_CANCELLED');
    step = 'request_cloud_change_feed';
    let response: Response;
    try {
      response = await request(ownerId,`/api/v1/sync/changes?after=${encodeURIComponent(cursor)}&limit=250`,{},signal);
      logSyncDiagnostic({ step, status:response.status, ok:response.ok });
    } catch (error) {
      throw new Error(`SYNC_DOWNLOAD_FAILED:${step}:${error instanceof Error ? error.message : 'unknown error'}`, { cause:error });
    }
    if (response.status === 401) throw new Error('AUTH_REQUIRED');
    if (!response.ok) {
      const failure = await responseBody(response);
      const code = errorCode(failure);
      if (response.status === 401 || code === 'AUTH_REQUIRED') throw new Error('AUTH_REQUIRED');
      if (response.status >= 500 || code === 'DATABASE_UNAVAILABLE') throw new Error('TRANSIENT_SERVER');
      throw new Error(`CLOUD_CHANGE_FEED_REJECTED:${code}`);
    }
    step = 'parse_cloud_change_feed';
    const body = await responseBody(response);
    const changes = Array.isArray(body.data) ? body.data.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object')) : null;
    const nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
    if (!changes || !nextCursor || typeof body.hasMore !== 'boolean') throw new Error('INVALID_CHANGE_PAGE');
    const eventTypes = [...new Set(changes.map((change) => typeof change.entityType === 'string' ? change.entityType : 'invalid'))].sort();
    logSyncDiagnostic({ step, status:response.status, changeCount:changes.length, eventTypes, hasMore:body.hasMore });
    step = 'apply_and_commit_cloud_changes';
    try {
      await localDb.syncOutbox.applyChanges({ ownerId, cloudUserId, changes, nextCursor });
    } catch (error) {
      throw new Error(`SYNC_DOWNLOAD_FAILED:${step}:${error instanceof Error ? error.message : 'unknown error'}`, { cause:error });
    }
    logSyncDiagnostic({ step, result:'committed', cursorAdvanced:true });
    cursor = nextCursor;
    if (!body.hasMore) return;
  }
  throw new Error('CHANGE_FEED_PAGE_LIMIT');
}

async function run(ownerId: string, signal: AbortSignal): Promise<boolean> {
  failures.delete(ownerId);
  if (!cloudApiConfigured) { setState(ownerId, 'not_configured'); return false; }
  const identity = await localDb.cloudIdentity.get(ownerId);
  if (!identity?.syncEnabled) { setState(ownerId, 'not_configured'); return false; }
  const network = await Network.getNetworkStateAsync().catch(() => null);
  // `isInternetReachable` can be false/unknown on browser and some Android
  // networks even when Neon is reachable. Use connectivity as a hint only;
  // the authenticated request is the authoritative reachability check.
  if (network?.isConnected === false) { setState(ownerId, 'offline'); return false; }
  setState(ownerId, 'syncing');
  let phase: SyncFailurePhase = 'identity_check';
  try {
    const traceId = getActiveAuthTraceId();
    const verified = await authTraceOperation(traceId, 'IDENTITY_VERIFICATION', () => request(ownerId,'/api/v1/sync/identity',{},signal));
    if (verified.status === 401) { failures.set(ownerId, { phase, code: 'AUTH_REQUIRED' }); setState(ownerId, 'auth_required'); return false; }
    if (!verified.ok) {
      const failure = await responseBody(verified);
      if (errorCode(failure) === 'AUTH_REQUIRED') { failures.set(ownerId, { phase, code: 'AUTH_REQUIRED' }); setState(ownerId, 'auth_required'); return false; }
      throw new Error('IDENTITY_UNAVAILABLE');
    }
    const body = await responseBody(verified);
    if (body.userId !== identity.cloudUserId) { failures.set(ownerId, { phase, code: 'AUTH_REQUIRED' }); setState(ownerId, 'auth_required'); return false; }
    // Pull first so records already created in Neon (for example from another
    // device or an earlier browser session) are mapped locally before queued
    // create requests are retried. This prevents duplicate primary-key writes.
    phase = 'download_before_upload';
    await download(ownerId, identity.cloudUserId, signal);
    phase = 'upload';
    const pushed = await upload(ownerId, identity.cloudUserId,signal);
    if (pushed.blocked) { failures.set(ownerId, { phase, code: pushed.blocked === 'auth_required' ? 'AUTH_REQUIRED' : 'ACTION_REQUIRED' }); setState(ownerId, pushed.blocked); return false; }
    phase = 'download_after_upload';
    await download(ownerId, identity.cloudUserId,signal);
    const rejected = await localDb.syncOutbox.rejectedCount(ownerId);
    const pending = await localDb.syncOutbox.pendingCount(ownerId);
    if (!rejected && !pending) await localDb.syncOutbox.markSuccessful({ ownerId, cloudUserId: identity.cloudUserId });
    setState(ownerId, rejected ? 'action_required' : pending ? 'pending' : 'synced');
    return !rejected && !pending;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message !== 'SYNC_CANCELLED') {
      const code = message.startsWith('CLOUD_CHANGE_FEED_REJECTED:') ? message
        : message === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED'
          : message === 'TRANSIENT_SERVER' || message === 'network_or_timeout' ? message
            : message || 'UNKNOWN_SYNC_FAILURE';
      failures.set(ownerId, { phase, code });
      logSyncDiagnostic({
        step: 'sync_failed',
        phase,
        code: message.startsWith('SYNC_DOWNLOAD_FAILED:apply_and_commit_cloud_changes:') ? 'LOCAL_CLOUD_CHANGE_APPLY_FAILED' : code.slice(0, 80),
        detail: safeSyncFailureDetail(error),
      });
      setState(ownerId, message === 'AUTH_REQUIRED' ? 'auth_required'
        : message === 'TRANSIENT_SERVER' || message === 'network_or_timeout' ? 'offline'
          : 'action_required');
    }
    return false;
  }
}

/** One serialized, bounded sync run per local profile. Retried mutations keep their original idempotency key. */
export function syncOfflineData(ownerId: string): Promise<boolean> {
  const current = activeRuns.get(ownerId);
  if (current) return current.promise;
  const controller = new AbortController();
  const currentRun = run(ownerId,controller.signal).finally(() => activeRuns.delete(ownerId));
  activeRuns.set(ownerId, { promise: currentRun, controller });
  return currentRun;
}

export function cancelCloudSync(ownerId: string): void { activeRuns.get(ownerId)?.controller.abort(); }

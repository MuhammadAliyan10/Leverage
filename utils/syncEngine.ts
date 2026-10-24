import * as Network from 'expo-network';
import { localDb } from '../src/db/local/client';
import { cloudApiConfigured, cloudFetch } from '../src/cloud/authClient';
import { computeRetryDelayMs } from '../src/db/local/syncOutbox';

export type CloudSyncState = 'not_configured' | 'offline' | 'syncing' | 'pending' | 'synced' | 'auth_required' | 'action_required';
const activeRuns = new Map<string, { promise: Promise<boolean>; controller: AbortController }>();
const states = new Map<string, CloudSyncState>();
const subscribers = new Set<(ownerId: string, state: CloudSyncState) => void>();

function setState(ownerId: string, state: CloudSyncState): void {
  states.set(ownerId, state);
  for (const subscriber of subscribers) subscriber(ownerId, state);
}

export function getCloudSyncState(ownerId: string): CloudSyncState { return states.get(ownerId) ?? 'not_configured'; }
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
      case 'budget.archive': path = `/api/v1/finance/budgets/${encodeURIComponent(mutation.entityId)}/archive`; method = 'POST'; break;
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
      if (response.status === 401) {
        await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category: 'session_expired' });
        return { uploaded, blocked: 'auth_required' };
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const retryAt = Date.now() + computeRetryDelayMs(mutation.attemptCount);
        await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category: errorCode(responseData), retryAt });
        return { uploaded, blocked: null };
      }
      if (!response.ok) {
        await localDb.syncOutbox.fail({ ownerId, mutationId: mutation.mutationId, category: errorCode(responseData), permanent: true });
        return { uploaded, blocked: 'action_required' };
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
  let cursor = await localDb.syncOutbox.cursor({ ownerId, cloudUserId });
  for (let page = 0; page < 1000; page++) {
    if (signal.aborted) throw new Error('SYNC_CANCELLED');
    const response = await request(ownerId,`/api/v1/sync/changes?after=${encodeURIComponent(cursor)}&limit=250`,{},signal);
    if (response.status === 401) throw new Error('AUTH_REQUIRED');
    if (!response.ok) throw new Error(response.status >= 500 ? 'TRANSIENT_SERVER' : 'SYNC_REJECTED');
    const body = await responseBody(response);
    const changes = Array.isArray(body.data) ? body.data.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object')) : null;
    const nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
    if (!changes || !nextCursor || typeof body.hasMore !== 'boolean') throw new Error('INVALID_CHANGE_PAGE');
    await localDb.syncOutbox.applyChanges({ ownerId, cloudUserId, changes, nextCursor });
    cursor = nextCursor;
    if (!body.hasMore) return;
  }
  throw new Error('CHANGE_FEED_PAGE_LIMIT');
}

async function run(ownerId: string, signal: AbortSignal): Promise<boolean> {
  if (!cloudApiConfigured) { setState(ownerId, 'not_configured'); return false; }
  const identity = await localDb.cloudIdentity.get(ownerId);
  if (!identity?.syncEnabled) { setState(ownerId, 'not_configured'); return false; }
  const network = await Network.getNetworkStateAsync().catch(() => null);
  if (!network?.isConnected || network.isInternetReachable === false) { setState(ownerId, 'offline'); return false; }
  setState(ownerId, 'syncing');
  try {
    const verified = await request(ownerId,'/api/v1/sync/identity',{},signal);
    if (verified.status === 401) { setState(ownerId, 'auth_required'); return false; }
    if (!verified.ok) throw new Error('IDENTITY_UNAVAILABLE');
    const body = await responseBody(verified);
    if (body.userId !== identity.cloudUserId) { setState(ownerId, 'auth_required'); return false; }
    const pushed = await upload(ownerId, identity.cloudUserId,signal);
    if (pushed.blocked) { setState(ownerId, pushed.blocked); return false; }
    await download(ownerId, identity.cloudUserId,signal);
    const rejected = await localDb.syncOutbox.rejectedCount(ownerId);
    const pending = await localDb.syncOutbox.pendingCount(ownerId);
    if (!rejected && !pending) await localDb.syncOutbox.markSuccessful({ ownerId, cloudUserId: identity.cloudUserId });
    setState(ownerId, rejected ? 'action_required' : pending ? 'pending' : 'synced');
    return !rejected && !pending;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message !== 'SYNC_CANCELLED') setState(ownerId, message === 'AUTH_REQUIRED' ? 'auth_required' : 'offline');
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

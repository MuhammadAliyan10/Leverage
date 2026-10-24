import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { resolveNeonAuthUrl, resolveNeonDataApiUrl } from './apiConfiguration';

export const neonAuthUrl = resolveNeonAuthUrl(process.env.EXPO_PUBLIC_NEON_AUTH_URL);
export const neonDataApiUrl = resolveNeonDataApiUrl(process.env.EXPO_PUBLIC_NEON_DATA_API_URL);
export const cloudApiConfigured = neonAuthUrl !== null && neonDataApiUrl !== null;
const tokenKey = (ownerId: string) => `mizan-neon-jwt-${encodeURIComponent(ownerId)}`;

async function saveJwt(ownerId: string, token: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(tokenKey(ownerId), token);
  } else await SecureStore.setItemAsync(tokenKey(ownerId), token);
}

export async function getNeonJwt(ownerId: string): Promise<string | null> {
  if (Platform.OS === 'web') return typeof window === 'undefined' ? null : window.sessionStorage.getItem(tokenKey(ownerId));
  return SecureStore.getItemAsync(tokenKey(ownerId));
}

async function clearJwt(ownerId: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(tokenKey(ownerId));
  } else await SecureStore.deleteItemAsync(tokenKey(ownerId));
}

/** Cloud identity uses Neon Auth. Device profiles and the local ledger remain in SQLite. */
type CloudAuthClient = ReturnType<typeof createAuthClient> & { getCookie: () => Promise<string> };
const clients = new Map<string, CloudAuthClient>();
export function getCloudAuthClient(ownerId: string) {
  if (!ownerId.trim() || ownerId.length > 128) throw new Error('A valid local profile is required for cloud authentication.');
  if (!neonAuthUrl) throw new Error('Neon Auth is not configured for this build.');
  let client = clients.get(ownerId);
  if (!client) {
    const profileKey = encodeURIComponent(ownerId);
    client = createAuthClient({
      baseURL: neonAuthUrl,
      fetchOptions: {
        customFetchImpl: async (input, init) => {
          const response = await fetch(input, { ...init, credentials: 'include' });
          const jwt = response.headers.get('set-auth-jwt');
          if (jwt) await saveJwt(ownerId, jwt);
          return response;
        },
      },
      plugins: Platform.OS === 'web' ? [] : [expoClient({
        scheme: 'houselog',
        storagePrefix: `mizan-cloud-auth-${profileKey}`,
        storage: SecureStore,
      })],
    }) as CloudAuthClient;
    clients.set(ownerId, client);
  }
  return client;
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function mutationFor(path: string, method: string): { operation: string; entityId: string | null } | null {
  const segments = path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  const financeIndex = segments.indexOf('finance');
  if (financeIndex < 0) return null;
  const resource = segments[financeIndex + 1];
  const id = segments[financeIndex + 2] ?? null;
  if (resource === 'accounts') return method === 'POST' ? { operation: 'account.create', entityId: null } : id && segments.at(-1) === 'archive' ? { operation: 'account.archive', entityId: id } : id && method === 'PATCH' ? { operation: 'account.update', entityId: id } : null;
  if (resource === 'transactions' && method === 'POST') return { operation: 'transaction.create', entityId: null };
  if (resource === 'budgets') return method === 'POST' ? { operation: 'budget.create', entityId: null } : id && segments.at(-1) === 'archive' ? { operation: 'budget.archive', entityId: id } : id && segments.at(-1) === 'revisions' ? { operation: 'budget.revise', entityId: id } : null;
  if (resource === 'savings' && segments[financeIndex + 2] === 'goals') {
    const goalId = segments[financeIndex + 3] ?? null;
    return method === 'POST' ? { operation: goalId ? 'saving.goal.event' : 'saving.goal.create', entityId: goalId } : goalId ? { operation: 'saving.goal.update', entityId: goalId } : null;
  }
  if (resource === 'emergency-fund') return path.includes('/config') ? { operation: 'emergency.config.save', entityId: null } : { operation: 'emergency.event', entityId: null };
  if (resource === 'recurring-schedules') {
    const scheduleId = segments[financeIndex + 2] ?? null;
    if (path.includes('/occurrences')) return method === 'PUT' ? { operation: 'schedule.occurrence.resolve', entityId: segments.at(-1) ?? null } : { operation: 'schedule.occurrence.create', entityId: scheduleId };
    return method === 'POST' ? { operation: 'recurring.schedule.create', entityId: null } : scheduleId ? { operation: 'recurring.schedule.update', entityId: scheduleId } : null;
  }
  if (resource === 'domain-records') return method === 'PATCH' && id
    ? { operation: 'domain.update', entityId: id }
    : method === 'POST' ? { operation: 'domain.create', entityId: null } : null;
  return null;
}

/** Translate the app's existing sync contract to Neon Data API RPCs; no app-hosted server is required. */
export async function cloudFetch(ownerId: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (!cloudApiConfigured || !neonDataApiUrl) throw new Error('Neon Auth and Data API must both be configured in this build.');
  if (!path.startsWith('/api/v1/')) throw new Error('Cloud API path is invalid.');
  // Neon Auth refreshes the API JWT alongside its persisted session cookie.
  await getCloudAuthClient(ownerId).getSession().catch(() => undefined);
  const jwt = await getNeonJwt(ownerId);
  if (!jwt) return jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in to Neon Auth again to sync.' } });

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${jwt}`);
  headers.set('Content-Type', 'application/json');
  let rpc: string;
  let payload: Record<string, unknown>;
  if (path.startsWith('/api/v1/sync/identity')) {
    rpc = 'mizan_sync_identity'; payload = {};
  } else if (path.startsWith('/api/v1/sync/changes')) {
    const query = new URL(path, 'https://local.invalid').searchParams;
    rpc = 'mizan_sync_changes';
    payload = { p_after: query.get('after') ?? '0', p_limit: Number(query.get('limit') ?? 250) };
  } else {
    const mutation = mutationFor(path, init.method ?? 'GET');
    if (!mutation) return jsonResponse(404, { error: { code: 'UNSUPPORTED_CLOUD_OPERATION', message: 'This cloud operation is not supported.' } });
    rpc = 'mizan_apply_mutation';
    payload = {
      p_operation: mutation.operation,
      p_entity_id: mutation.entityId,
      p_payload: init.body ? JSON.parse(String(init.body)) : {},
      p_idempotency_key: headers.get('Idempotency-Key'),
    };
  }
  const response = await fetch(`${neonDataApiUrl}/rpc/${rpc}`, {
    method: 'POST', headers, body: JSON.stringify(payload), signal: init.signal,
  });
  const result = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 409 ? 'IDEMPOTENCY_CONFLICT' : response.status >= 500 ? 'DATABASE_UNAVAILABLE' : 'SERVER_REJECTED';
    return jsonResponse(response.status, { error: { code, message: 'Neon rejected this cloud request.' } });
  }
  return jsonResponse(200, result);
}

export async function clearNeonToken(ownerId: string): Promise<void> { await clearJwt(ownerId); }

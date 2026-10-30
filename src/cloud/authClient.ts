import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { classifyNeonDataApiFailure, resolveNativeAuthRequestOrigin, resolveNeonAuthUrl, resolveNeonDataApiUrl, withNativeAuthRequestOrigin } from './apiConfiguration';
import { buildNeonRpcDiagnostic, buildNeonRpcUrl, parseNeonRpcErrorBody, withPublicNeonRpcProfile } from './neonRpcDiagnostics';
import { inspectNeonJwt, readNeonAccessToken } from './neonToken';
import { authTraceEvent, authTraceOperation, getActiveAuthTraceId } from '../security/authDiagnostics';

export const neonAuthUrl = resolveNeonAuthUrl(process.env.EXPO_PUBLIC_NEON_AUTH_URL);
const nativeAuthRequestOrigin = resolveNativeAuthRequestOrigin(process.env.EXPO_PUBLIC_NEON_AUTH_URL);
export const neonDataApiUrl = resolveNeonDataApiUrl(process.env.EXPO_PUBLIC_NEON_DATA_API_URL);
export const cloudApiConfigured = neonAuthUrl !== null && neonDataApiUrl !== null;
// Never leave the authentication form waiting forever when a mobile network or
// the auth provider stops responding. Better Fetch aborts the request at this limit.
const AUTH_REQUEST_TIMEOUT_MS = 20_000;
const tokenKey = (ownerId: string) => `mizan-neon-jwt-${encodeURIComponent(ownerId)}`;
// Neon Auth may return the Data API JWT in a response header while Better Auth
// refreshes its saved session. Keep that freshly issued token available to the
// current sync request instead of relying on an opaque Better Auth session id.
const freshlyIssuedJwt = new Map<string, string>();

function traceSecureStoreSync<T>(stage: string, operation: () => T): T {
  const traceId = getActiveAuthTraceId() ?? undefined;
  authTraceEvent(`${stage}_START`, {}, traceId);
  try {
    const result = operation();
    authTraceEvent(`${stage}_END`, {}, traceId);
    return result;
  } catch (error) {
    authTraceEvent(`${stage}_ERROR`, { errorKind: error instanceof Error ? 'local_storage' : 'unknown' }, traceId);
    throw error;
  }
}

const tracedSecureStore = {
  getItem: (key: string, options?: SecureStore.SecureStoreOptions) => traceSecureStoreSync('SECURESTORE_SYNC_GET', () => SecureStore.getItem(key, options)),
  setItem: (key: string, value: string, options?: SecureStore.SecureStoreOptions) => traceSecureStoreSync('SECURESTORE_SYNC_SET', () => SecureStore.setItem(key, value, options)),
  getItemAsync: (key: string, options?: SecureStore.SecureStoreOptions) => authTraceOperation(
    getActiveAuthTraceId(), 'SECURESTORE_GET', () => SecureStore.getItemAsync(key, options),
  ),
  setItemAsync: (key: string, value: string, options?: SecureStore.SecureStoreOptions) => authTraceOperation(
    getActiveAuthTraceId(), 'SECURESTORE_SET', () => SecureStore.setItemAsync(key, value, options),
  ),
};

async function saveJwt(ownerId: string, token: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(tokenKey(ownerId), token);
  } else await SecureStore.setItemAsync(tokenKey(ownerId), token);
}

export async function getNeonJwt(ownerId: string): Promise<string | null> {
  if (Platform.OS === 'web') return typeof window === 'undefined' ? null : window.sessionStorage.getItem(tokenKey(ownerId));
  return SecureStore.getItemAsync(tokenKey(ownerId));
}

/** Get a fresh, signed Data API JWT through the already-saved Neon Auth session. */
async function refreshNeonJwt(ownerId: string): Promise<string | null> {
  const client = getCloudAuthClient(ownerId);
  freshlyIssuedJwt.delete(ownerId);
  try {
    // Neon Auth's GET /token is the canonical source for a Data API JWT. Reading
    // getSession() first can return a cached Better Auth session shape, which is
    // not necessarily Neon Auth's JWT-enriched session representation.
    const tokenResponse: unknown = await client.$fetch('/token', { method: 'GET' });
    const issuedByTokenEndpoint = freshlyIssuedJwt.get(ownerId);
    freshlyIssuedJwt.delete(ownerId);
    const token = issuedByTokenEndpoint ?? readNeonAccessToken(tokenResponse);
    if (token && isUsableNeonJwt(token)) {
      await saveJwt(ownerId, token);
      return token;
    }
  } catch {
    // Fall through to a fresh session response; never mistake a local Leverage
    // profile identifier for a Neon credential.
  }

  try {
    const session: unknown = await client.getSession({ query: { disableCookieCache: true } });
    const issuedBySession = freshlyIssuedJwt.get(ownerId);
    freshlyIssuedJwt.delete(ownerId);
    const token = issuedBySession ?? readNeonAccessToken(session);
    if (token && isUsableNeonJwt(token)) {
      await saveJwt(ownerId, token);
      return token;
    }
  } catch {
    // Report an unavailable credential to sync; do not send a stale cached JWT.
  }
  return null;
}

function isUsableNeonJwt(token: string): boolean {
  const claims = inspectNeonJwt(token);
  return claims.jwtShapeValid && claims.hasSubject && claims.hasAuthenticatedRole && claims.hasExpiry && !claims.expired;
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
        timeout: AUTH_REQUEST_TIMEOUT_MS,
        customFetchImpl: async (input, init) => {
          const requestHeaders = new Headers(init?.headers);
          if (input instanceof Request) input.headers.forEach((value, key) => { if (!requestHeaders.has(key)) requestHeaders.set(key, value); });
          const headers = withNativeAuthRequestOrigin(requestHeaders, Platform.OS !== 'web', nativeAuthRequestOrigin);
          const response = await authTraceOperation(getActiveAuthTraceId(), 'NEON_AUTH_HTTP_FETCH', () => fetch(input, { ...init, headers, credentials: 'include' }));
          const jwt = response.headers.get('set-auth-jwt');
          if (jwt) {
            freshlyIssuedJwt.set(ownerId, jwt);
            await authTraceOperation(getActiveAuthTraceId(), 'NEON_JWT_STORAGE', () => saveJwt(ownerId, jwt));
          }
          return response;
        },
      },
      plugins: Platform.OS === 'web' ? [] : [expoClient({
        scheme: 'houselog',
        storagePrefix: `mizan-cloud-auth-${profileKey}`,
        storage: tracedSecureStore,
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
  // Get a current JWT from the saved Neon Auth session before every API call.
  // Never silently fall back to an expired JWT after a failed refresh.
  const jwt = await refreshNeonJwt(ownerId);
  if (!jwt) return jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in to Neon Auth again to sync.' } });

  const headers = withPublicNeonRpcProfile(init.headers ?? {});
  headers.set('Authorization', `Bearer ${jwt}`);
  headers.set('Content-Type', 'application/json');
  let rpc: string;
  let payload: Record<string, unknown>;
  if (path.startsWith('/api/v1/sync/identity')) {
    rpc = 'leverage_sync_identity'; payload = {};
  } else if (path.startsWith('/api/v1/sync/changes')) {
    const query = new URL(path, 'https://local.invalid').searchParams;
    rpc = 'mizan_sync_changes';
    payload = { p_after: query.get('after') ?? '0', p_limit: Number(query.get('limit') ?? 250) };
  } else if (path === '/api/v1/sync/reconcile-account-create') {
    rpc = 'mizan_reconcile_account_create';
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse(400, { error: { code: 'INVALID_RECONCILIATION_REQUEST', message: 'Account reconciliation request is invalid.' } });
    const request = body as Record<string, unknown>;
    if (typeof request.entityId !== 'string' || typeof request.mutationId !== 'string' || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload) || typeof request.currentBalanceMinor !== 'string' || typeof request.commit !== 'boolean') {
      return jsonResponse(400, { error: { code: 'INVALID_RECONCILIATION_REQUEST', message: 'Account reconciliation request is invalid.' } });
    }
    payload = {
      p_entity_id: request.entityId,
      p_idempotency_key: request.mutationId,
      p_payload: request.payload,
      p_expected_current_balance_minor: request.currentBalanceMinor,
      p_commit: request.commit,
    };
  } else if (path === '/api/v1/projects' && (init.method ?? 'GET') === 'POST') {
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse(400, { error: { code: 'INVALID_PROJECT_CREATE', message: 'Project creation request is invalid.' } });
    const request = body as Record<string, unknown>;
    if (!request.project || typeof request.project !== 'object' || Array.isArray(request.project) || typeof request.ownerMemberId !== 'string') return jsonResponse(400, { error: { code: 'INVALID_PROJECT_CREATE', message: 'Project creation request is invalid.' } });
    rpc = 'mizan_project_create'; payload = { p_project: request.project, p_owner_member_id: request.ownerMemberId, p_idempotency_key: headers.get('Idempotency-Key') };
  } else if (path === '/api/v1/projects/invitations' && (init.method ?? 'GET') === 'POST') {
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse(400, { error: { code: 'INVALID_PROJECT_INVITATION', message: 'Invitation request is invalid.' } });
    const request = body as Record<string, unknown>;
    if (typeof request.projectId !== 'string' || typeof request.email !== 'string' || typeof request.role !== 'string' || typeof request.token !== 'string' || typeof request.memberId !== 'string') return jsonResponse(400, { error: { code: 'INVALID_PROJECT_INVITATION', message: 'Invitation request is invalid.' } });
    rpc = 'mizan_project_invite'; payload = { p_project_id: request.projectId, p_email: request.email, p_role: request.role, p_token: request.token, p_member_id: request.memberId };
  } else if (path === '/api/v1/projects/invitations/accept' && (init.method ?? 'GET') === 'POST') {
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).token !== 'string') return jsonResponse(400, { error: { code: 'INVALID_PROJECT_INVITATION', message: 'Invitation acceptance is invalid.' } });
    rpc = 'mizan_project_accept'; payload = { p_token: (body as Record<string, unknown>).token };
  } else if (/^\/api\/v1\/projects\/[^/]+\/mutations$/.test(path) && (init.method ?? 'GET') === 'POST') {
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    const projectId = decodeURIComponent(path.split('/')[3] ?? '');
    if (!projectId || !body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).operation !== 'string' || !(body as Record<string, unknown>).payload || typeof (body as Record<string, unknown>).payload !== 'object') return jsonResponse(400, { error: { code: 'INVALID_PROJECT_MUTATION', message: 'Project update is invalid.' } });
    const request = body as Record<string, unknown>;
    rpc = 'mizan_project_apply'; payload = { p_project_id: projectId, p_operation: request.operation, p_payload: request.payload, p_idempotency_key: headers.get('Idempotency-Key') };
  } else if (/^\/api\/v1\/projects\/[^/]+\/members\/[^/]+$/.test(path) && (init.method ?? 'GET') === 'DELETE') {
    const segments = path.split('/').map(decodeURIComponent);
    rpc = 'mizan_project_remove_member'; payload = { p_project_id: segments[3], p_member_id: segments[5] };
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
  const method = 'POST';
  const requestBody = JSON.stringify(payload);
  const rpcUrl = buildNeonRpcUrl(neonDataApiUrl, rpc);
  const response = await fetch(rpcUrl, { method, headers, body: requestBody, signal: init.signal });
  const responseText = await response.text().catch(() => '');
  if (!response.ok) {
    const neonError = parseNeonRpcErrorBody(responseText);
    const code = classifyNeonDataApiFailure(response.status, neonError);
    const diagnostic = buildNeonRpcDiagnostic({
      status: response.status,
      error: neonError,
      method,
      endpoint: rpcUrl,
      rpc,
      contentType: headers.get('Content-Type'),
      authorizationPresent: headers.has('Authorization'),
      idempotencyKeyPresent: headers.has('Idempotency-Key'),
      body: requestBody,
    });
    // The diagnostic contains only sanitized protocol/error metadata. Never log
    // auth material, idempotency values, financial payload values, or cookies.
    // A rejected cloud RPC is surfaced through the sync/auth UI. Keep it out of
    // React Native's fatal-looking LogBox overlay so users can still use local
    // records and inspect the actionable in-app sync status.
    console.warn('[Leverage] Neon Data API RPC rejected', JSON.stringify({
      ...diagnostic,
      token: inspectNeonJwt(jwt),
    }));
    return jsonResponse(response.status, { error: { code, message: 'Neon rejected this cloud request.' } });
  }
  let result: unknown = null;
  try { result = responseText ? JSON.parse(responseText) as unknown : null; }
  catch { result = { error: { code: 'INVALID_CLOUD_RESPONSE', message: 'Neon returned an unreadable response.' } }; }
  return jsonResponse(response.ok ? 200 : response.status, result);
}

export async function clearNeonToken(ownerId: string): Promise<void> { await clearJwt(ownerId); }

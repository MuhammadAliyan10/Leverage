import { Platform } from 'react-native';
import { getFreshNeonJwt } from '../cloud/authClient';
import { resolveConfiguredAIGatewayBaseUrl } from '../cloud/apiConfiguration';
import type { AIProfileConfig, AIReadScope, OpenAIModelId } from './config';

// AI routes are part of the existing Hono API. A dedicated override is useful
// for staging, while ordinary builds reuse the already-configured cloud API.
const gatewayBaseUrl = resolveConfiguredAIGatewayBaseUrl(
  process.env.EXPO_PUBLIC_AI_GATEWAY_URL,
  process.env.EXPO_PUBLIC_MIZAN_API_URL,
  __DEV__,
);
const REQUEST_TIMEOUT_MS = 16_000;

export interface RemoteAISettings {
  model: OpenAIModelId;
  enabled: boolean;
  permissions: Record<AIReadScope, boolean>;
  consentAcceptedAt: string | null;
  credentialForwardingConsentAcceptedAt: string | null;
  connectionStatus: AIProfileConfig['connectionStatus'];
  lastValidatedAt: string | null;
  monthlyRequestLimit: 30 | 60 | 120;
  monthlyRequestCount: number;
  maximumMonthlyRequests: number;
  hasCredential: boolean;
}

export class AIGatewayError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'AIGatewayError';
  }
}

function mergeSignals(signal?: AbortSignal): { signal: AbortSignal; didTimeout: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error('AI gateway request timed out.')); }, REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  return { signal: controller.signal, didTimeout: () => timedOut, dispose: () => { clearTimeout(timeout); signal?.removeEventListener('abort', abortFromCaller); } };
}

async function request<T>(ownerId: string, path: string, options: {
  method?: 'GET' | 'PUT' | 'DELETE' | 'POST'; body?: unknown; signal?: AbortSignal;
} = {}): Promise<T> {
  if (Platform.OS === 'web') throw new AIGatewayError('AI_NATIVE_ONLY', 'AI settings require the authenticated native app.');
  if (!gatewayBaseUrl) throw new AIGatewayError('AI_GATEWAY_NOT_CONFIGURED', 'This build has no configured secure AI gateway.');
  if (!ownerId.trim()) throw new AIGatewayError('AUTH_REQUIRED', 'Unlock the active profile first.');
  const token = await getFreshNeonJwt(ownerId);
  if (!token) throw new AIGatewayError('AUTH_REQUIRED', 'Connect this profile to Neon Auth before configuring AI.');
  const merged = mergeSignals(options.signal);
  try {
    const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${gatewayBaseUrl}/api/v1/ai${path}`, {
      method: options.method ?? 'GET', headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: merged.signal,
      redirect: 'error',
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const root = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : {};
      const code = typeof error.code === 'string' ? error.code : 'AI_GATEWAY_ERROR';
      const message = typeof error.message === 'string' ? error.message : 'AI gateway rejected the request.';
      throw new AIGatewayError(code, message, response.status);
    }
    const root = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    if (!root.data || typeof root.data !== 'object') throw new AIGatewayError('AI_GATEWAY_RESPONSE_INVALID', 'AI gateway returned an invalid response.', response.status);
    return root.data as T;
  } catch (error) {
    if (error instanceof AIGatewayError) throw error;
    if (options.signal?.aborted) throw new AIGatewayError('AI_REQUEST_CANCELLED', 'AI request was cancelled.');
    if (merged.didTimeout()) throw new AIGatewayError('AI_GATEWAY_TIMEOUT', 'The secure AI gateway timed out. Try again later.');
    throw new AIGatewayError('AI_GATEWAY_UNAVAILABLE', 'The secure AI gateway could not be reached.');
  } finally { merged.dispose(); }
}

export const aiGatewayClient = {
  get configured(): boolean { return Boolean(gatewayBaseUrl) && Platform.OS !== 'web'; },
  getSettings(ownerId: string, signal?: AbortSignal) {
    return request<RemoteAISettings>(ownerId, '/settings', { signal });
  },
  updateSettings(ownerId: string, input: {
    model: OpenAIModelId; enabled: boolean; permissions: Record<AIReadScope, boolean>;
    dataConsentAccepted: boolean; credentialForwardingConsentAccepted: boolean; monthlyRequestLimit: 30 | 60 | 120;
  }, signal?: AbortSignal) {
    return request<RemoteAISettings>(ownerId, '/settings', { method: 'PUT', body: input, signal });
  },
  testConnection(ownerId: string, model: OpenAIModelId, signal?: AbortSignal) {
    return request<RemoteAISettings & { validatedAt: string }>(ownerId, '/connection-test', { method: 'POST', body: { model }, signal });
  },
  saveCredential(ownerId: string, apiKey: string, signal?: AbortSignal) {
    return request<RemoteAISettings>(ownerId, '/credential', { method: 'PUT', body: { apiKey }, signal });
  },
  removeCredential(ownerId: string, signal?: AbortSignal) {
    return request<RemoteAISettings & { removed: true }>(ownerId, '/credential', { method: 'DELETE', signal });
  },
};

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { decryptAICredential, encryptAICredential } from './aiCredentialVault.js';

export const OPENAI_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'] as const;
export type OpenAIModelId = (typeof OPENAI_MODELS)[number];
export const AI_MONTHLY_REQUEST_LIMITS = [30, 60, 120] as const;
export type AIMonthlyRequestLimit = (typeof AI_MONTHLY_REQUEST_LIMITS)[number];
export const AI_MAX_OUTPUT_TOKENS = 600;
export const AI_MAX_REQUEST_BYTES = 16 * 1024;
export const AI_CONNECTION_TEST_OUTPUT_TOKENS = 8;
export const AI_CONNECTION_TEST_TIMEOUT_MS = 12_000;
export const AI_MAX_REQUESTS_PER_MONTH = 120;

export interface AISettings {
  model: OpenAIModelId;
  enabled: boolean;
  permissions: { aggregatedFinancialInsights: boolean; detailedFinancialRecords: boolean; projectsIntelligence: boolean };
  consentAcceptedAt: string | null;
  credentialForwardingConsentAcceptedAt: string | null;
  connectionStatus: 'not_configured' | 'connected' | 'invalid_credentials' | 'model_access_problem' | 'rate_limited' | 'quota_exhausted' | 'temporarily_unavailable' | 'reconfiguration_required';
  lastValidatedAt: string | null;
  monthlyRequestLimit: AIMonthlyRequestLimit;
}

export interface AISettingsStore {
  getSettings(userId: string): Promise<AISettings | null>;
  saveSettings(userId: string, settings: AISettings): Promise<void>;
  hasCredential(userId: string): Promise<boolean>;
  saveCredential(userId: string, ciphertext: string): Promise<void>;
  getCredential(userId: string): Promise<string | null>;
  deleteCredential(userId: string): Promise<void>;
  consumeMonthlyRequest(userId: string, month: string, limit: number): Promise<boolean>;
  getMonthlyRequestCount(userId: string, month: string): Promise<number>;
  tryAcquireConnectionTest(userId: string): Promise<string | null>;
  releaseConnectionTest(userId: string, leaseId: string): Promise<void>;
}

export interface NeonJwtVerificationOptions {
  jwksUrl: string;
  issuer: string;
  audience?: string;
  allowInsecureHttp?: boolean;
  /** Injected only in tests; production wiring always uses the configured remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

export function createNeonJwtVerifier(options: NeonJwtVerificationOptions): (token: string) => Promise<string> {
  const jwksUrl = new URL(options.jwksUrl);
  const issuerUrl = new URL(options.issuer);
  if (issuerUrl.protocol !== 'https:' && !options.allowInsecureHttp) throw new Error('Neon Auth issuer must use HTTPS.');
  if (jwksUrl.protocol !== 'https:' && !(options.allowInsecureHttp && ['localhost', '127.0.0.1'].includes(jwksUrl.hostname))) {
    throw new Error('Neon Auth JWKS must use HTTPS.');
  }
  const remoteKeys = options.getKey ?? createRemoteJWKSet(jwksUrl, { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  return async (token: string): Promise<string> => {
    const verifyOptions = options.audience ? { issuer: issuerUrl.origin, audience: options.audience } : { issuer: issuerUrl.origin };
    const { payload } = await jwtVerify(token, remoteKeys, verifyOptions);
    return requireAuthenticatedNeonSubject(payload);
  };
}

export function requireAuthenticatedNeonSubject(payload: JWTPayload): string {
  if (typeof payload.sub !== 'string' || payload.sub.trim().length < 1 || payload.sub.length > 255 || payload.role !== 'authenticated') {
    throw new Error('Neon Auth identity is invalid.');
  }
  return payload.sub;
}

const modelSchema = z.enum(OPENAI_MODELS);
const limitSchema = z.union([z.literal(30), z.literal(60), z.literal(120)]);
const permissionSchema = z.object({
  aggregatedFinancialInsights: z.boolean(),
  detailedFinancialRecords: z.boolean(),
  projectsIntelligence: z.boolean(),
}).strict();
const settingsSchema = z.object({
  model: modelSchema,
  enabled: z.boolean(),
  permissions: permissionSchema,
  dataConsentAccepted: z.boolean(),
  credentialForwardingConsentAccepted: z.boolean(),
  monthlyRequestLimit: limitSchema,
}).strict();
const testSchema = z.object({ model: modelSchema }).strict();
const credentialSchema = z.object({ apiKey: z.string().min(20).max(4096).regex(/^sk-[A-Za-z0-9_-]+$/) }).strict();

const defaultSettings = (): AISettings => ({
  model: 'gpt-6-luna', enabled: false,
  permissions: { aggregatedFinancialInsights: false, detailedFinancialRecords: false, projectsIntelligence: false },
  consentAcceptedAt: null, credentialForwardingConsentAcceptedAt: null,
  connectionStatus: 'not_configured', lastValidatedAt: null, monthlyRequestLimit: 30,
});

function monthKey(now: Date): string { return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`; }
function isFresh(date: string | null, now: Date): boolean {
  if (!date) return false;
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() && now.getTime() - timestamp <= 30 * 86_400_000;
}

async function readJsonLimited(response: Response, maximumBytes = 64 * 1024): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) { await reader.cancel(); throw new Error('Provider response exceeded its size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return null; }
}

function providerFailureStatus(status: number, body: unknown): AISettings['connectionStatus'] {
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : {};
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  if (status === 401) return 'invalid_credentials';
  if (status === 403 || status === 404 || code.includes('model')) return 'model_access_problem';
  if (status === 429 && (code.includes('quota') || code.includes('billing'))) return 'quota_exhausted';
  if (status === 429) return 'rate_limited';
  return 'temporarily_unavailable';
}

function providerErrorCode(status: number, body: unknown): string {
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : {};
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  if (status === 403 && code.includes('permission')) return 'OPENAI_INSUFFICIENT_PERMISSION';
  switch (providerFailureStatus(status, body)) {
    case 'invalid_credentials': return 'INVALID_OPENAI_CREDENTIAL';
    case 'model_access_problem': return 'OPENAI_MODEL_ACCESS';
    case 'rate_limited': return 'OPENAI_RATE_LIMITED';
    case 'quota_exhausted': return 'OPENAI_QUOTA_EXHAUSTED';
    default: return 'OPENAI_TEMPORARILY_UNAVAILABLE';
  }
}

function safePublicSettings(settings: AISettings, monthlyRequestCount: number, hasCredential: boolean) {
  return { ...settings, hasCredential, monthlyRequestCount, maximumMonthlyRequests: AI_MAX_REQUESTS_PER_MONTH };
}

export function createAIGateway(options: {
  store: AISettingsStore;
  verifyNeonToken: (token: string) => Promise<string>;
  providerFetch?: typeof fetch;
  credentialEncryptionKey: string;
  now?: () => Date;
}) {
  const app = new Hono<{ Variables: { neonUserId: string } }>();
  app.use('*', bodyLimit({ maxSize: AI_MAX_REQUEST_BYTES }));
  const now = options.now ?? (() => new Date());
  const providerFetch = options.providerFetch ?? fetch;

  const requireNeonIdentity = createMiddleware<{ Variables: { neonUserId: string } }>(async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._~-]{20,8192})$/i.exec(authorization);
    if (!match) return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in to Neon Auth to use AI settings.' } }, 401);
    try {
      const userId = await options.verifyNeonToken(match[1]!);
      if (!userId.trim() || userId.length > 255) throw new Error('invalid subject');
      c.set('neonUserId', userId);
      await next();
    } catch {
      return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Your Neon Auth session is invalid or expired. Sign in again.' } }, 401);
    }
  });
  app.use('*', requireNeonIdentity);

  app.get('/settings', async (c) => {
    const nowValue = now();
    const settings = await options.store.getSettings(c.get('neonUserId')) ?? defaultSettings();
    const hasCredential = await options.store.hasCredential(c.get('neonUserId'));
    if (settings.enabled && (!hasCredential || !isFresh(settings.lastValidatedAt, nowValue) || !settings.consentAcceptedAt || !settings.credentialForwardingConsentAcceptedAt || !settings.permissions.aggregatedFinancialInsights)) {
      settings.enabled = false;
      settings.connectionStatus = 'reconfiguration_required';
      settings.lastValidatedAt = null;
      await options.store.saveSettings(c.get('neonUserId'), settings);
    }
    const monthlyRequestCount = await options.store.getMonthlyRequestCount(c.get('neonUserId'), monthKey(nowValue));
    return c.json({ data: safePublicSettings(settings, monthlyRequestCount, await options.store.hasCredential(c.get('neonUserId'))) });
  });

  app.put('/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'INVALID_AI_SETTINGS', message: 'AI settings are invalid.' } }, 400);
    const userId = c.get('neonUserId');
    const prior = await options.store.getSettings(userId) ?? defaultSettings();
    const modelChanged = parsed.data.model !== prior.model;
    const consentAcceptedAt = parsed.data.dataConsentAccepted ? prior.consentAcceptedAt ?? now().toISOString() : null;
    const credentialForwardingConsentAcceptedAt = parsed.data.credentialForwardingConsentAccepted
      ? prior.credentialForwardingConsentAcceptedAt ?? now().toISOString() : null;
    const settings: AISettings = {
      ...prior,
      model: parsed.data.model,
      enabled: parsed.data.enabled,
      permissions: parsed.data.permissions,
      consentAcceptedAt,
      credentialForwardingConsentAcceptedAt,
      monthlyRequestLimit: parsed.data.monthlyRequestLimit,
      connectionStatus: modelChanged ? 'reconfiguration_required' : prior.connectionStatus,
      lastValidatedAt: modelChanged ? null : prior.lastValidatedAt,
    };
    if (!parsed.data.dataConsentAccepted || !parsed.data.credentialForwardingConsentAccepted) settings.enabled = false;
    if (settings.enabled && (!await options.store.hasCredential(userId) || !isFresh(settings.lastValidatedAt, now()) || settings.connectionStatus !== 'connected' || !settings.consentAcceptedAt || !settings.credentialForwardingConsentAcceptedAt || !settings.permissions.aggregatedFinancialInsights)) {
      return c.json({ error: { code: 'AI_ENABLEMENT_REQUIRES_VALIDATION', message: 'Test the selected model and grant the required permissions before enabling AI.' } }, 409);
    }
    await options.store.saveSettings(userId, settings);
    if (!credentialForwardingConsentAcceptedAt) await options.store.deleteCredential(userId);
    const monthlyRequestCount = await options.store.getMonthlyRequestCount(userId, monthKey(now()));
    return c.json({ data: safePublicSettings(settings, monthlyRequestCount, await options.store.hasCredential(userId)) });
  });

  app.put('/credential', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = credentialSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'INVALID_CREDENTIAL_FORMAT', message: 'The OpenAI credential format is invalid.' } }, 400);
    const userId = c.get('neonUserId');
    const prior = await options.store.getSettings(userId) ?? defaultSettings();
    if (!prior.credentialForwardingConsentAcceptedAt) return c.json({ error: { code: 'CREDENTIAL_FORWARDING_CONSENT_REQUIRED', message: 'Review and accept the credential storage and forwarding disclosure before saving.' } }, 403);
    const invalidated = { ...prior, enabled: false, connectionStatus: 'reconfiguration_required' as const, lastValidatedAt: null };
    await options.store.saveSettings(userId, invalidated);
    await options.store.saveCredential(userId, encryptAICredential(userId, parsed.data.apiKey, options.credentialEncryptionKey));
    return c.json({ data: safePublicSettings(invalidated, await options.store.getMonthlyRequestCount(userId, monthKey(now())), true) });
  });

  app.delete('/credential', async (c) => {
    const userId = c.get('neonUserId');
    await options.store.deleteCredential(userId);
    const prior = await options.store.getSettings(userId) ?? defaultSettings();
    const cleared: AISettings = {
      ...prior, enabled: false, consentAcceptedAt: null, credentialForwardingConsentAcceptedAt: null,
      connectionStatus: 'not_configured', lastValidatedAt: null,
    };
    await options.store.saveSettings(userId, cleared);
    return c.json({ data: { removed: true, ...safePublicSettings(cleared, await options.store.getMonthlyRequestCount(userId, monthKey(now())), false) } });
  });

  app.post('/connection-test', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = testSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'INVALID_AI_TEST', message: 'Choose a supported model to test.' } }, 400);
    const userId = c.get('neonUserId');
    const prior = await options.store.getSettings(userId) ?? defaultSettings();
    if (!prior.credentialForwardingConsentAcceptedAt) return c.json({ error: { code: 'CREDENTIAL_FORWARDING_CONSENT_REQUIRED', message: 'Review and accept the credential privacy disclosure before testing.' } }, 403);
    const encryptedCredential = await options.store.getCredential(userId);
    if (!encryptedCredential) return c.json({ error: { code: 'CREDENTIAL_NOT_CONFIGURED', message: 'Save an API credential before testing the connection.' } }, 409);
    let apiKey: string;
    try { apiKey = decryptAICredential(userId, encryptedCredential, options.credentialEncryptionKey); }
    catch { return c.json({ error: { code: 'CREDENTIAL_RECONFIGURATION_REQUIRED', message: 'The saved credential must be entered again because it cannot be decrypted.' } }, 409); }
    const leaseId = await options.store.tryAcquireConnectionTest(userId);
    if (!leaseId) return c.json({ error: { code: 'AI_CONNECTION_TEST_IN_PROGRESS', message: 'A connection test is already running for this account.' } }, 409);
    try {
      const currentMonth = monthKey(now());
      if (!await options.store.consumeMonthlyRequest(userId, currentMonth, prior.monthlyRequestLimit)) {
        return c.json({ error: { code: 'AI_MONTHLY_LIMIT_REACHED', message: 'The configured monthly AI request limit has been reached.' } }, 429);
      }

    let response: Response;
    let responseBody: unknown;
    try {
      response = await providerFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: parsed.data.model,
          input: 'Reply with exactly the word OK.',
          max_output_tokens: AI_CONNECTION_TEST_OUTPUT_TOKENS,
          store: false,
        }),
        signal: AbortSignal.timeout(AI_CONNECTION_TEST_TIMEOUT_MS),
        redirect: 'error',
      });
      responseBody = await readJsonLimited(response);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      await options.store.saveSettings(userId, { ...prior, model: parsed.data.model, enabled: false, connectionStatus: 'temporarily_unavailable', lastValidatedAt: null });
      return c.json({ error: { code: timedOut ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_UNAVAILABLE', message: timedOut ? 'OpenAI did not respond before the connection test timed out.' : 'OpenAI is temporarily unavailable.' } }, 503);
    }

    if (!response.ok) {
      const status = providerFailureStatus(response.status, responseBody);
      await options.store.saveSettings(userId, { ...prior, model: parsed.data.model, enabled: false, connectionStatus: status, lastValidatedAt: null });
      const code = providerErrorCode(response.status, responseBody);
      const message = code === 'INVALID_OPENAI_CREDENTIAL' ? 'OpenAI rejected this credential.'
        : code === 'OPENAI_INSUFFICIENT_PERMISSION' ? 'This API key lacks permission to create Responses.'
          : code === 'OPENAI_MODEL_ACCESS' ? 'This credential cannot use the selected model.'
            : code === 'OPENAI_QUOTA_EXHAUSTED' ? 'The OpenAI project has no available quota.'
              : code === 'OPENAI_RATE_LIMITED' ? 'OpenAI is rate limiting requests. Try again later.'
                : 'OpenAI is temporarily unavailable.';
      return c.json({ error: { code, message } }, response.status === 429 ? 429 : response.status === 401 ? 401 : 503);
    }

    const result = responseBody && typeof responseBody === 'object' ? responseBody as Record<string, unknown> : {};
    const output = Array.isArray(result.output) ? result.output : [];
    if (typeof result.status !== 'string' || !Array.isArray(result.output)) {
      await options.store.saveSettings(userId, { ...prior, model: parsed.data.model, enabled: false, connectionStatus: 'temporarily_unavailable', lastValidatedAt: null });
      return c.json({ error: { code: 'OPENAI_INVALID_RESPONSE', message: 'OpenAI returned an invalid connection-test response.' } }, 502);
    }
    const outputText = output.flatMap((item) => item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [])
      .filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'output_text')
      .map((item) => String((item as Record<string, unknown>).text ?? '')).join('').trim();
    if (result.status !== 'completed' || outputText !== 'OK') {
      const failed: AISettings = { ...prior, model: parsed.data.model, enabled: false, connectionStatus: 'model_access_problem', lastValidatedAt: null };
      await options.store.saveSettings(userId, failed);
      return c.json({ error: { code: 'OPENAI_MODEL_TEST_FAILED', message: 'The selected model did not complete the expected test response.' } }, 502);
    }
      const validatedAt = now().toISOString();
      const connected: AISettings = { ...prior, model: parsed.data.model, enabled: false, connectionStatus: 'connected', lastValidatedAt: validatedAt };
      await options.store.saveSettings(userId, connected);
      const monthlyRequestCount = await options.store.getMonthlyRequestCount(userId, currentMonth);
      return c.json({ data: { ...safePublicSettings(connected, monthlyRequestCount, true), validatedAt } });
    } finally {
      await options.store.releaseConnectionTest(userId, leaseId);
    }
  });

  return app;
}

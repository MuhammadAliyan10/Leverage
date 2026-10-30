import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { test } from 'node:test';
import { createAIGateway, createNeonJwtVerifier, requireAuthenticatedNeonSubject } from '../src/aiGateway.ts';
import { decryptAICredential } from '../src/aiCredentialVault.ts';

const defaultSettings = () => ({
  model: 'gpt-6-luna', enabled: false,
  permissions: { aggregatedFinancialInsights: false, detailedFinancialRecords: false, projectsIntelligence: false },
  consentAcceptedAt: null, credentialForwardingConsentAcceptedAt: null,
  connectionStatus: 'not_configured', lastValidatedAt: null, monthlyRequestLimit: 30,
});

function memoryStore() {
  const settings = new Map();
  const counts = new Map();
  const leases = new Map();
  const credentials = new Map();
  return {
    settings, counts, credentials,
    async getSettings(id) { return settings.get(id) ?? null; },
    async saveSettings(id, value) { settings.set(id, structuredClone(value)); },
    async hasCredential(id) { return credentials.has(id); },
    async saveCredential(id, value) { credentials.set(id, value); },
    async getCredential(id) { return credentials.get(id) ?? null; },
    async deleteCredential(id) { credentials.delete(id); },
    async consumeMonthlyRequest(id, month, limit) {
      const key = `${id}:${month}`; const count = counts.get(key) ?? 0;
      if (count >= limit) return false;
      counts.set(key, count + 1); return true;
    },
    async getMonthlyRequestCount(id, month) { return counts.get(`${id}:${month}`) ?? 0; },
    async tryAcquireConnectionTest(id) { if (leases.has(id)) return null; const lease = `lease-${id}`; leases.set(id, lease); return lease; },
    async releaseConnectionTest(id, lease) { if (leases.get(id) === lease) leases.delete(id); },
  };
}

const bearer = (name = 'alice') => `Bearer test-neon-token-for-${name}-1234567890`;
const verify = async (token) => {
  const match = /^test-neon-token-for-(alice|bob)-1234567890$/.exec(token);
  if (!match) throw new Error('bad test token');
  return match[1];
};
const encryptionKey = 'ab'.repeat(32);
const makeApp = (store, providerFetch = async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }, { status: 200 }), now = () => new Date('2026-10-30T12:00:00.000Z')) => createAIGateway({ store, verifyNeonToken: verify, providerFetch, credentialEncryptionKey: encryptionKey, now });
const authorized = (name = 'alice', additional = {}) => ({ Authorization: bearer(name), ...additional });
const validKey = `sk-proj-${'a'.repeat(40)}`;
const consent = async (app, name = 'alice', extra = {}) => app.request('/settings', {
  method: 'PUT', headers: authorized(name, { 'Content-Type': 'application/json' }),
  body: JSON.stringify({ model: extra.model ?? 'gpt-6-luna', enabled: extra.enabled ?? false,
    permissions: extra.permissions ?? { aggregatedFinancialInsights: true, detailedFinancialRecords: false, projectsIntelligence: false },
    dataConsentAccepted: extra.dataConsentAccepted ?? true, credentialForwardingConsentAccepted: extra.credentialForwardingConsentAccepted ?? true, monthlyRequestLimit: extra.monthlyRequestLimit ?? 30 }),
});
const saveCredential = (app, name = 'alice', key = validKey) => app.request('/credential', {
  method: 'PUT', headers: authorized(name, { 'Content-Type': 'application/json' }), body: JSON.stringify({ apiKey: key }),
});
const testRequest = (app, name = 'alice', model = 'gpt-6-luna') => app.request('/connection-test', {
  method: 'POST', headers: authorized(name, { 'Content-Type': 'application/json' }), body: JSON.stringify({ model }),
});

test('Neon JWT verifier validates signature, issuer, expiry and authenticated role', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256';
  const issuer = 'https://auth.example.invalid';
  const verifier = createNeonJwtVerifier({ jwksUrl: `${issuer}/jwks`, issuer, getKey: createLocalJWKSet({ keys: [jwk] }) });
  const audienceVerifier = createNeonJwtVerifier({ jwksUrl: `${issuer}/jwks`, issuer, audience: 'leverage-ai', getKey: createLocalJWKSet({ keys: [jwk] }) });
  const token = (claims, exp = Math.floor(Date.now() / 1000) + 60) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setSubject('user-1').setIssuedAt().setExpirationTime(exp).sign(privateKey);
  assert.equal(await verifier(await token({ role: 'authenticated' })), 'user-1');
  await assert.rejects(audienceVerifier(await token({ role: 'authenticated' })));
  assert.equal(await audienceVerifier(await token({ role: 'authenticated', aud: 'leverage-ai' })), 'user-1');
  await assert.rejects(verifier(await token({ role: 'authenticated' }, Math.floor(Date.now() / 1000) - 1)));
  await assert.rejects(verifier(await token({ role: 'anonymous' })));
  assert.throws(() => requireAuthenticatedNeonSubject({ sub: 'user-1', role: 'anonymous' }), /identity is invalid/);
});

test('gateway requires Neon identity and isolates settings by verified subject', async () => {
  const store = memoryStore(); const app = makeApp(store);
  assert.equal((await app.request('/settings')).status, 401);
  assert.equal((await app.request('/settings', { headers: authorized('unknown') })).status, 401);
  await consent(app, 'alice');
  const alice = await (await app.request('/settings', { headers: authorized('alice') })).json();
  const bob = await (await app.request('/settings', { headers: authorized('bob') })).json();
  assert.equal(alice.data.permissions.aggregatedFinancialInsights, true);
  assert.equal(alice.data.hasCredential, false);
  assert.equal(bob.data.permissions.aggregatedFinancialInsights, false);
  const bodyWithSpoofedOwner = await app.request('/settings', { method: 'PUT', headers: authorized('alice', { 'Content-Type': 'application/json' }), body: JSON.stringify({ ownerId: 'bob' }) });
  assert.equal(bodyWithSpoofedOwner.status, 400);
});

test('credential is encrypted per user, never returned, and the gateway alone forwards it to OpenAI', async () => {
  const store = memoryStore(); let received;
  const provider = async (url, init) => { received = { url, init, body: JSON.parse(init.body) }; return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }, { status: 200 }); };
  const app = makeApp(store, provider); await consent(app);
  const key = validKey;
  await saveCredential(app, 'alice', key);
  const encrypted = store.credentials.get('alice');
  assert.notEqual(encrypted, key);
  assert.equal(decryptAICredential('alice', encrypted, encryptionKey), key);
  const response = await testRequest(app);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(received.url, 'https://api.openai.com/v1/responses');
  assert.equal(received.init.headers.Authorization, `Bearer ${key}`);
  assert.equal(received.body.model, 'gpt-6-luna');
  assert.equal(received.body.input, 'Reply with exactly the word OK.');
  assert.equal(received.body.max_output_tokens, 8);
  assert.equal(received.body.store, false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(Object.hasOwn(received.init.headers, 'X-OpenAI-Api-Key'), false);
  assert.equal(JSON.stringify([...store.settings.values()]).includes(key), false);
  assert.equal(JSON.stringify([...store.credentials.values()]).includes(key), false);
  assert.equal(result.data.connectionStatus, 'connected');
  assert.equal(result.data.hasCredential, true);
  const bobSettings = await (await app.request('/settings', { headers: authorized('bob') })).json();
  assert.equal(bobSettings.data.hasCredential, false);
});

test('connection tests require forwarding consent and a supported model', async () => {
  const app = makeApp(memoryStore());
  assert.equal((await testRequest(app)).status, 403);
  await consent(app);
  assert.equal((await testRequest(app, 'alice', 'unsupported-model')).status, 400);
  assert.equal((await testRequest(app)).status, 409);
  assert.equal((await saveCredential(app, 'alice', 'not-a-valid-key')).status, 400);
});

test('encrypted credentials are consent-gated, user-scoped, and deleted when forwarding consent is revoked', async () => {
  const store = memoryStore(); const app = makeApp(store);
  assert.equal((await saveCredential(app)).status, 403);
  await consent(app);
  const saved = await saveCredential(app);
  const savedResult = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(savedResult.data.hasCredential, true);
  assert.equal(JSON.stringify(savedResult).includes(validKey), false);
  assert.equal(await store.hasCredential('bob'), false);
  await consent(app, 'alice', { credentialForwardingConsentAccepted: false });
  assert.equal(await store.hasCredential('alice'), false);
  const settings = await (await app.request('/settings', { headers: authorized('alice') })).json();
  assert.equal(settings.data.hasCredential, false);
});

test('credential removal resets server validation and both consent records', async () => {
  const store = memoryStore(); const app = makeApp(store); await consent(app); await saveCredential(app);
  assert.equal((await testRequest(app)).status, 200);
  const response = await app.request('/credential', { method: 'DELETE', headers: authorized() });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.data.removed, true);
  assert.equal(result.data.enabled, false); assert.equal(result.data.connectionStatus, 'not_configured');
  assert.equal(result.data.consentAcceptedAt, null); assert.equal(result.data.credentialForwardingConsentAcceptedAt, null);
  assert.equal(store.credentials.has('alice'), false);
});

test('provider credential, model, quota, rate and downtime failures are classified safely', async (t) => {
  const cases = [
    [401, { error: { code: 'invalid_api_key' } }, 401, 'INVALID_OPENAI_CREDENTIAL', 'invalid_credentials'],
    [403, { error: { code: 'model_not_found' } }, 503, 'OPENAI_MODEL_ACCESS', 'model_access_problem'],
    [403, { error: { code: 'insufficient_permissions' } }, 503, 'OPENAI_INSUFFICIENT_PERMISSION', 'model_access_problem'],
    [429, { error: { code: 'insufficient_quota' } }, 429, 'OPENAI_QUOTA_EXHAUSTED', 'quota_exhausted'],
    [429, { error: { code: 'rate_limit_exceeded' } }, 429, 'OPENAI_RATE_LIMITED', 'rate_limited'],
    [503, { error: { code: 'service_unavailable' } }, 503, 'OPENAI_TEMPORARILY_UNAVAILABLE', 'temporarily_unavailable'],
  ];
  for (const [providerStatus, body, expectedStatus, code, connectionStatus] of cases) {
    await t.test(code, async () => {
      const store = memoryStore(); const app = makeApp(store, async () => Response.json(body, { status: providerStatus }));
      await consent(app); await saveCredential(app); const response = await testRequest(app); const result = await response.json();
      assert.equal(response.status, expectedStatus); assert.equal(result.error.code, code);
      assert.equal((await store.getSettings('alice')).connectionStatus, connectionStatus);
    });
  }
  const timedStore = memoryStore(); const timedApp = makeApp(timedStore, async () => { throw new DOMException('timeout', 'TimeoutError'); });
  await consent(timedApp); await saveCredential(timedApp); const timeout = await testRequest(timedApp);
  assert.equal(timeout.status, 503); assert.equal((await timeout.json()).error.code, 'AI_PROVIDER_TIMEOUT');
  const invalidApp = makeApp(memoryStore(), async () => new Response('{not json', { status: 200 })); await consent(invalidApp); await saveCredential(invalidApp);
  const invalid = await testRequest(invalidApp); assert.equal(invalid.status, 502); assert.equal((await invalid.json()).error.code, 'OPENAI_INVALID_RESPONSE');
});

test('monthly request limit is enforced atomically before provider call; enabling requires validation and consent', async () => {
  const store = memoryStore(); let providerCalls = 0;
  const app = makeApp(store, async () => { providerCalls++; return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }); });
  await consent(app, 'alice', { monthlyRequestLimit: 30 });
  await saveCredential(app);
  const withoutValidation = await app.request('/settings', { method: 'PUT', headers: authorized('alice', { 'Content-Type': 'application/json' }), body: JSON.stringify({ model: 'gpt-6-luna', enabled: true, permissions: { aggregatedFinancialInsights: true, detailedFinancialRecords: false, projectsIntelligence: false }, dataConsentAccepted: true, credentialForwardingConsentAccepted: true, monthlyRequestLimit: 30 }) });
  assert.equal(withoutValidation.status, 409);
  for (let index = 0; index < 30; index++) assert.equal((await testRequest(app)).status, 200);
  const limited = await testRequest(app); assert.equal(limited.status, 429); assert.equal((await limited.json()).error.code, 'AI_MONTHLY_LIMIT_REACHED');
  assert.equal(providerCalls, 30);
  const enabled = await app.request('/settings', { method: 'PUT', headers: authorized('alice', { 'Content-Type': 'application/json' }), body: JSON.stringify({ model: 'gpt-6-luna', enabled: true, permissions: { aggregatedFinancialInsights: true, detailedFinancialRecords: false, projectsIntelligence: false }, dataConsentAccepted: true, credentialForwardingConsentAccepted: true, monthlyRequestLimit: 30 }) });
  assert.equal(enabled.status, 200);
  const disabled = await app.request('/settings', { method: 'PUT', headers: authorized('alice', { 'Content-Type': 'application/json' }), body: JSON.stringify({ model: 'gpt-6-luna', enabled: false, permissions: { aggregatedFinancialInsights: true, detailedFinancialRecords: false, projectsIntelligence: false }, dataConsentAccepted: true, credentialForwardingConsentAccepted: true, monthlyRequestLimit: 30 }) });
  assert.equal(disabled.status, 200); assert.equal((await disabled.json()).data.enabled, false);
});

test('connection tests are single-flight per authenticated user and release the lease', async () => {
  const store = memoryStore(); let providerCalls = 0; let entered; let finish;
  const providerEntered = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const app = makeApp(store, async () => { providerCalls++; entered(); await waiting; return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }); });
  await consent(app); await saveCredential(app);
  const firstRequest = testRequest(app);
  await providerEntered;
  const second = await testRequest(app);
  assert.equal(second.status, 409); assert.equal((await second.json()).error.code, 'AI_CONNECTION_TEST_IN_PROGRESS');
  finish();
  assert.equal((await firstRequest).status, 200);
  assert.equal(providerCalls, 1);
  assert.equal((await testRequest(app)).status, 200);
});

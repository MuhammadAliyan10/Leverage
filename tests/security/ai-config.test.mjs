import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AI_PROFILE_CONFIG,
  assertAIReadAllowed,
  parseAIProfileConfig,
} from '../../src/ai/config.ts';
import { cancelAIProfileWork, runBoundedAIWork } from '../../src/ai/runtime.ts';

function enabledConfig(overrides = {}) {
  return {
    ...DEFAULT_AI_PROFILE_CONFIG,
    provider: 'openai',
    enabled: true,
    connectionStatus: 'connected',
    consentAcceptedAt: new Date().toISOString(),
    credentialForwardingAcceptedAt: new Date().toISOString(),
    lastValidatedAt: new Date().toISOString(),
    permissions: { ...DEFAULT_AI_PROFILE_CONFIG.permissions, aggregatedFinancialInsights: true },
    ...overrides,
  };
}

const context = (config, scope = 'aggregatedFinancialInsights') => ({
  activeProfileId: 'profile-a',
  requestedProfileId: 'profile-a',
  config,
  scope,
});

test('AI settings default to off with no granted data scopes', () => {
  assert.equal(DEFAULT_AI_PROFILE_CONFIG.enabled, false);
  assert.deepEqual(Object.values(DEFAULT_AI_PROFILE_CONFIG.permissions), [false, false, false]);
});

test('configuration parser rejects invalid or unsupported settings', () => {
  assert.throws(() => parseAIProfileConfig('{broken'), /invalid/i);
  assert.throws(() => parseAIProfileConfig(JSON.stringify({ ...DEFAULT_AI_PROFILE_CONFIG, model: 'unknown-model' })), /unsupported/i);
});

test('older version-one settings load with forwarding consent revoked by default', () => {
  const older = { ...DEFAULT_AI_PROFILE_CONFIG };
  delete older.credentialForwardingAcceptedAt;
  const parsed = parseAIProfileConfig(JSON.stringify(older));
  assert.equal(parsed.credentialForwardingAcceptedAt, null);
  assert.equal(parsed.enabled, false);
});

test('analytics access requires the active profile, current consent, enablement and requested scope', () => {
  assert.doesNotThrow(() => assertAIReadAllowed(context(enabledConfig())));
  assert.throws(() => assertAIReadAllowed({ ...context(enabledConfig()), requestedProfileId: 'profile-b' }), /active local profile/i);
  assert.throws(() => assertAIReadAllowed(context({ ...enabledConfig(), enabled: false })), /disabled/i);
  assert.throws(() => assertAIReadAllowed(context({ ...enabledConfig(), consentAcceptedAt: null })), /permission/i);
  assert.throws(() => assertAIReadAllowed(context(enabledConfig(), 'detailedFinancialRecords')), /permission/i);
});

test('project and detailed records require their own explicit scopes', () => {
  assert.throws(() => assertAIReadAllowed(context(enabledConfig(), 'projectsIntelligence')), /permission/i);
  assert.throws(() => assertAIReadAllowed(context(enabledConfig(), 'detailedFinancialRecords')), /permission/i);
  const config = enabledConfig({ permissions: { aggregatedFinancialInsights: true, detailedFinancialRecords: true, projectsIntelligence: true } });
  assert.doesNotThrow(() => assertAIReadAllowed(context(config, 'projectsIntelligence')));
  assert.doesNotThrow(() => assertAIReadAllowed(context(config, 'detailedFinancialRecords')));
});

test('stale and future provider validation timestamps fail closed', () => {
  assert.throws(() => assertAIReadAllowed(context(enabledConfig({ lastValidatedAt: new Date(Date.now() - 31 * 86400000).toISOString() }))), /disabled|revalidation/i);
  assert.throws(() => assertAIReadAllowed(context(enabledConfig({ lastValidatedAt: new Date(Date.now() + 60000).toISOString() }))), /disabled|revalidation/i);
});

test('AI work is single-flight per profile and cancellation releases the slot', async () => {
  let finishWork;
  const pending = runBoundedAIWork('profile-work', () => new Promise((resolve) => { finishWork = resolve; }));
  assert.equal(typeof finishWork, 'function');
  await assert.rejects(runBoundedAIWork('profile-work', async () => 'duplicate'), /already running/i);
  cancelAIProfileWork('profile-work');
  await assert.rejects(pending, /cancelled/i);
  assert.equal(await runBoundedAIWork('profile-work', async () => 'available'), 'available');
});

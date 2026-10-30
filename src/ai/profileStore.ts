import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { DEFAULT_AI_PROFILE_CONFIG, parseAIProfileConfig, type AIProfileConfig } from './config';
import { aiGatewayClient } from './gatewayClient';

const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const configKey = (profileId: string) => `leverage_ai_config_v1_${profileId}`;
// Remove credentials saved by earlier builds that kept BYOK secrets on-device.
const credentialKey = (profileId: string) => `leverage_ai_openai_key_v1_${profileId}`;
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function requireNativeProfile(profileId: string): void {
  if (Platform.OS === 'web') throw new Error('AI credential storage is unavailable in the browser. No browser storage fallback is used.');
  if (!PROFILE_ID_PATTERN.test(profileId)) throw new Error('A valid active local profile is required for AI settings.');
}

function hasFreshValidation(config: AIProfileConfig): boolean {
  const validatedAt = config.lastValidatedAt ? Date.parse(config.lastValidatedAt) : Number.NaN;
  return Number.isFinite(validatedAt) && validatedAt <= Date.now() && Date.now() - validatedAt <= 30 * 24 * 60 * 60 * 1000;
}

async function requireSecureStore(): Promise<void> {
  if (!(await SecureStore.isAvailableAsync())) throw new Error('Secure credential storage is unavailable on this device. AI remains disabled.');
}

export const aiProfileStore = {
  async load(profileId: string): Promise<AIProfileConfig> {
    requireNativeProfile(profileId);
    await requireSecureStore();
    const serialized = await SecureStore.getItemAsync(configKey(profileId), secureOptions);
    await SecureStore.deleteItemAsync(credentialKey(profileId), secureOptions);
    const config = parseAIProfileConfig(serialized);
    if (config.enabled && !aiGatewayClient.configured) {
      return { ...config, enabled: false, connectionStatus: 'reconfiguration_required', revision: config.revision + 1 };
    }
    if (config.enabled && (!config.provider || config.connectionStatus !== 'connected' || !hasFreshValidation(config) || !config.consentAcceptedAt)) {
      return { ...config, enabled: false, connectionStatus: 'reconfiguration_required', revision: config.revision + 1 };
    }
    return config;
  },

  async save(profileId: string, config: AIProfileConfig): Promise<void> {
    requireNativeProfile(profileId);
    await requireSecureStore();
    if (config.enabled && (!aiGatewayClient.configured || !config.provider || config.connectionStatus !== 'connected' || !hasFreshValidation(config) || !config.consentAcceptedAt || !config.credentialForwardingAcceptedAt || !config.permissions.aggregatedFinancialInsights)) {
      throw new Error('AI can only be enabled after a successful provider test, explicit data and credential-forwarding consent, and aggregated-insights permission.');
    }
    await SecureStore.setItemAsync(configKey(profileId), JSON.stringify(config), secureOptions);
  },

  async clearConfiguration(profileId: string): Promise<void> {
    requireNativeProfile(profileId);
    await requireSecureStore();
    await SecureStore.deleteItemAsync(configKey(profileId), secureOptions);
  },

  async clear(profileId: string): Promise<void> {
    requireNativeProfile(profileId);
    await requireSecureStore();
    await Promise.all([
      SecureStore.deleteItemAsync(credentialKey(profileId), secureOptions),
      SecureStore.deleteItemAsync(configKey(profileId), secureOptions),
    ]);
  },

  createDefault(): AIProfileConfig {
    return { ...DEFAULT_AI_PROFILE_CONFIG, permissions: { ...DEFAULT_AI_PROFILE_CONFIG.permissions } };
  },
};

export const AI_PROVIDERS = ['openai'] as const;
export type AIProviderId = (typeof AI_PROVIDERS)[number];

/** Models verified in OpenAI's current Responses API model catalog. */
export const OPENAI_MODELS = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna · most cost-efficient' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra · balanced' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol · advanced' },
] as const;
export type OpenAIModelId = (typeof OPENAI_MODELS)[number]['id'];

export const AI_SCOPES = [
  'aggregatedFinancialInsights',
  'detailedFinancialRecords',
  'projectsIntelligence',
] as const;
export type AIReadScope = (typeof AI_SCOPES)[number];

export type AIConnectionStatus =
  | 'disabled'
  | 'not_configured'
  | 'validating'
  | 'connected'
  | 'invalid_credentials'
  | 'model_access_problem'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'temporarily_unavailable'
  | 'reconfiguration_required';

export interface AIProfileConfig {
  version: 1;
  enabled: boolean;
  provider: AIProviderId | null;
  model: OpenAIModelId;
  permissions: Record<AIReadScope, boolean>;
  consentAcceptedAt: string | null;
  credentialForwardingAcceptedAt: string | null;
  connectionStatus: AIConnectionStatus;
  lastValidatedAt: string | null;
  maxMonthlyRequests: 30 | 60 | 120;
  revision: number;
}

export const DEFAULT_AI_PROFILE_CONFIG: AIProfileConfig = {
  version: 1,
  enabled: false,
  provider: null,
  model: 'gpt-6-luna',
  permissions: {
    aggregatedFinancialInsights: false,
    detailedFinancialRecords: false,
    projectsIntelligence: false,
  },
  consentAcceptedAt: null,
  credentialForwardingAcceptedAt: null,
  connectionStatus: 'not_configured',
  lastValidatedAt: null,
  maxMonthlyRequests: 30,
  revision: 0,
};

const CONNECTION_STATUSES: readonly AIConnectionStatus[] = [
  'disabled', 'not_configured', 'validating', 'connected', 'invalid_credentials',
  'model_access_problem', 'rate_limited', 'quota_exhausted', 'temporarily_unavailable',
  'reconfiguration_required',
];

export function parseAIProfileConfig(serialized: string | null): AIProfileConfig {
  if (serialized === null) return { ...DEFAULT_AI_PROFILE_CONFIG, permissions: { ...DEFAULT_AI_PROFILE_CONFIG.permissions } };
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new Error('Saved AI settings are invalid.'); }
  if (!value || typeof value !== 'object') throw new Error('Saved AI settings are invalid.');
  const source = value as Partial<AIProfileConfig>;
  const permissions = source.permissions;
  const validDate = (date: unknown) => date === null || (typeof date === 'string' && Number.isFinite(Date.parse(date)));
  if (source.version !== 1 || typeof source.enabled !== 'boolean'
    || (source.provider !== null && source.provider !== 'openai')
    || !OPENAI_MODELS.some((model) => model.id === source.model)
    || !permissions || typeof permissions.aggregatedFinancialInsights !== 'boolean'
    || typeof permissions.detailedFinancialRecords !== 'boolean' || typeof permissions.projectsIntelligence !== 'boolean'
    || !validDate(source.consentAcceptedAt) || (source.credentialForwardingAcceptedAt !== undefined && !validDate(source.credentialForwardingAcceptedAt))
    || !CONNECTION_STATUSES.includes(source.connectionStatus as AIConnectionStatus)
    || !validDate(source.lastValidatedAt) || (source.maxMonthlyRequests !== undefined && ![30, 60, 120].includes(source.maxMonthlyRequests as number))
    || !Number.isSafeInteger(source.revision) || (source.revision ?? -1) < 0) {
    throw new Error('Saved AI settings are incomplete or unsupported. AI remains disabled until they are corrected.');
  }
  return {
    version: 1,
    enabled: source.enabled,
    provider: source.provider ?? null,
    model: source.model as OpenAIModelId,
    permissions: { ...permissions },
    consentAcceptedAt: source.consentAcceptedAt ?? null,
    credentialForwardingAcceptedAt: source.credentialForwardingAcceptedAt ?? null,
    connectionStatus: source.connectionStatus as AIConnectionStatus,
    lastValidatedAt: source.lastValidatedAt ?? null,
    maxMonthlyRequests: source.maxMonthlyRequests as AIProfileConfig['maxMonthlyRequests'] ?? 30,
    revision: source.revision!,
  };
}

export function assertAIReadAllowed(input: {
  activeProfileId: string | null;
  requestedProfileId: string;
  config: AIProfileConfig;
  scope: AIReadScope;
}): void {
  if (!input.activeProfileId || input.activeProfileId !== input.requestedProfileId) {
    throw new Error('AI access is limited to the active local profile.');
  }
  const lastValidatedAt = input.config.lastValidatedAt ? Date.parse(input.config.lastValidatedAt) : Number.NaN;
  const validationIsFresh = Number.isFinite(lastValidatedAt)
    && lastValidatedAt <= Date.now()
    && Date.now() - lastValidatedAt <= 30 * 24 * 60 * 60 * 1000;
  if (!input.config.enabled || input.config.provider !== 'openai' || input.config.connectionStatus !== 'connected' || !validationIsFresh) {
    throw new Error('AI Intelligence is disabled or its provider connection needs revalidation.');
  }
  if (!input.config.consentAcceptedAt || !input.config.credentialForwardingAcceptedAt || !input.config.permissions[input.scope]) {
    throw new Error('This AI data permission has not been granted.');
  }
}

export function invalidateAIConnection(config: AIProfileConfig, status: AIConnectionStatus): AIProfileConfig {
  return {
    ...config,
    enabled: false,
    connectionStatus: status,
    lastValidatedAt: status === 'connected' ? config.lastValidatedAt : null,
    revision: config.revision + 1,
  };
}

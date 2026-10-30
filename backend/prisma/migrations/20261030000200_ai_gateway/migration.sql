CREATE TABLE "AiUserSetting" (
  "userId" TEXT NOT NULL,
  "model" TEXT NOT NULL DEFAULT 'gpt-6-luna',
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "permissions" JSONB NOT NULL DEFAULT '{"aggregatedFinancialInsights":false,"detailedFinancialRecords":false,"projectsIntelligence":false}'::jsonb,
  "consentAcceptedAt" TIMESTAMPTZ,
  "credentialForwardingConsentAcceptedAt" TIMESTAMPTZ,
  "connectionStatus" TEXT NOT NULL DEFAULT 'not_configured',
  "lastValidatedAt" TIMESTAMPTZ,
  "monthlyRequestLimit" INTEGER NOT NULL DEFAULT 30,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUserSetting_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "AiUserSetting_model_check" CHECK ("model" IN ('gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol')),
  CONSTRAINT "AiUserSetting_monthly_limit_check" CHECK ("monthlyRequestLimit" IN (30, 60, 120)),
  CONSTRAINT "AiUserSetting_connection_status_check" CHECK ("connectionStatus" IN ('not_configured', 'connected', 'invalid_credentials', 'model_access_problem', 'rate_limited', 'quota_exhausted', 'temporarily_unavailable', 'reconfiguration_required'))
);

CREATE TABLE "AiRequestUsage" (
  "userId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiRequestUsage_pkey" PRIMARY KEY ("userId", "month"),
  CONSTRAINT "AiRequestUsage_count_check" CHECK ("requestCount" >= 0),
  CONSTRAINT "AiRequestUsage_month_check" CHECK ("month" ~ '^\d{4}-\d{2}$')
);

-- One short-lived connection-test lease per authenticated identity. Expiry
-- recovers safely if an API instance exits before its `finally` cleanup.
CREATE TABLE "AiRequestLease" (
  "userId" TEXT PRIMARY KEY,
  "leaseId" UUID NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL
);

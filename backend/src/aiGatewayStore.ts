import { Prisma, type PrismaClient } from './generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import type { AISettings, AISettingsStore } from './aiGateway.js';

function permissionsFromJson(value: unknown): AISettings['permissions'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { aggregatedFinancialInsights: false, detailedFinancialRecords: false, projectsIntelligence: false };
  }
  const source = value as Record<string, unknown>;
  return {
    aggregatedFinancialInsights: source.aggregatedFinancialInsights === true,
    detailedFinancialRecords: source.detailedFinancialRecords === true,
    projectsIntelligence: source.projectsIntelligence === true,
  };
}

export function createPrismaAISettingsStore(prisma: PrismaClient): AISettingsStore {
  return {
    async getSettings(userId) {
      const row = await prisma.aiUserSetting.findUnique({ where: { userId }, select: {
        model: true, enabled: true, permissions: true, consentAcceptedAt: true,
        credentialForwardingConsentAcceptedAt: true, connectionStatus: true,
        lastValidatedAt: true, monthlyRequestLimit: true,
      } });
      if (!row) return null;
      const validModel = row.model === 'gpt-6-luna' || row.model === 'gpt-6.1-terra' || row.model === 'gpt-6.1-sol';
      const validStatus: AISettings['connectionStatus'][] = ['not_configured', 'connected', 'invalid_credentials', 'model_access_problem', 'rate_limited', 'quota_exhausted', 'temporarily_unavailable', 'reconfiguration_required'];
      const status = validStatus.includes(row.connectionStatus as AISettings['connectionStatus']) ? row.connectionStatus as AISettings['connectionStatus'] : 'reconfiguration_required';
      return {
        model: validModel ? row.model as AISettings['model'] : 'gpt-6-luna',
        enabled: validModel && status === 'connected' && row.enabled,
        permissions: permissionsFromJson(row.permissions),
        consentAcceptedAt: row.consentAcceptedAt?.toISOString() ?? null,
        credentialForwardingConsentAcceptedAt: row.credentialForwardingConsentAcceptedAt?.toISOString() ?? null,
        connectionStatus: validModel ? status : 'reconfiguration_required',
        lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
        monthlyRequestLimit: row.monthlyRequestLimit === 60 || row.monthlyRequestLimit === 120 ? row.monthlyRequestLimit : 30,
      };
    },

    async saveSettings(userId, settings) {
      const data = {
        model: settings.model,
        enabled: settings.enabled,
        permissions: settings.permissions,
        consentAcceptedAt: settings.consentAcceptedAt ? new Date(settings.consentAcceptedAt) : null,
        credentialForwardingConsentAcceptedAt: settings.credentialForwardingConsentAcceptedAt ? new Date(settings.credentialForwardingConsentAcceptedAt) : null,
        connectionStatus: settings.connectionStatus,
        lastValidatedAt: settings.lastValidatedAt ? new Date(settings.lastValidatedAt) : null,
        monthlyRequestLimit: settings.monthlyRequestLimit,
      };
      await prisma.aiUserSetting.upsert({ where: { userId }, create: { userId, ...data }, update: data, select: { userId: true } });
    },

    async hasCredential(userId) {
      const row = await prisma.aiUserSetting.findUnique({ where: { userId }, select: { credentialCiphertext: true } });
      return Boolean(row?.credentialCiphertext);
    },

    async saveCredential(userId, ciphertext) {
      await prisma.aiUserSetting.upsert({
        where: { userId },
        create: { userId, credentialCiphertext: ciphertext, permissions: {
          aggregatedFinancialInsights: false, detailedFinancialRecords: false, projectsIntelligence: false,
        } },
        update: { credentialCiphertext: ciphertext },
        select: { userId: true },
      });
    },

    async getCredential(userId) {
      const row = await prisma.aiUserSetting.findUnique({ where: { userId }, select: { credentialCiphertext: true } });
      return row?.credentialCiphertext ?? null;
    },

    async deleteCredential(userId) {
      await prisma.aiUserSetting.updateMany({ where: { userId }, data: { credentialCiphertext: null } });
    },

    async consumeMonthlyRequest(userId, month, limit) {
      const cappedLimit = Math.max(1, Math.min(120, Math.floor(limit)));
      const updated = await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "AiRequestUsage" ("userId", "month", "requestCount", "updatedAt")
        VALUES (${userId}, ${month}, 1, CURRENT_TIMESTAMP)
        ON CONFLICT ("userId", "month") DO UPDATE
        SET "requestCount" = "AiRequestUsage"."requestCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "AiRequestUsage"."requestCount" < ${cappedLimit}
      `);
      return updated === 1;
    },

    async getMonthlyRequestCount(userId, month) {
      const row = await prisma.aiRequestUsage.findUnique({ where: { userId_month: { userId, month } }, select: { requestCount: true } });
      return row?.requestCount ?? 0;
    },

    async tryAcquireConnectionTest(userId) {
      const leaseId = randomUUID();
      const updated = await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "AiRequestLease" ("userId", "leaseId", "expiresAt")
        VALUES (${userId}, ${leaseId}, CURRENT_TIMESTAMP + INTERVAL '30 seconds')
        ON CONFLICT ("userId") DO UPDATE
        SET "leaseId" = EXCLUDED."leaseId", "expiresAt" = EXCLUDED."expiresAt"
        WHERE "AiRequestLease"."expiresAt" <= CURRENT_TIMESTAMP
      `);
      return updated === 1 ? leaseId : null;
    },

    async releaseConnectionTest(userId, leaseId) {
      await prisma.aiRequestLease.deleteMany({ where: { userId, leaseId } });
    },
  };
}

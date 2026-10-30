import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), 'DATABASE_URL must be a PostgreSQL URL'),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().min(1),
  NEON_AUTH_BASE_URL: z.string().url().optional(),
  NEON_AUTH_JWKS_URL: z.string().url().optional(),
  NEON_AUTH_AUDIENCE: z.string().min(1).optional(),
  AI_CREDENTIAL_ENCRYPTION_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^[a-fA-F0-9]{64}$/).optional()),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});

export function parseEnvironment(source: NodeJS.ProcessEnv) {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Backend configuration is invalid. Check: ${missing}`);
  }
  const allowedOrigins = parsed.data.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (allowedOrigins.some((origin) => {
    try { return new URL(origin).protocol !== 'https:' && parsed.data.NODE_ENV === 'production'; }
    catch { return true; }
  })) throw new Error('Production allowed origins must be valid HTTPS origins.');

  const databaseUrl = new URL(parsed.data.DATABASE_URL);
  const localDatabase = ['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname);
  if (parsed.data.NODE_ENV === 'production' && databaseUrl.searchParams.get('sslmode') !== 'require') {
    throw new Error('Production DATABASE_URL must require TLS with sslmode=require.');
  }
  if (parsed.data.NODE_ENV !== 'production' && !localDatabase && databaseUrl.searchParams.get('sslmode') !== 'require') {
    throw new Error('Non-local DATABASE_URL must require TLS with sslmode=require.');
  }
  const authUrl = new URL(parsed.data.BETTER_AUTH_URL);
  if (parsed.data.NODE_ENV === 'production' && authUrl.protocol !== 'https:') {
    throw new Error('BETTER_AUTH_URL must use HTTPS in production.');
  }
  const neonAuthConfigured = Boolean(parsed.data.NEON_AUTH_BASE_URL && parsed.data.NEON_AUTH_JWKS_URL);
  if (Boolean(parsed.data.NEON_AUTH_BASE_URL) !== Boolean(parsed.data.NEON_AUTH_JWKS_URL)) {
    throw new Error('Configure both NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL to enable AI gateway authentication.');
  }
  if (neonAuthConfigured) {
    const neonAuthBase = new URL(parsed.data.NEON_AUTH_BASE_URL!);
    const neonJwks = new URL(parsed.data.NEON_AUTH_JWKS_URL!);
    if (parsed.data.NODE_ENV === 'production' && (neonAuthBase.protocol !== 'https:' || neonJwks.protocol !== 'https:')) {
      throw new Error('Production Neon Auth base and JWKS URLs must use HTTPS.');
    }
    if (neonAuthBase.origin !== neonJwks.origin) {
      throw new Error('The Neon Auth JWKS URL must use the configured Neon Auth origin.');
    }
  }
  if (neonAuthConfigured && !parsed.data.AI_CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('Configure AI_CREDENTIAL_ENCRYPTION_KEY in the server secret manager to enable the AI gateway.');
  }
  if (!neonAuthConfigured && parsed.data.AI_CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('Configure Neon Auth before enabling AI credential encryption.');
  }
  return { ...parsed.data, allowedOrigins };
}

export const env = parseEnvironment(process.env);

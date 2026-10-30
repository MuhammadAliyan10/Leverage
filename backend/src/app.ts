import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { auth } from './auth.js';
import { prisma } from './db.js';
import { env } from './env.js';
import { financeRoutes } from './finance-routes.js';
import { savingsRoutes } from './savings-routes.js';
import { recurringRoutes } from './recurring-routes.js';
import { createAIGateway, createNeonJwtVerifier } from './aiGateway.js';
import { createPrismaAISettingsStore } from './aiGatewayStore.js';

type ApiEnvironment = { Variables: { userId: string } };
export const app = new Hono<ApiEnvironment>();

app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
app.use('/api/*', cors({
  origin: (origin) => env.allowedOrigins.includes(origin) || origin === 'houselog://' ? origin : '',
  allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 600,
}));

app.get('/health/live', (c) => c.json({ status: 'ok' }));
app.get('/health/ready', async (c) => {
  try {
    await (await import('./db.js')).prisma.$queryRaw`SELECT 1`;
    return c.json({ status: 'ready' });
  } catch {
    return c.json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The API database is unavailable.' } }, 503);
  }
});

app.all('/api/auth/*', (c) => auth.handler(c.req.raw));

const requireSession = createMiddleware<ApiEnvironment>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' } }, 401);
  c.set('userId', session.user.id);
  await next();
});

app.use('/api/v1/finance/*', requireSession);
app.use('/api/v1/sync/*', requireSession);
app.route('/api/v1/finance', financeRoutes);
app.route('/api/v1/finance', savingsRoutes);
app.route('/api/v1/finance', recurringRoutes);

if (env.NEON_AUTH_BASE_URL && env.NEON_AUTH_JWKS_URL) {
  const aiGateway = createAIGateway({
    store: createPrismaAISettingsStore(prisma),
    credentialEncryptionKey: env.AI_CREDENTIAL_ENCRYPTION_KEY!,
    verifyNeonToken: createNeonJwtVerifier({
      jwksUrl: env.NEON_AUTH_JWKS_URL,
      issuer: new URL(env.NEON_AUTH_BASE_URL).origin,
      ...(env.NEON_AUTH_AUDIENCE ? { audience: env.NEON_AUTH_AUDIENCE } : {}),
    }),
  });
  app.route('/api/v1/ai', aiGateway);
} else {
  app.all('/api/v1/ai/*', (c) => c.json({ error: { code: 'AI_GATEWAY_NOT_CONFIGURED', message: 'The secure Neon Auth gateway is not configured.' } }, 503));
}

app.get('/api/v1/sync/identity', (c) => c.json({ userId: c.get('userId') }));

app.get('/api/v1/sync/changes', async (c) => {
  const cursorText = c.req.query('after') ?? '0';
  if (!/^(0|[1-9]\d{0,18})$/.test(cursorText)) {
    return c.json({ error: { code: 'INVALID_CURSOR', message: 'The synchronization cursor is invalid.' } }, 400);
  }
  const requested = Number.parseInt(c.req.query('limit') ?? '100', 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
  const after = BigInt(cursorText);
  const rows = await prisma.changeLog.findMany({
    where: { userId: c.get('userId'), cursor: { gt: after } },
    orderBy: { cursor: 'asc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map((row) => ({
    sequence: row.cursor.toString(), entityType: row.entityType, entityId: row.entityId,
    revision: row.revision, payload: row.payload, createdAt: row.createdAt.toISOString(),
  }));
  const nextCursor = data.at(-1)?.sequence ?? cursorText;
  return c.json({ data, nextCursor, hasMore });
});

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));
app.onError((error, c) => {
  const errorCodes = databaseErrorCodes(error);
  if (errorCodes.includes('P2034') || errorCodes.includes('40001') || errorCodes.includes('40P01')) {
    return c.json({ error: { code: 'RETRY_MUTATION', message: 'This operation conflicted with another write. Retry with the same idempotency key.' } }, 503, { 'Retry-After': '1' });
  }
  if (errorCodes.includes('P1001') || errorCodes.includes('P1017')) {
    return c.json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The API database is temporarily unavailable.' } }, 503, { 'Retry-After': '2' });
  }
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
});

function databaseErrorCodes(error: unknown, depth = 0): string[] {
  if (depth > 3 || typeof error !== 'object' || error === null) return [];
  const record = error as Record<string, unknown>;
  const codes = typeof record.code === 'string' ? [record.code] : [];
  const meta = record.meta;
  if (typeof meta === 'object' && meta !== null && 'code' in meta && typeof meta.code === 'string') codes.push(meta.code);
  if ('cause' in record) codes.push(...databaseErrorCodes(record.cause, depth + 1));
  return codes;
}

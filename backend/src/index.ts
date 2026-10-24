import { serve } from '@hono/node-server';
import { app } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' });
let closing = false;

async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => {
    process.stderr.write(`Graceful shutdown timed out after ${signal}.\n`);
    process.exit(1);
  }, 10_000).unref();
}

process.once('SIGINT', () => { void close('SIGINT'); });
process.once('SIGTERM', () => { void close('SIGTERM'); });

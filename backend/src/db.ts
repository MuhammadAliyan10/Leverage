import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from './generated/prisma/client.js';
import { env } from './env.js';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
  max: 5,
});
const adapter = new PrismaPg(pool, { disposeExternalPool: true });

export const prisma = new PrismaClient({ adapter, log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] });

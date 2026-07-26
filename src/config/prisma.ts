import { Prisma, PrismaClient } from '@prisma/client';
import { env, isProduction, isTest } from './env';
import { logger } from '../utils/logger';

/**
 * Prisma client singleton.
 *
 * A single pool per process. Instantiating Prisma per request would exhaust
 * Postgres connections long before the app ran out of CPU — pool sizing is
 * controlled by `connection_limit` in DATABASE_URL, not by client count.
 */

const log: Prisma.LogDefinition[] = isProduction
  ? [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ]
  : [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ];

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log,
    datasources: { db: { url: env.DATABASE_URL } },
    errorFormat: isProduction ? 'minimal' : 'pretty',
  });

  client.$on('warn' as never, (event: Prisma.LogEvent) => {
    logger.warn({ prisma: event }, 'prisma warning');
  });

  client.$on('error' as never, (event: Prisma.LogEvent) => {
    logger.error({ prisma: event }, 'prisma error');
  });

  if (!isProduction && !isTest) {
    client.$on('query' as never, (event: Prisma.QueryEvent) => {
      // Params are omitted deliberately: they routinely contain PII and
      // password hashes.
      logger.debug({ query: event.query, durationMs: event.duration }, 'prisma query');
    });
  }

  return client;
}

/**
 * Reuse the client across hot reloads in development. `tsx watch` re-evaluates
 * modules on every save; without this, each save leaks a connection pool.
 */
const globalForPrisma = globalThis as unknown as { __clinzoPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__clinzoPrisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.__clinzoPrisma = prisma;
}

/** Transaction client type — what `prisma.$transaction(async (tx) => …)` yields. */
export type TransactionClient = Prisma.TransactionClient;

/** Either the root client or a transaction client. Repositories accept both. */
export type PrismaExecutor = PrismaClient | TransactionClient;

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('database connection established');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('database connection closed');
}

/** Liveness probe for the health endpoint. */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'database health check failed');
    return false;
  }
}

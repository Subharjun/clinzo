import type { Server } from 'node:http';
import { app } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { connectDatabase, disconnectDatabase } from './config/prisma';
import { connectRedis, disconnectRedis } from './config/redis';
import { startSchedulers, stopSchedulers } from './jobs/schedulers';

/**
 * HTTP server lifecycle.
 *
 * The important part here is shutdown. A process killed mid-booking-transaction
 * leaves a slot row locked until Postgres times it out, and every other booker
 * for that slot blocks meanwhile. Graceful shutdown — stop accepting, drain
 * in-flight work, then close dependencies — is what makes a rolling deploy
 * invisible to users rather than a burst of 502s.
 */

let server: Server | undefined;
let shuttingDown = false;

async function bootstrap(): Promise<void> {
  // Fail fast: a process that starts without its dependencies just serves
  // errors, which is worse than not starting at all.
  await connectDatabase();
  await connectRedis();

  // Repeatable maintenance jobs (hold sweeper, outbox relay, reminders) are
  // registered from the API process so a deployment without a separate worker
  // still self-heals. The workers themselves run in `jobs/worker.ts`.
  await startSchedulers();

  server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, pid: process.pid },
      'clinzo scheduling api listening',
    );
  });

  // Slightly above a typical 60s ALB idle timeout, so the load balancer closes
  // idle connections first and we never race it into a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

/**
 * Drain and exit.
 *
 * Ordering: stop accepting new connections, let in-flight requests finish,
 * then release dependencies. Closing the database first would fail exactly the
 * requests we are trying to protect.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutdown initiated');

  // Hard deadline: if draining stalls, exiting non-zero is better than hanging
  // forever and blocking a deploy.
  const forceExit = setTimeout(() => {
    logger.error(
      { timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
      'graceful shutdown timed out; forcing exit',
    );
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      logger.info('http server closed to new connections');
    }

    await stopSchedulers();
    await disconnectDatabase();
    await disconnectRedis();

    logger.info('shutdown complete');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An unhandled rejection means a promise chain lost its error. The process
 * state is unknown from here, so drain and let the orchestrator restart us
 * rather than continuing on corrupt assumptions.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException');
});

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start server');
  process.exit(1);
});

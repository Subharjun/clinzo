import { Worker, type Job } from 'bullmq';
import { bullConnection, connectRedis, disconnectRedis } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { jobsProcessedTotal } from '../config/metrics';
import { connectDatabase, disconnectDatabase } from '../config/prisma';
import { JobName, QueueName } from './queues';
import { relayOutboxBatch } from './processors/outbox-relay.processor';
import { expireHold, sweepExpiredHolds } from './processors/hold-expiry.processor';
import {
  sendAppointmentReminder,
  sendBookingConfirmation,
  sendCancellationNotice,
  sendRescheduleNotice,
  sendWaitlistAlert,
} from './processors/notification.processor';
import {
  expireWaitlistEntries,
  purgeExpiredRefreshTokens,
  purgeIdempotencyKeys,
  purgePublishedOutbox,
  scheduleReminders,
} from './processors/maintenance.processor';

/**
 * Background worker process.
 *
 * Deployed separately from the API so that a burst of notification work cannot
 * consume the CPU that is serving booking requests, and so the two can be
 * scaled independently — in practice the API scales with traffic and the
 * worker with event volume, which are not the same curve.
 *
 * Concurrency is set per queue rather than globally: notifications are
 * IO-bound and tolerate high concurrency, while the outbox relay must stay at
 * 1 per process so batches are not interleaved unnecessarily.
 */

/** Wrap a processor with uniform metrics and error logging. */
function instrument<T>(queue: string, handler: (job: Job) => Promise<T>): (job: Job) => Promise<T> {
  return async (job: Job): Promise<T> => {
    try {
      const result = await handler(job);
      jobsProcessedTotal.inc({ queue, result: 'success' });
      return result;
    } catch (error) {
      jobsProcessedTotal.inc({ queue, result: 'failure' });
      logger.error(
        { err: error, queue, jobName: job.name, jobId: job.id, attempt: job.attemptsMade + 1 },
        'job failed',
      );
      // Rethrow so BullMQ applies the queue's retry policy.
      throw error;
    }
  };
}

const workers: Worker[] = [];

function createWorkers(): void {
  workers.push(
    new Worker(
      QueueName.NOTIFICATION,
      instrument(QueueName.NOTIFICATION, async (job) => {
        switch (job.name) {
          case JobName.SEND_BOOKING_CONFIRMATION:
            return sendBookingConfirmation(job.data);
          case JobName.SEND_CANCELLATION_NOTICE:
            return sendCancellationNotice(job.data);
          case JobName.SEND_RESCHEDULE_NOTICE:
            return sendRescheduleNotice(job.data);
          case JobName.SEND_APPOINTMENT_REMINDER:
            return sendAppointmentReminder(job.data);
          case JobName.SEND_WAITLIST_ALERT:
            return sendWaitlistAlert(job.data);
          default:
            // An unknown name means a deploy skew; log loudly rather than
            // failing forever on a job this version cannot understand.
            logger.warn({ jobName: job.name }, 'unknown notification job; discarding');
            return undefined;
        }
      }),
      {
        connection: bullConnection,
        prefix: env.BULLMQ_PREFIX,
        concurrency: env.WORKER_CONCURRENCY,
      },
    ),
  );

  workers.push(
    new Worker(
      QueueName.HOLD_EXPIRY,
      instrument(QueueName.HOLD_EXPIRY, async (job) => {
        switch (job.name) {
          case JobName.EXPIRE_HOLD:
            return expireHold(job.data.holdId);
          case JobName.SWEEP_EXPIRED_HOLDS:
            return sweepExpiredHolds();
          default:
            logger.warn({ jobName: job.name }, 'unknown hold-expiry job; discarding');
            return undefined;
        }
      }),
      {
        connection: bullConnection,
        prefix: env.BULLMQ_PREFIX,
        // Each job takes a slot lock; moderate concurrency avoids lock churn.
        concurrency: Math.min(env.WORKER_CONCURRENCY, 5),
      },
    ),
  );

  workers.push(
    new Worker(
      QueueName.OUTBOX_RELAY,
      instrument(QueueName.OUTBOX_RELAY, async () => relayOutboxBatch()),
      {
        connection: bullConnection,
        prefix: env.BULLMQ_PREFIX,
        // Exactly one relay batch in flight per process. Parallel batches
        // would still be correct (SKIP LOCKED guarantees disjoint claims) but
        // would produce no extra throughput and more connection pressure.
        concurrency: 1,
      },
    ),
  );

  workers.push(
    new Worker(
      QueueName.MAINTENANCE,
      instrument(QueueName.MAINTENANCE, async (job) => {
        switch (job.name) {
          case JobName.PURGE_EXPIRED_TOKENS:
            return purgeExpiredRefreshTokens();
          case JobName.PURGE_IDEMPOTENCY_KEYS:
            return purgeIdempotencyKeys();
          case JobName.PURGE_PUBLISHED_OUTBOX:
            return purgePublishedOutbox();
          case JobName.EXPIRE_WAITLIST_ENTRIES:
            return expireWaitlistEntries();
          case JobName.SCHEDULE_REMINDERS:
            return scheduleReminders();
          default:
            logger.warn({ jobName: job.name }, 'unknown maintenance job; discarding');
            return undefined;
        }
      }),
      { connection: bullConnection, prefix: env.BULLMQ_PREFIX, concurrency: 1 },
    ),
  );

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      logger.error({ jobId: job?.id, jobName: job?.name, err: error }, 'job moved to failed state');
    });
    worker.on('error', (error) => {
      logger.error({ err: error }, 'worker error');
    });
  }
}

async function bootstrap(): Promise<void> {
  await connectDatabase();
  await connectRedis();

  createWorkers();

  logger.info(
    { queues: workers.length, concurrency: env.WORKER_CONCURRENCY, pid: process.pid },
    'clinzo worker started',
  );
}

let shuttingDown = false;

/**
 * Drain in-flight jobs before exiting.
 *
 * `worker.close()` waits for active jobs to finish rather than killing them,
 * which matters: a job interrupted mid-transaction would be retried and, if it
 * were not idempotent, would duplicate work. Every processor here is
 * idempotent, but draining cleanly means the retry never has to happen.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'worker shutdown initiated');

  const forceExit = setTimeout(() => {
    logger.error('worker shutdown timed out; forcing exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await Promise.all(workers.map((worker) => worker.close()));
    await disconnectDatabase();
    await disconnectRedis();

    logger.info('worker shutdown complete');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start worker');
  process.exit(1);
});

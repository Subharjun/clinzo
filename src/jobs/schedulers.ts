import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  JobName,
  holdExpiryQueue,
  maintenanceQueue,
  outboxRelayQueue,
  closeQueues,
} from './queues';

/**
 * Repeatable job registration.
 *
 * BullMQ repeatable jobs are keyed by name + pattern, so registering the same
 * schedule from every replica converges on one entry rather than N. That is
 * what makes it safe to call `startSchedulers()` unconditionally at boot
 * without leader election or a designated "cron pod".
 *
 * Cadences are chosen against the cost of being late, not by habit:
 *
 *  - Outbox relay: every 2s. A confirmation email arriving 2s after booking is
 *    fine; 30s is not.
 *  - Hold sweep: every 30s. The delayed job normally handles expiry within
 *    milliseconds; this only catches failures, so it trades latency for load.
 *  - Maintenance: hourly/daily. Nothing here is time-critical.
 */

export async function startSchedulers(): Promise<void> {
  await outboxRelayQueue.add(
    JobName.RELAY_OUTBOX,
    {},
    {
      repeat: { every: env.OUTBOX_POLL_INTERVAL_MS },
      // A backlog of relay ticks is useless — only the newest matters.
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  await holdExpiryQueue.add(
    JobName.SWEEP_EXPIRED_HOLDS,
    {},
    { repeat: { every: 30_000 }, removeOnComplete: true, removeOnFail: 100 },
  );

  await maintenanceQueue.add(
    JobName.SCHEDULE_REMINDERS,
    {},
    { repeat: { pattern: '0 * * * *' }, removeOnComplete: true, removeOnFail: 50 },
  );

  await maintenanceQueue.add(
    JobName.EXPIRE_WAITLIST_ENTRIES,
    {},
    { repeat: { pattern: '*/15 * * * *' }, removeOnComplete: true, removeOnFail: 50 },
  );

  // Off-peak, since these are bulk deletes that can hold locks briefly.
  await maintenanceQueue.add(
    JobName.PURGE_EXPIRED_TOKENS,
    {},
    { repeat: { pattern: '15 3 * * *' }, removeOnComplete: true, removeOnFail: 50 },
  );

  await maintenanceQueue.add(
    JobName.PURGE_IDEMPOTENCY_KEYS,
    {},
    { repeat: { pattern: '30 3 * * *' }, removeOnComplete: true, removeOnFail: 50 },
  );

  await maintenanceQueue.add(
    JobName.PURGE_PUBLISHED_OUTBOX,
    {},
    { repeat: { pattern: '45 3 * * *' }, removeOnComplete: true, removeOnFail: 50 },
  );

  logger.info('repeatable jobs registered');
}

export async function stopSchedulers(): Promise<void> {
  await closeQueues();
  logger.info('queues closed');
}

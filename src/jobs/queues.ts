import { Queue, type JobsOptions } from 'bullmq';
import { bullConnection } from '../config/redis';
import { env } from '../config/env';

/**
 * BullMQ queue definitions.
 *
 * Queues are separated by *failure profile*, not by feature. Notifications
 * talk to flaky third parties and need aggressive retries; hold expiry is a
 * local database write that should either work immediately or be caught by the
 * sweeper. Putting them in one queue would force one retry policy onto both,
 * and a notification backlog would delay slot releases — directly costing
 * revenue.
 */

export const QueueName = {
  NOTIFICATION: 'notifications',
  HOLD_EXPIRY: 'hold-expiry',
  OUTBOX_RELAY: 'outbox-relay',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueNameValue = (typeof QueueName)[keyof typeof QueueName];

export const JobName = {
  SEND_BOOKING_CONFIRMATION: 'send-booking-confirmation',
  SEND_CANCELLATION_NOTICE: 'send-cancellation-notice',
  SEND_RESCHEDULE_NOTICE: 'send-reschedule-notice',
  SEND_APPOINTMENT_REMINDER: 'send-appointment-reminder',
  SEND_WAITLIST_ALERT: 'send-waitlist-alert',

  EXPIRE_HOLD: 'expire-hold',
  SWEEP_EXPIRED_HOLDS: 'sweep-expired-holds',

  RELAY_OUTBOX: 'relay-outbox',

  PURGE_EXPIRED_TOKENS: 'purge-expired-tokens',
  PURGE_IDEMPOTENCY_KEYS: 'purge-idempotency-keys',
  PURGE_PUBLISHED_OUTBOX: 'purge-published-outbox',
  EXPIRE_WAITLIST_ENTRIES: 'expire-waitlist-entries',
  SCHEDULE_REMINDERS: 'schedule-reminders',
} as const;

/**
 * Retry policy for work that crosses a network boundary.
 * Exponential backoff from 2s: 2s, 4s, 8s, 16s, 32s — roughly a minute of
 * patience, which covers most transient provider outages without pinning a
 * worker on a permanently failing job.
 */
const externalCallOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  // Keep a bounded history: enough to debug this morning's incident, not
  // enough to grow Redis without limit.
  removeOnComplete: { count: 1_000, age: 24 * 3_600 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 3_600 },
};

/**
 * Retry policy for local database work. Fewer attempts because the sweeper is
 * the real safety net — a hold that fails to expire here is caught within a
 * minute regardless.
 */
const localWorkOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 500, age: 3_600 },
  removeOnFail: { count: 1_000, age: 24 * 3_600 },
};

function createQueue(name: QueueNameValue, defaultJobOptions: JobsOptions): Queue {
  return new Queue(name, {
    connection: bullConnection,
    prefix: env.BULLMQ_PREFIX,
    defaultJobOptions,
  });
}

export const notificationQueue = createQueue(QueueName.NOTIFICATION, externalCallOptions);
export const holdExpiryQueue = createQueue(QueueName.HOLD_EXPIRY, localWorkOptions);
export const outboxRelayQueue = createQueue(QueueName.OUTBOX_RELAY, localWorkOptions);
export const maintenanceQueue = createQueue(QueueName.MAINTENANCE, localWorkOptions);

export const allQueues: Queue[] = [
  notificationQueue,
  holdExpiryQueue,
  outboxRelayQueue,
  maintenanceQueue,
];

/**
 * Schedule a hold's expiry.
 *
 * `jobId` is derived from the hold id so re-scheduling the same hold replaces
 * rather than duplicates the job — BullMQ deduplicates on job id, which makes
 * this call idempotent.
 *
 * Note this is a *convenience*, not the guarantee: Redis key TTL already frees
 * the hold, and the sweeper catches anything this job misses.
 */
export async function scheduleHoldExpiry(holdId: string, expiresAt: Date): Promise<void> {
  const delay = Math.max(0, expiresAt.getTime() - Date.now());

  await holdExpiryQueue.add(JobName.EXPIRE_HOLD, { holdId }, { jobId: `hold-${holdId}`, delay });
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled(allQueues.map((queue) => queue.close()));
}

import { logger } from '../../utils/logger';
import { refreshTokenRepository } from '../../repositories/refresh-token.repository';
import { outboxRepository } from '../../repositories/outbox.repository';
import { waitlistRepository } from '../../repositories/waitlist.repository';
import { bookingRepository } from '../../repositories/booking.repository';
import { purgeExpiredIdempotencyKeys } from '../../middlewares/idempotency.middleware';
import { notificationQueue, JobName } from '../queues';

/**
 * Periodic housekeeping.
 *
 * Every task here is *convergent*: it can run twice, or be skipped for a day,
 * without corrupting anything. That is what makes it safe to run from any
 * replica without leader election.
 */

/** Published outbox rows are kept this long for post-incident debugging. */
const OUTBOX_RETENTION_HOURS = 48;

/** How far ahead reminders are scheduled on each pass. */
const REMINDER_LOOKAHEAD_HOURS = 25;

/** How long before an appointment the reminder fires. */
const REMINDER_LEAD_HOURS = 24;

export async function purgeExpiredRefreshTokens(): Promise<number> {
  // Only genuinely expired rows go. Revoked-but-unexpired rows are retained
  // deliberately: they are what makes refresh-token reuse detectable.
  const deleted = await refreshTokenRepository.deleteExpired();

  if (deleted > 0) logger.info({ deleted }, 'purged expired refresh tokens');
  return deleted;
}

export async function purgeIdempotencyKeys(): Promise<number> {
  const deleted = await purgeExpiredIdempotencyKeys();

  if (deleted > 0) logger.info({ deleted }, 'purged expired idempotency keys');
  return deleted;
}

export async function purgePublishedOutbox(): Promise<number> {
  const before = new Date(Date.now() - OUTBOX_RETENTION_HOURS * 3_600_000);
  const deleted = await outboxRepository.purgePublishedBefore(before);

  if (deleted > 0) logger.info({ deleted }, 'purged published outbox events');
  return deleted;
}

export async function expireWaitlistEntries(): Promise<number> {
  const expired = await waitlistRepository.expirePastWindows(new Date());

  if (expired > 0) logger.info({ expired }, 'expired waitlist entries whose window has passed');
  return expired;
}

/**
 * Schedule 24-hour reminders.
 *
 * Runs hourly with a 25-hour lookahead, so the windows overlap by an hour and
 * a single missed run cannot silently drop a day of reminders. The overlap is
 * harmless because the job id is derived from the booking id — BullMQ
 * deduplicates, so a booking scheduled twice still gets exactly one reminder.
 */
export async function scheduleReminders(): Promise<number> {
  const now = new Date();
  const from = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3_600_000);
  const to = new Date(now.getTime() + REMINDER_LOOKAHEAD_HOURS * 3_600_000);

  const bookings = await bookingRepository.findStartingBetween(from, to);
  let scheduled = 0;

  for (const booking of bookings) {
    const fireAt = booking.startsAt.getTime() - REMINDER_LEAD_HOURS * 3_600_000;
    const delay = Math.max(0, fireAt - Date.now());

    await notificationQueue.add(
      JobName.SEND_APPOINTMENT_REMINDER,
      { bookingId: booking.id },
      { jobId: `reminder-${booking.id}`, delay },
    );
    scheduled += 1;
  }

  if (scheduled > 0) logger.info({ scheduled }, 'scheduled appointment reminders');
  return scheduled;
}

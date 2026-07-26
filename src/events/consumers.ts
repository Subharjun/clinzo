import type { OutboxEvent } from '@prisma/client';
import { logger } from '../utils/logger';
import { waitlistService } from '../services/waitlist.service';
import { EventType, type SlotReleasedPayload } from './domain-events';

/**
 * In-process event consumers.
 *
 * Invoked by the outbox relay after an event is published. Consumers must be
 * **idempotent**: the outbox guarantees at-least-once delivery, so any handler
 * here may run twice for the same event after a crash between publish and
 * mark-published.
 *
 * A consumer that throws fails the relay for that event, which is then retried
 * with backoff. Handlers should therefore only throw on genuinely transient
 * failures — a permanent one would loop until it exhausts its attempts and
 * lands in the dead-letter state.
 */

export async function dispatchToConsumers(event: OutboxEvent): Promise<void> {
  switch (event.eventType) {
    case EventType.SLOT_RELEASED:
      await onSlotReleased(event);
      break;

    default:
      // Most events have no in-process consumer; their side effects are
      // durable jobs enqueued by the publisher.
      break;
  }
}

/**
 * A slot returned to sale — match it against the waitlist.
 *
 * Runs here rather than inside the cancellation transaction on purpose: the
 * booking critical section must stay short, and a slow waitlist scan holding a
 * row lock would directly increase contention for every other booker.
 *
 * Idempotency comes from `markNotified`, which only transitions entries out of
 * ACTIVE — a replay finds nothing left to notify and does nothing.
 */
async function onSlotReleased(event: OutboxEvent): Promise<void> {
  const payload = event.payload as unknown as SlotReleasedPayload;

  try {
    const notified = await waitlistService.notifyForReleasedSlot({
      slotId: payload.slotId,
      doctorId: payload.doctorId,
      startsAt: new Date(payload.startsAt),
      endsAt: new Date(payload.endsAt),
      appointmentType: payload.appointmentType,
    });

    if (notified.length > 0) {
      logger.info(
        { slotId: payload.slotId, candidates: notified.length, releasedBy: payload.releasedBy },
        'notified waitlist candidates of a freed slot',
      );
    }
  } catch (error) {
    // Deliberately swallowed: failing to notify a waitlist is regrettable, but
    // retrying the whole event would also re-run any other consumer attached
    // to it. The freed slot is already bookable by anyone browsing.
    logger.error(
      { err: error, slotId: payload.slotId },
      'failed to notify waitlist for released slot',
    );
  }
}

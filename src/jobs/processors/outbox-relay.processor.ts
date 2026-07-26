import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { outboxBacklog, outboxEventsTotal } from '../../config/metrics';
import { outboxRepository } from '../../repositories/outbox.repository';
import { eventPublisher, toPublishable } from '../../events/event-publisher';
import { dispatchToConsumers } from '../../events/consumers';

/**
 * Outbox relay — moves committed domain events out to their consumers.
 *
 * Runs on a short interval and claims batches with `FOR UPDATE SKIP LOCKED`,
 * so several relay processes can run concurrently without duplicating work or
 * blocking one another. That property is what lets the worker tier scale
 * horizontally instead of requiring a designated leader.
 *
 * Delivery is at-least-once by construction: an event may be published and the
 * process crash before it is marked PUBLISHED, in which case it is republished.
 * Consumers deduplicate on `event-id`.
 */

const MAX_PUBLISH_ATTEMPTS = 8;

export async function relayOutboxBatch(): Promise<{ published: number; failed: number }> {
  const events = await outboxRepository.claimBatch(env.OUTBOX_BATCH_SIZE);

  if (events.length === 0) {
    // Keep the backlog gauge fresh even on an idle tick, so a flatline is
    // distinguishable from a stopped relay.
    outboxBacklog.set(await outboxRepository.countPending());
    return { published: 0, failed: 0 };
  }

  const publishedIds: string[] = [];
  let failed = 0;

  for (const event of events) {
    try {
      await eventPublisher.publish(toPublishable(event));
      await dispatchToConsumers(event);

      publishedIds.push(event.id);
      outboxEventsTotal.inc({ event_type: event.eventType, result: 'published' });
    } catch (error) {
      failed += 1;
      outboxEventsTotal.inc({ event_type: event.eventType, result: 'failed' });

      const message = error instanceof Error ? error.message : String(error);

      await outboxRepository.markFailed(event.id, message, event.attempts, MAX_PUBLISH_ATTEMPTS);

      logger.error(
        { err: error, eventId: event.id, eventType: event.eventType, attempts: event.attempts },
        event.attempts >= MAX_PUBLISH_ATTEMPTS
          ? 'outbox event exhausted its attempts and was parked as FAILED'
          : 'outbox event publication failed; will retry with backoff',
      );
    }
  }

  await outboxRepository.markPublished(publishedIds);
  outboxBacklog.set(await outboxRepository.countPending());

  if (publishedIds.length > 0) {
    logger.debug({ published: publishedIds.length, failed }, 'outbox batch relayed');
  }

  return { published: publishedIds.length, failed };
}

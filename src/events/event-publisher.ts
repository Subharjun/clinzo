import type { OutboxEvent } from '@prisma/client';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { notificationQueue, JobName } from '../jobs/queues';
import { EventType } from './domain-events';

/**
 * Event publishing abstraction.
 *
 * ## Why an interface rather than direct BullMQ calls
 *
 * Today every consumer is in-process, so events go to BullMQ and Redis pub/sub.
 * When notifications move to their own service — the usual next step — the
 * transport becomes Kafka. That change should touch one file, not every place
 * that publishes an event.
 *
 * The abstraction is shaped around what Kafka needs, not what Redis needs, so
 * the migration is a swap rather than a redesign:
 *
 *  - `topic` maps to a Kafka topic; here it is a Redis channel.
 *  - `key` is the partition key. Using the aggregate id guarantees that all
 *    events for one booking land on one partition and are therefore consumed
 *    in order — the property that is painful to retrofit later.
 *  - `headers` carry the event id, enabling consumer-side deduplication, which
 *    at-least-once delivery makes mandatory.
 */

export interface PublishableEvent {
  /** Logical stream. Maps to a Kafka topic or a Redis channel. */
  topic: string;
  /** Partition key — ordering is only guaranteed within one key. */
  key: string;
  eventType: string;
  payload: unknown;
  headers: Record<string, string>;
}

export interface EventPublisher {
  publish(event: PublishableEvent): Promise<void>;
  close(): Promise<void>;
}

/** Map an aggregate type onto its stream. */
function topicFor(aggregateType: string): string {
  return `clinzo.${aggregateType.toLowerCase()}.events`;
}

export function toPublishable(event: OutboxEvent): PublishableEvent {
  return {
    topic: topicFor(event.aggregateType),
    key: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
    headers: {
      'event-id': event.id,
      'event-type': event.eventType,
      'aggregate-type': event.aggregateType,
      'aggregate-id': event.aggregateId,
      'occurred-at': event.createdAt.toISOString(),
    },
  };
}

/**
 * Current implementation: Redis pub/sub for fan-out to any listener, plus
 * BullMQ jobs for the work that must survive a restart.
 *
 * Pub/sub alone would be wrong — it is fire-and-forget, so a subscriber that
 * is down when a message is published never sees it. Anything that must happen
 * (sending a confirmation email) is enqueued as a durable job; pub/sub is used
 * only for the observational fan-out.
 */
export class RedisEventPublisher implements EventPublisher {
  async publish(event: PublishableEvent): Promise<void> {
    await redis.publish(
      event.topic,
      JSON.stringify({
        key: event.key,
        eventType: event.eventType,
        payload: event.payload,
        headers: event.headers,
      }),
    );

    await this.enqueueSideEffects(event);
  }

  /**
   * Translate a domain event into the durable work it implies.
   *
   * This is the seam a real deployment would move into separate consumer
   * services; the mapping itself would not change.
   */
  private async enqueueSideEffects(event: PublishableEvent): Promise<void> {
    // The event id doubles as the job id, so a redelivered outbox event
    // produces the same job rather than a duplicate notification. This is how
    // at-least-once delivery is made effectively-once for the user.
    const jobId = event.headers['event-id'];

    switch (event.eventType) {
      case EventType.BOOKING_CREATED:
        await notificationQueue.add(JobName.SEND_BOOKING_CONFIRMATION, event.payload, {
          jobId: `confirm-${jobId}`,
        });
        break;

      case EventType.BOOKING_CANCELLED:
        await notificationQueue.add(JobName.SEND_CANCELLATION_NOTICE, event.payload, {
          jobId: `cancel-${jobId}`,
        });
        break;

      case EventType.BOOKING_RESCHEDULED:
        await notificationQueue.add(JobName.SEND_RESCHEDULE_NOTICE, event.payload, {
          jobId: `reschedule-${jobId}`,
        });
        break;

      case EventType.WAITLIST_SLOT_AVAILABLE:
        await notificationQueue.add(JobName.SEND_WAITLIST_ALERT, event.payload, {
          jobId: `waitlist-${jobId}`,
        });
        break;

      case EventType.SLOT_RELEASED:
      case EventType.HOLD_CREATED:
      case EventType.HOLD_EXPIRED:
      case EventType.HOLD_RELEASED:
      case EventType.SLOT_BLOCKED:
      case EventType.AVAILABILITY_CHANGED:
        // Handled by in-process consumers (see events/consumers.ts) or purely
        // observational. No durable job required.
        break;

      default:
        logger.warn({ eventType: event.eventType }, 'no side effects registered for event type');
    }
  }

  async close(): Promise<void> {
    // Connections are owned by config/redis and closed by the server lifecycle.
  }
}

/**
 * Sketch of the Kafka implementation, kept as a comment rather than as dead
 * code so the intended migration path is documented without shipping an
 * untested class:
 *
 *   class KafkaEventPublisher implements EventPublisher {
 *     async publish(event: PublishableEvent) {
 *       await this.producer.send({
 *         topic: event.topic,
 *         messages: [{
 *           key: event.key,            // partition by aggregate -> ordering
 *           value: JSON.stringify(event.payload),
 *           headers: event.headers,    // event-id -> consumer dedup
 *         }],
 *       });
 *     }
 *   }
 *
 * The outbox relay would need no changes: it already speaks `PublishableEvent`.
 */

export const eventPublisher: EventPublisher = new RedisEventPublisher();

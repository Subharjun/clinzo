import { OutboxStatus, Prisma, type OutboxEvent } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';
import type { AggregateTypeName, EventTypeName } from '../events/domain-events';

/**
 * Transactional outbox.
 *
 * The problem this solves: a booking must both (a) commit to Postgres and
 * (b) trigger a confirmation email. Doing (b) inside the transaction couples
 * commit latency to an external service; doing it after commit means a crash
 * in between silently loses the notification — the classic dual-write failure.
 *
 * Instead, the event row is written in the SAME transaction as the state
 * change, and a relay process publishes it afterwards. The trade is
 * at-least-once delivery: consumers must be idempotent. That is a far easier
 * property to guarantee than distributed atomicity.
 */

export interface OutboxWrite {
  aggregateType: AggregateTypeName;
  aggregateId: string;
  eventType: EventTypeName;
  payload: Prisma.InputJsonValue;
  /** Delay publication (e.g. a reminder scheduled for later). */
  availableAt?: Date;
}

export class OutboxRepository {
  /**
   * Enqueue an event. MUST be called with the transaction client that is
   * performing the state change — passing the root client reintroduces exactly
   * the dual-write problem this pattern exists to remove.
   */
  async enqueue(event: OutboxWrite, executor: PrismaExecutor): Promise<void> {
    await executor.outboxEvent.create({
      data: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        availableAt: event.availableAt ?? new Date(),
      },
    });
  }

  async enqueueMany(events: OutboxWrite[], executor: PrismaExecutor): Promise<void> {
    if (events.length === 0) return;

    await executor.outboxEvent.createMany({
      data: events.map((event) => ({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        availableAt: event.availableAt ?? new Date(),
      })),
    });
  }

  /**
   * Claim a batch of due events for publication.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes the relay horizontally scalable:
   * several relay processes can poll the same table concurrently and each
   * takes a disjoint batch instead of serialising behind one another.
   */
  async claimBatch(limit: number, executor: PrismaExecutor = prisma): Promise<OutboxEvent[]> {
    return executor.$queryRaw<OutboxEvent[]>`
      UPDATE "outbox_events"
      SET "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "outbox_events"
        WHERE "status" = 'PENDING' AND "availableAt" <= now()
        ORDER BY "availableAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
  }

  async markPublished(ids: string[], executor: PrismaExecutor = prisma): Promise<void> {
    if (ids.length === 0) return;

    await executor.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { status: OutboxStatus.PUBLISHED, publishedAt: new Date(), lastError: null },
    });
  }

  /**
   * Reschedule a failed event with exponential backoff, or park it as FAILED
   * once it has exhausted its attempts so it stops consuming relay capacity
   * and becomes visible on a dead-letter dashboard.
   */
  async markFailed(
    id: string,
    error: string,
    attempts: number,
    maxAttempts: number,
    executor: PrismaExecutor = prisma,
  ): Promise<void> {
    const exhausted = attempts >= maxAttempts;
    const backoffMs = Math.min(2 ** attempts * 1000, 5 * 60_000);

    await executor.outboxEvent.update({
      where: { id },
      data: {
        status: exhausted ? OutboxStatus.FAILED : OutboxStatus.PENDING,
        // Truncated: a driver stack trace can be megabytes.
        lastError: error.slice(0, 1000),
        availableAt: exhausted ? undefined : new Date(Date.now() + backoffMs),
      },
    });
  }

  async countPending(executor: PrismaExecutor = prisma): Promise<number> {
    return executor.outboxEvent.count({ where: { status: OutboxStatus.PENDING } });
  }

  /** Housekeeping — published events are retained briefly for debugging. */
  async purgePublishedBefore(before: Date, executor: PrismaExecutor = prisma): Promise<number> {
    const result = await executor.outboxEvent.deleteMany({
      where: { status: OutboxStatus.PUBLISHED, publishedAt: { lt: before } },
    });
    return result.count;
  }
}

export const outboxRepository = new OutboxRepository();

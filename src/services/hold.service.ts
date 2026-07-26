import { HoldStatus, Role, SlotStatus, type ReservationHold } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { redis, redisKeys } from '../config/redis';
import { reservationHoldsTotal } from '../config/metrics';
import { logger } from '../utils/logger';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SlotUnavailableError,
} from '../utils/errors';
import { slotRepository } from '../repositories/slot.repository';
import { reservationHoldRepository } from '../repositories/reservation-hold.repository';
import { outboxRepository } from '../repositories/outbox.repository';
import { AuditAction, auditLogRepository } from '../repositories/audit-log.repository';
import { AggregateType, EventType } from '../events/domain-events';
import { lockService } from './lock.service';
import { scheduleHoldExpiry } from '../jobs/queues';
import type { SessionContext } from './auth.service';

/**
 * Reservation holds — the checkout window.
 *
 * ## Why holds exist
 *
 * Payment is slow and can fail. Booking a slot only after payment succeeds
 * means two patients can both reach a payment screen for one slot and one gets
 * charged for an appointment that no longer exists. Booking *before* payment
 * means an abandoned checkout permanently destroys inventory.
 *
 * A hold is the middle ground: the slot is taken off sale for a short, bounded
 * period while checkout completes, then either converts to a booking or
 * evaporates.
 *
 * ## Where expiry actually lives
 *
 * Redis owns it. The hold key is written with `SET NX PX <ttl>`, so the hold
 * disappears with no code running at all — no cron, no worker, no clock skew
 * between processes. Even a total application outage cannot leave a slot
 * stuck in HELD forever.
 *
 * Two reconciling mechanisms cover what Redis expiry alone does not:
 *
 *  1. A BullMQ **delayed job** scheduled for the expiry instant flips the
 *     Postgres row from HELD back to AVAILABLE, since Redis key expiry cannot
 *     write to Postgres.
 *  2. A periodic **sweeper** catches anything the delayed job missed (worker
 *     restart, queue loss). It is the safety net that makes the design
 *     self-healing rather than merely usually-correct.
 *
 * Both are idempotent and both re-check `heldUntil <= now`, so a late job
 * cannot release a hold that was renewed in the meantime.
 */

/** How many slots one patient may hold at once — prevents inventory hoarding. */
const MAX_CONCURRENT_HOLDS_PER_PATIENT = 3;

export interface CreateHoldInput {
  slotId: string;
  patientId: string;
  checkoutReference?: string;
}

export interface HoldView {
  id: string;
  slotId: string;
  patientId: string;
  expiresAt: Date;
  /** Seconds remaining — what a checkout countdown renders. */
  ttlSeconds: number;
  status: HoldStatus;
}

export class HoldService {
  /**
   * Place a hold on a slot.
   *
   * Ordering is deliberate: Redis first (cheap, and its TTL is the thing that
   * guarantees release), then Postgres. If the Postgres write fails, the Redis
   * key is removed so the slot is not stranded — and even if that cleanup also
   * fails, the TTL still frees it.
   */
  async create(input: CreateHoldInput, context: SessionContext): Promise<HoldView> {
    const ttlSeconds = env.RESERVATION_HOLD_TTL_SECONDS;

    const activeHolds = await reservationHoldRepository.countActiveForPatient(input.patientId);
    if (activeHolds >= MAX_CONCURRENT_HOLDS_PER_PATIENT) {
      throw new BusinessRuleError(
        `You already have ${activeHolds} slots on hold; complete or cancel one before reserving another`,
        { limit: MAX_CONCURRENT_HOLDS_PER_PATIENT },
      );
    }

    return lockService.withLock(
      redisKeys.slotLock(input.slotId),
      async () => {
        const slot = await slotRepository.findById(input.slotId);
        if (!slot) throw new NotFoundError('Slot');

        if (slot.status !== SlotStatus.AVAILABLE) {
          throw new SlotUnavailableError(
            slot.status === SlotStatus.HELD
              ? 'This slot is already reserved by another patient'
              : 'This slot is not available',
            { slotId: slot.id, status: slot.status },
          );
        }
        if (slot.startsAt <= new Date()) {
          throw new BusinessRuleError('This slot has already started', { slotId: slot.id });
        }

        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const holdKey = redisKeys.hold(slot.id);

        // NX makes this the atomic claim: a second checkout for the same slot
        // cannot also succeed, even between our read and write above.
        const claimed = await redis.set(holdKey, input.patientId, 'EX', ttlSeconds, 'NX');
        if (claimed !== 'OK') {
          throw new SlotUnavailableError('This slot was just reserved by another patient', {
            slotId: slot.id,
          });
        }

        try {
          const hold = await prisma.$transaction(async (tx) => {
            const created = await reservationHoldRepository.create(
              {
                slotId: slot.id,
                patientId: input.patientId,
                expiresAt,
                checkoutReference: input.checkoutReference ?? null,
              },
              tx,
            );

            const marked = await slotRepository.markHeld(slot.id, expiresAt, tx);
            if (!marked) {
              throw new SlotUnavailableError('This slot changed state while being reserved', {
                slotId: slot.id,
              });
            }

            await auditLogRepository.record(
              {
                actorId: context.userId ?? null,
                actorRole: Role.PATIENT,
                action: AuditAction.HOLD_CREATED,
                entityType: 'ReservationHold',
                entityId: created.id,
                metadata: {
                  slotId: slot.id,
                  patientId: input.patientId,
                  expiresAt: expiresAt.toISOString(),
                },
                requestId: context.requestId ?? null,
              },
              tx,
            );

            await outboxRepository.enqueue(
              {
                aggregateType: AggregateType.HOLD,
                aggregateId: created.id,
                eventType: EventType.HOLD_CREATED,
                payload: {
                  holdId: created.id,
                  slotId: slot.id,
                  patientId: input.patientId,
                  doctorId: slot.doctorId,
                  expiresAt: expiresAt.toISOString(),
                },
              },
              tx,
            );

            return created;
          });

          reservationHoldsTotal.inc({ event: 'created' });

          // Fast-path release. Failure here is non-fatal: the Redis TTL still
          // frees the slot for booking, and the periodic sweeper reconciles
          // the Postgres row. Enqueue failure must never fail the checkout.
          await scheduleHoldExpiry(hold.id, expiresAt).catch((error: unknown) => {
            logger.warn(
              { err: error, holdId: hold.id },
              'failed to schedule hold expiry job; the sweeper will reconcile',
            );
          });

          return this.toView(hold, ttlSeconds);
        } catch (error) {
          // Roll the Redis claim back so the slot is not held by a hold that
          // does not exist. Failure here is survivable — the TTL still fires.
          await redis.del(holdKey).catch((cleanupError: unknown) => {
            logger.error(
              { err: cleanupError, slotId: slot.id },
              'failed to roll back redis hold; TTL will release it',
            );
          });
          throw error;
        }
      },
      { resource: 'slot' },
    );
  }

  /** Voluntarily give up a hold, returning the slot to sale immediately. */
  async release(holdId: string, patientId: string, context: SessionContext): Promise<void> {
    const hold = await reservationHoldRepository.findById(holdId);
    if (!hold) throw new NotFoundError('Reservation hold');

    if (hold.patientId !== patientId) {
      throw new ForbiddenError('This hold belongs to another patient');
    }
    if (hold.status !== HoldStatus.ACTIVE) {
      throw new ConflictError(`This hold is already ${hold.status.toLowerCase()}`);
    }

    await lockService.withLock(
      redisKeys.slotLock(hold.slotId),
      async () => {
        await prisma.$transaction(async (tx) => {
          const released = await reservationHoldRepository.release(holdId, tx);
          if (!released) {
            throw new ConflictError('This hold was already resolved');
          }

          // Only a slot still HELD returns to sale — if it is BOOKED, the hold
          // was already converted; if BLOCKED, the doctor withdrew it.
          const slot = await slotRepository.findById(hold.slotId, tx);
          if (slot?.status === SlotStatus.HELD) {
            await slotRepository.release(hold.slotId, tx);
          }

          await auditLogRepository.record(
            {
              actorId: context.userId ?? null,
              actorRole: Role.PATIENT,
              action: AuditAction.HOLD_RELEASED,
              entityType: 'ReservationHold',
              entityId: holdId,
              metadata: { slotId: hold.slotId },
              requestId: context.requestId ?? null,
            },
            tx,
          );

          await outboxRepository.enqueue(
            {
              aggregateType: AggregateType.HOLD,
              aggregateId: holdId,
              eventType: EventType.HOLD_RELEASED,
              payload: {
                holdId,
                slotId: hold.slotId,
                patientId: hold.patientId,
                doctorId: slot?.doctorId ?? '',
                expiresAt: hold.expiresAt.toISOString(),
              },
            },
            tx,
          );
        });

        await this.discardRedisHold(hold.slotId);
      },
      { resource: 'slot' },
    );

    reservationHoldsTotal.inc({ event: 'released' });
  }

  /**
   * Expire a lapsed hold and return its slot to sale.
   *
   * Idempotent and guard-checked, because it is invoked from two independent
   * places (the delayed job and the sweeper) that may both fire for the same
   * hold. Returns whether this call was the one that did the work.
   */
  async expire(holdId: string): Promise<boolean> {
    const hold = await reservationHoldRepository.findById(holdId);
    if (!hold || hold.status !== HoldStatus.ACTIVE) return false;

    // A hold renewed since this job was scheduled must not be cut short.
    const now = new Date();
    if (hold.expiresAt > now) return false;

    return lockService.withLock(
      redisKeys.slotLock(hold.slotId),
      async () => {
        const released = await prisma.$transaction(async (tx) => {
          const expired = await reservationHoldRepository.expire(holdId, tx);
          if (!expired) return false;

          // `expireHold` re-checks `heldUntil <= now` in SQL, closing the gap
          // between this read and the write.
          const slotReleased = await slotRepository.expireHold(hold.slotId, now, tx);

          await auditLogRepository.record(
            {
              actorRole: null,
              action: AuditAction.HOLD_EXPIRED,
              entityType: 'ReservationHold',
              entityId: holdId,
              metadata: { slotId: hold.slotId, slotReleased },
            },
            tx,
          );

          const slot = await slotRepository.findById(hold.slotId, tx);

          await outboxRepository.enqueue(
            {
              aggregateType: AggregateType.HOLD,
              aggregateId: holdId,
              eventType: EventType.HOLD_EXPIRED,
              payload: {
                holdId,
                slotId: hold.slotId,
                patientId: hold.patientId,
                doctorId: slot?.doctorId ?? '',
                expiresAt: hold.expiresAt.toISOString(),
              },
            },
            tx,
          );

          // A slot back on sale is news the waitlist wants.
          if (slotReleased && slot) {
            await outboxRepository.enqueue(
              {
                aggregateType: AggregateType.SLOT,
                aggregateId: slot.id,
                eventType: EventType.SLOT_RELEASED,
                payload: {
                  slotId: slot.id,
                  doctorId: slot.doctorId,
                  startsAt: slot.startsAt.toISOString(),
                  endsAt: slot.endsAt.toISOString(),
                  appointmentType: slot.appointmentType,
                  releasedBy: 'hold_expiry',
                },
              },
              tx,
            );
          }

          return slotReleased;
        });

        await this.discardRedisHold(hold.slotId);
        reservationHoldsTotal.inc({ event: 'expired' });

        return released;
      },
      { resource: 'slot' },
    );
  }

  async findActiveForPatient(patientId: string): Promise<HoldView[]> {
    const holds = await reservationHoldRepository.findActiveForPatient(patientId);
    const now = Date.now();

    return holds
      .filter((hold) => hold.expiresAt.getTime() > now)
      .map((hold) => this.toView(hold, Math.ceil((hold.expiresAt.getTime() - now) / 1000)));
  }

  /**
   * Remove the Redis hold key. Called after the database becomes the source of
   * truth for the slot (booked, released, expired). Best-effort: the TTL is
   * the backstop.
   */
  async discardRedisHold(slotId: string): Promise<void> {
    try {
      await redis.del(redisKeys.hold(slotId));
    } catch (error) {
      logger.warn({ err: error, slotId }, 'failed to delete redis hold key; TTL will clear it');
    }
  }

  private toView(hold: ReservationHold, ttlSeconds: number): HoldView {
    return {
      id: hold.id,
      slotId: hold.slotId,
      patientId: hold.patientId,
      expiresAt: hold.expiresAt,
      ttlSeconds: Math.max(0, ttlSeconds),
      status: hold.status,
    };
  }
}

export const holdService = new HoldService();

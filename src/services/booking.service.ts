import {
  BookingStatus,
  CancelledBy,
  Role,
  SlotStatus,
  type Booking,
  type Slot,
} from '@prisma/client';
import { prisma, type TransactionClient } from '../config/prisma';
import { env } from '../config/env';
import { redisKeys } from '../config/redis';
import { bookingAttemptsTotal, bookingDuration, bookingRaceLossesTotal } from '../config/metrics';
import { logger } from '../utils/logger';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SlotUnavailableError,
} from '../utils/errors';
import { generateConfirmationCode } from '../utils/crypto';
import { isSlotContentionError, translatePrismaError } from '../utils/prisma-errors';
import { slotRepository } from '../repositories/slot.repository';
import { bookingRepository, type BookingWithRelations } from '../repositories/booking.repository';
import { reservationHoldRepository } from '../repositories/reservation-hold.repository';
import { outboxRepository } from '../repositories/outbox.repository';
import { AuditAction, auditLogRepository } from '../repositories/audit-log.repository';
import { AggregateType, EventType } from '../events/domain-events';
import { lockService } from './lock.service';
import { holdService } from './hold.service';
import type { SessionContext } from './auth.service';
import type { PaginatedResult, PaginationParams } from '../types';
import { paginate } from '../utils/http';

/**
 * Booking — the concurrency-critical path.
 *
 * ================================================================
 * CONCURRENCY STRATEGY
 * ================================================================
 *
 * Three independent mechanisms, in order of how far they sit from the data.
 * Each one alone would be insufficient or slow; together they are both correct
 * and fast. The ordering matters: cheap filters first, authoritative last.
 *
 * ---- Layer 1: Redis distributed lock (throughput, not correctness) ----
 *
 * Contenders for one slot serialise in Redis before opening a database
 * transaction. Without it, 100 simultaneous bookers would each open a
 * transaction and queue on the same Postgres row lock, holding 100 pooled
 * connections while they waited — the pool would exhaust and unrelated
 * requests would fail.
 *
 * This layer is explicitly NOT trusted for correctness. Lease-based locks
 * cannot be made safe against process pauses, and pretending otherwise is how
 * systems double-book. If Redis were removed entirely, the guarantee below
 * would still hold.
 *
 * ---- Layer 2: Pessimistic row lock — SELECT ... FOR UPDATE ----
 *
 * Inside the transaction the slot row is locked with `FOR UPDATE`, then its
 * status is re-read. Any transaction that already booked this slot has either
 * committed (so we observe BOOKED and stop) or is still open (so we block
 * until it finishes). This closes the check-then-act window that makes the
 * naive `if (slot.isAvailable) { book() }` wrong.
 *
 * ### Why pessimistic rather than optimistic locking?
 *
 * Optimistic locking (read version, write `WHERE version = ?`, retry on
 * mismatch) is the better choice when contention is *rare*: it avoids holding
 * locks and never blocks a reader.
 *
 * Slot booking is the opposite case. Contention is concentrated by design —
 * a popular doctor's 10:00 Monday slot is exactly what everyone wants at
 * exactly the same moment. Under that load, optimistic locking degrades badly:
 * every loser burns a full transaction before discovering it lost, and retries
 * amplify the load that caused the conflict. Worse, the correct outcome here
 * is *not* a retry — a booked slot stays booked, so retrying is guaranteed
 * waste.
 *
 * Pessimistic locking makes the loser wait for a bounded, short interval and
 * then learn the truth in one read. The critical section is ~1ms of index
 * lookups and two inserts, so the queue drains fast.
 *
 * Optimistic locking is still used where it fits: `Availability.version`
 * guards concurrent edits by clinic staff, which are rare and where a stale
 * write should be rejected rather than serialised. Slots also carry a
 * `version` column, bumped on every transition, for readers that need to
 * detect staleness without taking a lock.
 *
 * ---- Layer 3: The database constraint (the actual guarantee) ----
 *
 *     CREATE UNIQUE INDEX bookings_one_confirmed_per_slot
 *       ON bookings (slotId) WHERE status = 'CONFIRMED';
 *
 * This is what makes double-booking *impossible* rather than merely unlikely.
 * It holds regardless of application bugs, replica count, Redis availability,
 * or someone connecting with psql. A losing insert raises SQLSTATE 23505,
 * which surfaces as 409 Conflict.
 *
 * Layers 1 and 2 exist so that layer 3 is almost never the thing that fires.
 * When it does fire, that is the system working — `clinzo_booking_race_losses_total`
 * tracks it precisely because a non-zero-but-low rate is the healthy signal.
 */

export interface CreateBookingInput {
  slotId: string;
  patientId: string;
  reasonForVisit?: string;
  /** Consume a specific reservation hold instead of booking directly. */
  holdId?: string;
}

export interface CancelBookingInput {
  bookingId: string;
  cancelledBy: CancelledBy;
  /** The acting user's role, used to authorise the cancellation. */
  actorRole: Role;
  /** Patient profile id, when a patient is cancelling their own booking. */
  actorPatientId?: string | null;
  /** Doctor profile id, when a doctor is cancelling. */
  actorDoctorId?: string | null;
  reason?: string;
}

export interface RescheduleBookingInput {
  bookingId: string;
  targetSlotId: string;
  patientId: string;
  reason?: string;
}

export class BookingService {
  /**
   * Book a slot.
   *
   * The whole critical section is deliberately small: acquire lock, open
   * transaction, lock row, verify, insert, commit, release. Nothing slow —
   * no email, no payment call, no cache write — happens inside it. Side
   * effects go to the outbox and run afterwards.
   */
  async create(input: CreateBookingInput, context: SessionContext): Promise<BookingWithRelations> {
    const stopTimer = bookingDuration.startTimer();

    try {
      const booking = await lockService.withLock(
        redisKeys.slotLock(input.slotId),
        () => this.bookWithinTransaction(input, context),
        { resource: 'slot' },
      );

      bookingAttemptsTotal.inc({ result: 'confirmed' });
      return booking;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      stopTimer();
    }
  }

  private async bookWithinTransaction(
    input: CreateBookingInput,
    context: SessionContext,
  ): Promise<BookingWithRelations> {
    const confirmationCode = generateConfirmationCode();

    const bookingId = await prisma.$transaction(
      async (tx) => {
        // --- Layer 2: pessimistic row lock -------------------------------
        const slot = await slotRepository.lockForUpdate(input.slotId, tx);
        if (!slot) throw new NotFoundError('Slot');

        await this.assertSlotIsBookable(slot, input, tx);
        await this.assertPatientIsFree(slot, input.patientId, undefined, tx);

        // Consume the hold, if this booking is completing a checkout.
        if (input.holdId) {
          const consumed = await reservationHoldRepository.consume(input.holdId, new Date(), tx);
          if (!consumed) {
            throw new ConflictError('This reservation hold has expired or was already used', {
              holdId: input.holdId,
            });
          }
        }

        // --- Layer 3: the database constraint fires here if we lost ------
        const booking = await bookingRepository.create(
          {
            slotId: slot.id,
            patientId: input.patientId,
            doctorId: slot.doctorId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            mode: slot.mode,
            appointmentType: slot.appointmentType,
            reasonForVisit: input.reasonForVisit ?? null,
            confirmationCode,
          },
          tx,
        );

        // Guarded transition: HELD is accepted only when we just consumed the
        // hold that put it there.
        const claimed = await slotRepository.claimIfAvailable(
          slot.id,
          SlotStatus.BOOKED,
          input.holdId ? [SlotStatus.AVAILABLE, SlotStatus.HELD] : [SlotStatus.AVAILABLE],
          tx,
        );

        if (!claimed) {
          // Unreachable given the row lock above, but a silent inconsistency
          // here would be a double booking — so it aborts loudly instead.
          throw new SlotUnavailableError('Slot state changed during booking', { slotId: slot.id });
        }

        await auditLogRepository.record(
          {
            actorId: context.userId ?? null,
            actorRole: Role.PATIENT,
            action: AuditAction.BOOKING_CREATED,
            entityType: 'Booking',
            entityId: booking.id,
            metadata: {
              slotId: slot.id,
              doctorId: slot.doctorId,
              patientId: input.patientId,
              startsAt: slot.startsAt.toISOString(),
              viaHold: Boolean(input.holdId),
            },
            requestId: context.requestId ?? null,
            ipAddress: context.ipAddress ?? null,
          },
          tx,
        );

        // Written in the same transaction as the booking: either both commit
        // or neither does, so a confirmation can never describe a booking
        // that does not exist.
        await outboxRepository.enqueue(
          {
            aggregateType: AggregateType.BOOKING,
            aggregateId: booking.id,
            eventType: EventType.BOOKING_CREATED,
            payload: {
              bookingId: booking.id,
              slotId: slot.id,
              patientId: input.patientId,
              doctorId: slot.doctorId,
              confirmationCode: booking.confirmationCode,
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
              appointmentType: slot.appointmentType,
              mode: slot.mode,
            },
          },
          tx,
        );

        return booking.id;
      },
      {
        // Bounded so a wedged transaction cannot hold the row lock and stall
        // every other contender for this slot.
        timeout: 10_000,
        maxWait: 5_000,
      },
    );

    // Release the Redis hold key outside the transaction: it is a cache of
    // state the database now owns definitively.
    if (input.holdId) {
      await holdService.discardRedisHold(input.slotId);
    }

    const booking = await bookingRepository.findById(bookingId);
    if (!booking) throw new NotFoundError('Booking');
    return booking;
  }

  /**
   * Cancel a booking and return the slot to sale.
   *
   * Releasing the slot is conditional: a slot BLOCKED by an availability
   * change stays blocked, because the doctor is no longer offering that time.
   * Blindly setting AVAILABLE would resell a slot the doctor withdrew.
   */
  async cancel(input: CancelBookingInput, context: SessionContext): Promise<BookingWithRelations> {
    const existing = await bookingRepository.findById(input.bookingId);
    if (!existing) throw new NotFoundError('Booking');

    this.assertMayCancel(existing, input);

    if (existing.status !== BookingStatus.CONFIRMED) {
      throw new ConflictError(`This booking is already ${existing.status.toLowerCase()}`, {
        status: existing.status,
      });
    }

    await lockService.withLock(
      redisKeys.slotLock(existing.slotId),
      async () => {
        await prisma.$transaction(async (tx) => {
          const cancelled = await bookingRepository.cancel(
            input.bookingId,
            input.cancelledBy,
            input.reason ?? null,
            tx,
          );

          if (!cancelled) {
            throw new ConflictError('This booking was already cancelled or rescheduled');
          }

          const slot = await slotRepository.lockForUpdate(existing.slotId, tx);

          // Only a slot still marked BOOKED returns to sale. A BLOCKED slot
          // was withdrawn by the doctor and must stay withdrawn.
          const released =
            slot?.status === SlotStatus.BOOKED
              ? await slotRepository.release(existing.slotId, tx)
              : false;

          await auditLogRepository.record(
            {
              actorId: context.userId ?? null,
              actorRole: input.actorRole,
              action: AuditAction.BOOKING_CANCELLED,
              entityType: 'Booking',
              entityId: input.bookingId,
              metadata: {
                slotId: existing.slotId,
                cancelledBy: input.cancelledBy,
                reason: input.reason ?? null,
                slotReleased: released,
              },
              requestId: context.requestId ?? null,
            },
            tx,
          );

          await outboxRepository.enqueue(
            {
              aggregateType: AggregateType.BOOKING,
              aggregateId: input.bookingId,
              eventType: EventType.BOOKING_CANCELLED,
              payload: {
                bookingId: input.bookingId,
                slotId: existing.slotId,
                patientId: existing.patientId,
                doctorId: existing.doctorId,
                startsAt: existing.startsAt.toISOString(),
                cancelledBy: input.cancelledBy,
                reason: input.reason ?? null,
                slotReleased: released,
              },
            },
            tx,
          );

          // A freed slot is what the waitlist is waiting for. Published only
          // when the slot genuinely returned to sale.
          if (released) {
            await outboxRepository.enqueue(
              {
                aggregateType: AggregateType.SLOT,
                aggregateId: existing.slotId,
                eventType: EventType.SLOT_RELEASED,
                payload: {
                  slotId: existing.slotId,
                  doctorId: existing.doctorId,
                  startsAt: existing.startsAt.toISOString(),
                  endsAt: existing.endsAt.toISOString(),
                  appointmentType: existing.appointmentType,
                  releasedBy: 'cancellation',
                },
              },
              tx,
            );
          }
        });
      },
      { resource: 'slot' },
    );

    const updated = await bookingRepository.findById(input.bookingId);
    if (!updated) throw new NotFoundError('Booking');
    return updated;
  }

  /**
   * Move a booking to a different slot.
   *
   * The two slots are locked in a deterministic order (by id) before the
   * transaction opens. Two patients swapping each other's slots simultaneously
   * would otherwise acquire the same pair in opposite orders and deadlock;
   * a consistent global ordering makes that impossible.
   *
   * The original booking is only released after the new one is confirmed, so a
   * failure at any point leaves the patient holding their original
   * appointment rather than nothing.
   */
  async reschedule(
    input: RescheduleBookingInput,
    context: SessionContext,
  ): Promise<BookingWithRelations> {
    const existing = await bookingRepository.findById(input.bookingId);
    if (!existing) throw new NotFoundError('Booking');

    if (existing.patientId !== input.patientId) {
      throw new ForbiddenError('This booking belongs to another patient');
    }
    if (existing.status !== BookingStatus.CONFIRMED) {
      throw new ConflictError(`Only a confirmed booking can be rescheduled`, {
        status: existing.status,
      });
    }
    if (existing.slotId === input.targetSlotId) {
      throw new BusinessRuleError('The booking is already on this slot');
    }
    if (existing.startsAt <= new Date()) {
      throw new BusinessRuleError('A past appointment cannot be rescheduled');
    }

    const [firstLock, secondLock] = [existing.slotId, input.targetSlotId].sort();

    const newBookingId = await lockService.withLock(
      redisKeys.slotLock(firstLock as string),
      () =>
        lockService.withLock(
          redisKeys.slotLock(secondLock as string),
          () => this.rescheduleWithinTransaction(existing, input, context),
          { resource: 'slot' },
        ),
      { resource: 'slot' },
    );

    const booking = await bookingRepository.findById(newBookingId);
    if (!booking) throw new NotFoundError('Booking');
    return booking;
  }

  private async rescheduleWithinTransaction(
    existing: BookingWithRelations,
    input: RescheduleBookingInput,
    context: SessionContext,
  ): Promise<string> {
    const confirmationCode = generateConfirmationCode();

    return prisma.$transaction(
      async (tx) => {
        const targetSlot = await slotRepository.lockForUpdate(input.targetSlotId, tx);
        if (!targetSlot) throw new NotFoundError('Target slot');

        if (targetSlot.doctorId !== existing.doctorId) {
          throw new BusinessRuleError(
            'A booking can only be moved to another slot with the same doctor; book a new appointment instead',
            { currentDoctorId: existing.doctorId, targetDoctorId: targetSlot.doctorId },
          );
        }

        await this.assertSlotIsBookable(targetSlot, { patientId: input.patientId }, tx);
        // The booking being moved is excluded from the overlap check — it is
        // about to be vacated.
        await this.assertPatientIsFree(targetSlot, input.patientId, existing.id, tx);

        // Retire the old booking first so its row leaves the partial unique
        // index, freeing the original slot for anyone waiting on it.
        const retired = await bookingRepository.markRescheduled(existing.id, tx);
        if (!retired) {
          throw new ConflictError('This booking changed while being rescheduled');
        }

        const created = await bookingRepository.create(
          {
            slotId: targetSlot.id,
            patientId: input.patientId,
            doctorId: targetSlot.doctorId,
            startsAt: targetSlot.startsAt,
            endsAt: targetSlot.endsAt,
            mode: targetSlot.mode,
            appointmentType: targetSlot.appointmentType,
            reasonForVisit: existing.reasonForVisit,
            confirmationCode,
            rescheduledFromId: existing.id,
          },
          tx,
        );

        const claimed = await slotRepository.claimIfAvailable(
          targetSlot.id,
          SlotStatus.BOOKED,
          [SlotStatus.AVAILABLE],
          tx,
        );
        if (!claimed) {
          throw new SlotUnavailableError('The target slot was taken during rescheduling', {
            slotId: targetSlot.id,
          });
        }

        // Return the vacated slot to sale, unless the doctor had withdrawn it.
        const originalSlot = await slotRepository.lockForUpdate(existing.slotId, tx);
        const originalReleased =
          originalSlot?.status === SlotStatus.BOOKED
            ? await slotRepository.release(existing.slotId, tx)
            : false;

        await auditLogRepository.record(
          {
            actorId: context.userId ?? null,
            actorRole: Role.PATIENT,
            action: AuditAction.BOOKING_RESCHEDULED,
            entityType: 'Booking',
            entityId: created.id,
            metadata: {
              previousBookingId: existing.id,
              previousSlotId: existing.slotId,
              slotId: targetSlot.id,
              originalSlotReleased: originalReleased,
              reason: input.reason ?? null,
            },
            requestId: context.requestId ?? null,
          },
          tx,
        );

        await outboxRepository.enqueue(
          {
            aggregateType: AggregateType.BOOKING,
            aggregateId: created.id,
            eventType: EventType.BOOKING_RESCHEDULED,
            payload: {
              previousBookingId: existing.id,
              bookingId: created.id,
              previousSlotId: existing.slotId,
              slotId: targetSlot.id,
              patientId: input.patientId,
              doctorId: targetSlot.doctorId,
              previousStartsAt: existing.startsAt.toISOString(),
              startsAt: targetSlot.startsAt.toISOString(),
            },
          },
          tx,
        );

        if (originalReleased) {
          await outboxRepository.enqueue(
            {
              aggregateType: AggregateType.SLOT,
              aggregateId: existing.slotId,
              eventType: EventType.SLOT_RELEASED,
              payload: {
                slotId: existing.slotId,
                doctorId: existing.doctorId,
                startsAt: existing.startsAt.toISOString(),
                endsAt: existing.endsAt.toISOString(),
                appointmentType: existing.appointmentType,
                releasedBy: 'cancellation',
              },
            },
            tx,
          );
        }

        return created.id;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }

  async listForPatient(
    patientId: string,
    filters: { window?: 'upcoming' | 'past' | 'all'; status?: BookingStatus[] },
    pagination: PaginationParams,
  ): Promise<PaginatedResult<BookingWithRelations>> {
    const { rows, total } = await bookingRepository.list(
      { patientId, window: filters.window ?? 'upcoming', status: filters.status },
      pagination,
    );
    return paginate(rows, total, pagination);
  }

  async listForDoctor(
    doctorId: string,
    filters: { window?: 'upcoming' | 'past' | 'all'; status?: BookingStatus[] },
    pagination: PaginationParams,
  ): Promise<PaginatedResult<BookingWithRelations>> {
    const { rows, total } = await bookingRepository.list(
      { doctorId, window: filters.window ?? 'upcoming', status: filters.status },
      pagination,
    );
    return paginate(rows, total, pagination);
  }

  /** Fetch one booking, enforcing that the caller is a party to it. */
  async getById(
    bookingId: string,
    actor: { role: Role; profileId: string | null },
  ): Promise<BookingWithRelations> {
    const booking = await bookingRepository.findById(bookingId);
    if (!booking) throw new NotFoundError('Booking');

    const isOwner =
      (actor.role === Role.PATIENT && booking.patientId === actor.profileId) ||
      (actor.role === Role.DOCTOR && booking.doctorId === actor.profileId);

    if (!isOwner && actor.role !== Role.ADMIN) {
      // 404 rather than 403: confirming that a booking id exists would leak
      // information to anyone enumerating ids.
      throw new NotFoundError('Booking');
    }

    return booking;
  }

  /** Domain preconditions for booking a slot. Runs while the row is locked. */
  private async assertSlotIsBookable(
    slot: Slot,
    input: { patientId: string; holdId?: string },
    tx: TransactionClient,
  ): Promise<void> {
    if (slot.status === SlotStatus.BOOKED) {
      throw new SlotUnavailableError('This slot has already been booked', { slotId: slot.id });
    }
    if (slot.status === SlotStatus.BLOCKED) {
      throw new SlotUnavailableError('This slot is no longer offered by the doctor', {
        slotId: slot.id,
      });
    }

    if (slot.status === SlotStatus.HELD) {
      // A held slot is bookable only by the patient who holds it.
      const hold = await reservationHoldRepository.findActiveForSlot(slot.id, tx);

      const heldByThisPatient =
        hold && hold.patientId === input.patientId && hold.expiresAt > new Date();

      if (!heldByThisPatient) {
        throw new SlotUnavailableError('This slot is currently reserved by another patient', {
          slotId: slot.id,
        });
      }
      if (input.holdId && hold.id !== input.holdId) {
        throw new ConflictError('The supplied hold does not match the hold on this slot');
      }
    }

    const now = new Date();
    if (slot.startsAt <= now) {
      throw new BusinessRuleError('This slot has already started', {
        slotId: slot.id,
        startsAt: slot.startsAt.toISOString(),
      });
    }

    // Optional minimum lead time, e.g. "no bookings within 30 minutes".
    if (env.MIN_BOOKING_LEAD_MINUTES > 0) {
      const leadMs = env.MIN_BOOKING_LEAD_MINUTES * 60_000;
      if (slot.startsAt.getTime() - now.getTime() < leadMs) {
        throw new BusinessRuleError(
          `Appointments must be booked at least ${env.MIN_BOOKING_LEAD_MINUTES} minutes in advance`,
          { slotId: slot.id, minimumLeadMinutes: env.MIN_BOOKING_LEAD_MINUTES },
        );
      }
    }
  }

  /**
   * A patient cannot hold two overlapping appointments. Not expressible as a
   * database constraint (it spans rows), so it is checked inside the same
   * transaction and under the same row lock as the write.
   */
  private async assertPatientIsFree(
    slot: Slot,
    patientId: string,
    excludeBookingId: string | undefined,
    tx: TransactionClient,
  ): Promise<void> {
    const clash = await bookingRepository.hasOverlappingBooking(
      patientId,
      slot.startsAt,
      slot.endsAt,
      excludeBookingId,
      tx,
    );

    if (clash) {
      throw new ConflictError('You already have an appointment during this time', {
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
      });
    }
  }

  private assertMayCancel(booking: Booking, input: CancelBookingInput): void {
    if (input.actorRole === Role.ADMIN) return;

    if (input.actorRole === Role.PATIENT && booking.patientId === input.actorPatientId) return;
    if (input.actorRole === Role.DOCTOR && booking.doctorId === input.actorDoctorId) return;

    throw new ForbiddenError('You may not cancel this booking');
  }

  /** Classify a booking failure for metrics and logging. */
  private recordFailure(error: unknown): void {
    if (isSlotContentionError(error)) {
      // The database constraint fired — a genuine lost race. Expected under
      // load; the counter is what proves the last line of defence is live.
      bookingAttemptsTotal.inc({ result: 'conflict' });
      bookingRaceLossesTotal.inc({ stage: 'database_constraint' });

      logger.info(
        { err: error },
        'booking rejected by database constraint under contention (working as designed)',
      );
      return;
    }

    if (error instanceof SlotUnavailableError || error instanceof ConflictError) {
      bookingAttemptsTotal.inc({ result: 'conflict' });
      bookingRaceLossesTotal.inc({ stage: 'application_check' });
      return;
    }

    bookingAttemptsTotal.inc({ result: 'rejected' });
  }
}

/**
 * Convert a raw database contention error into the API's 409 before it reaches
 * the generic handler, so callers always see `SLOT_UNAVAILABLE` rather than a
 * bare CONFLICT for this specific case.
 */
export function asSlotConflict(error: unknown): unknown {
  if (isSlotContentionError(error)) {
    return translatePrismaError(error) ?? error;
  }
  return error;
}

export const bookingService = new BookingService();

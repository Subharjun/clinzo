import {
  AvailabilityKind,
  Role,
  SlotStatus,
  type AppointmentMode,
  type Availability,
  type Slot,
} from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { redis, redisKeys } from '../config/redis';
import { slotsGeneratedTotal } from '../config/metrics';
import { logger } from '../utils/logger';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { assertValidTimezone, eachLocalDate, toZonedDate } from '../utils/time';
import { availabilityRepository } from '../repositories/availability.repository';
import { slotRepository } from '../repositories/slot.repository';
import { bookingRepository } from '../repositories/booking.repository';
import { outboxRepository } from '../repositories/outbox.repository';
import { AuditAction, auditLogRepository } from '../repositories/audit-log.repository';
import { AggregateType, EventType } from '../events/domain-events';
import { lockService } from './lock.service';
import {
  countSlotsForWindow,
  generateSlotsForAvailability,
  windowCoversInstant,
  type RecurringWindowSpec,
} from './slot-generator';
import type { SessionContext } from './auth.service';

/**
 * Availability management and slot materialisation.
 *
 * ## Materialised vs. computed slots
 *
 * Slots are stored, not derived on read. The alternative — computing free
 * slots from availability minus bookings at query time — is attractive because
 * nothing needs regenerating when a window changes. It was rejected because:
 *
 *  - A slot must be a **lockable row**. `SELECT … FOR UPDATE` and a unique
 *    index need something to point at. A computed slot has no identity, so the
 *    only place to enforce "one booking per slot" would be application code,
 *    which is exactly what breaks under concurrency.
 *  - Listing free slots becomes an index scan over one partial index rather
 *    than an expansion-and-subtraction per request.
 *  - Per-slot state (HELD, BLOCKED, a blocking reason) has somewhere to live.
 *
 * The cost is that generation must be driven explicitly and kept idempotent,
 * and that the table grows with horizon x doctors. Both are handled: writes go
 * through `ON CONFLICT DO NOTHING`, and generation is bounded by
 * `SLOT_GENERATION_HORIZON_DAYS`.
 */

export interface CreateAvailabilityRequest {
  kind: AvailabilityKind;
  date?: string | null;
  weekday?: number | null;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  timezone?: string;
  slotDurationMinutes?: number;
  bufferMinutes?: number;
  mode?: AppointmentMode;
  appointmentType?: string;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  /** Days ahead to materialise now. Defaults to the configured horizon. */
  horizonDays?: number;
}

export interface UpdateAvailabilityRequest {
  startMinuteOfDay?: number;
  endMinuteOfDay?: number;
  slotDurationMinutes?: number;
  bufferMinutes?: number;
  mode?: AppointmentMode;
  appointmentType?: string;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  isActive?: boolean;
  /** Optimistic-locking guard read from the previous GET. */
  version: number;
}

export interface AvailabilityChangeResult {
  availability: Availability;
  slotsGenerated: number;
  slotsBlocked: number;
  /**
   * Confirmed bookings that now sit outside the doctor's declared window.
   * Never cancelled automatically — surfaced for human resolution.
   */
  orphanedBookings: Array<{ bookingId: string; slotId: string; startsAt: Date }>;
  skippedForDstGap: string[];
}

export class AvailabilityService {
  async create(
    doctorId: string,
    request: CreateAvailabilityRequest,
    context: SessionContext,
  ): Promise<AvailabilityChangeResult> {
    const doctor = await prisma.doctor.findFirst({ where: { id: doctorId, deletedAt: null } });
    if (!doctor) throw new NotFoundError('Doctor');

    const timezone = request.timezone ?? doctor.timezone;
    assertValidTimezone(timezone);

    const slotDurationMinutes =
      request.slotDurationMinutes ??
      doctor.defaultSlotDurationMinutes ??
      env.DEFAULT_SLOT_DURATION_MINUTES;
    const bufferMinutes =
      request.bufferMinutes ?? doctor.defaultBufferMinutes ?? env.DEFAULT_BUFFER_MINUTES;

    this.assertShapeMatchesKind(request);

    // Reject an absurd request before allocating anything. A one-minute
    // duration over a ten-year recurrence would otherwise attempt millions of
    // rows and take the database with it.
    this.assertGenerationSizeIsSane({
      startMinuteOfDay: request.startMinuteOfDay,
      endMinuteOfDay: request.endMinuteOfDay,
      slotDurationMinutes,
      bufferMinutes,
      horizonDays: request.horizonDays ?? env.SLOT_GENERATION_HORIZON_DAYS,
      timezone,
    });

    const overlapping = await availabilityRepository.findOverlapping(doctorId, {
      kind: request.kind,
      date: request.date ? new Date(`${request.date}T00:00:00.000Z`) : null,
      weekday: request.weekday ?? null,
      startMinuteOfDay: request.startMinuteOfDay,
      endMinuteOfDay: request.endMinuteOfDay,
    });

    if (overlapping.length > 0) {
      throw new ConflictError('This window overlaps an existing availability', {
        conflictingAvailabilityIds: overlapping.map((entry) => entry.id),
      });
    }

    const availability = await availabilityRepository.create({
      doctorId,
      kind: request.kind,
      date: request.date ? new Date(`${request.date}T00:00:00.000Z`) : null,
      weekday: request.weekday ?? null,
      startMinuteOfDay: request.startMinuteOfDay,
      endMinuteOfDay: request.endMinuteOfDay,
      timezone,
      slotDurationMinutes,
      bufferMinutes,
      mode: request.mode ?? 'VIDEO',
      appointmentType: request.appointmentType ?? 'STANDARD',
      effectiveFrom: request.effectiveFrom
        ? new Date(`${request.effectiveFrom}T00:00:00.000Z`)
        : null,
      effectiveUntil: request.effectiveUntil
        ? new Date(`${request.effectiveUntil}T00:00:00.000Z`)
        : null,
    });

    const generation = await this.materialise(
      availability,
      request.horizonDays ?? env.SLOT_GENERATION_HORIZON_DAYS,
    );

    await prisma.$transaction(async (tx) => {
      await auditLogRepository.record(
        {
          actorId: context.userId ?? null,
          actorRole: Role.DOCTOR,
          action: AuditAction.AVAILABILITY_CREATED,
          entityType: 'Availability',
          entityId: availability.id,
          metadata: {
            doctorId,
            kind: request.kind,
            startMinuteOfDay: request.startMinuteOfDay,
            endMinuteOfDay: request.endMinuteOfDay,
            timezone,
            slotsGenerated: generation.generated,
          },
          requestId: context.requestId ?? null,
        },
        tx,
      );

      await outboxRepository.enqueue(
        {
          aggregateType: AggregateType.AVAILABILITY,
          aggregateId: availability.id,
          eventType: EventType.AVAILABILITY_CHANGED,
          payload: {
            availabilityId: availability.id,
            doctorId,
            changeType: 'created',
            slotsGenerated: generation.generated,
            slotsBlocked: 0,
            orphanedBookingIds: [],
          },
        },
        tx,
      );
    });

    await this.invalidateSlotCache(doctorId);

    return {
      availability,
      slotsGenerated: generation.generated,
      slotsBlocked: 0,
      orphanedBookings: [],
      skippedForDstGap: generation.skippedForDstGap,
    };
  }

  /**
   * Edit an availability window.
   *
   * ## The retroactive-change policy
   *
   * A doctor shrinking Monday from 10:00–18:00 to 10:00–14:00 has already sold
   * a 15:00 appointment. Three options exist, and the choice is a product
   * decision as much as a technical one:
   *
   *   (a) Cancel the affected bookings automatically.
   *   (b) Refuse the edit while bookings exist inside the removed region.
   *   (c) Apply the edit to unbooked capacity only, keep the bookings, and
   *       report them for human resolution.
   *
   * This system implements **(c)**. The reasoning: a booked consultation is a
   * commitment between two people, and a UI interaction must not silently
   * break it — but neither should one appointment freeze a doctor's entire
   * schedule. So:
   *
   *   - Future *unbooked* slots outside the new window become BLOCKED.
   *   - Future *booked* slots are left untouched and returned as
   *     `orphanedBookings`, so the doctor is told exactly what to reschedule.
   *   - Past slots are never modified at all — history is immutable.
   *
   * The trade-off is a transient inconsistency: the doctor's stated
   * availability and their actual calendar disagree until the orphans are
   * resolved. That is visible, bounded and actionable, which is strictly
   * better than either silent cancellation or a hard block.
   */
  async update(
    availabilityId: string,
    doctorId: string,
    request: UpdateAvailabilityRequest,
    context: SessionContext,
  ): Promise<AvailabilityChangeResult> {
    const existing = await availabilityRepository.findById(availabilityId);
    if (!existing) throw new NotFoundError('Availability');
    if (existing.doctorId !== doctorId) {
      throw new ForbiddenError('This availability belongs to another doctor');
    }

    const merged = {
      startMinuteOfDay: request.startMinuteOfDay ?? existing.startMinuteOfDay,
      endMinuteOfDay: request.endMinuteOfDay ?? existing.endMinuteOfDay,
      slotDurationMinutes: request.slotDurationMinutes ?? existing.slotDurationMinutes,
      bufferMinutes: request.bufferMinutes ?? existing.bufferMinutes,
    };

    if (merged.endMinuteOfDay <= merged.startMinuteOfDay) {
      throw new BusinessRuleError('Window end must be after window start', merged);
    }

    // Serialise concurrent edits to the same window so two admins cannot both
    // pass the version check and then both regenerate slots.
    return lockService.withLock(
      redisKeys.availabilityLock(availabilityId),
      async () => {
        const updated = await availabilityRepository.updateWithVersion(
          availabilityId,
          request.version,
          {
            ...merged,
            mode: request.mode,
            appointmentType: request.appointmentType,
            isActive: request.isActive,
            effectiveFrom: request.effectiveFrom
              ? new Date(`${request.effectiveFrom}T00:00:00.000Z`)
              : request.effectiveFrom === null
                ? null
                : undefined,
            effectiveUntil: request.effectiveUntil
              ? new Date(`${request.effectiveUntil}T00:00:00.000Z`)
              : request.effectiveUntil === null
                ? null
                : undefined,
          },
        );

        const reconciliation = await this.reconcileSlots(updated, context);

        await this.invalidateSlotCache(doctorId);
        return reconciliation;
      },
      { resource: 'availability' },
    );
  }

  /** Deactivate a window; existing bookings survive, free future slots do not. */
  async remove(
    availabilityId: string,
    doctorId: string,
    context: SessionContext,
  ): Promise<AvailabilityChangeResult> {
    const existing = await availabilityRepository.findById(availabilityId);
    if (!existing) throw new NotFoundError('Availability');
    if (existing.doctorId !== doctorId) {
      throw new ForbiddenError('This availability belongs to another doctor');
    }

    return lockService.withLock(
      redisKeys.availabilityLock(availabilityId),
      async () => {
        const now = new Date();
        const futureBooked = await prisma.slot.findMany({
          where: {
            availabilityId,
            startsAt: { gt: now },
            status: SlotStatus.BOOKED,
            deletedAt: null,
          },
        });

        const orphaned = await this.describeOrphans(futureBooked);

        const result = await prisma.$transaction(async (tx) => {
          const blocked = await tx.slot.updateMany({
            where: {
              availabilityId,
              startsAt: { gt: now },
              status: { in: [SlotStatus.AVAILABLE, SlotStatus.HELD] },
              deletedAt: null,
            },
            data: {
              status: SlotStatus.BLOCKED,
              blockedReason: 'availability_removed',
              heldUntil: null,
              version: { increment: 1 },
            },
          });

          await availabilityRepository.softDelete(availabilityId, tx);

          await auditLogRepository.record(
            {
              actorId: context.userId ?? null,
              actorRole: Role.DOCTOR,
              action: AuditAction.AVAILABILITY_DELETED,
              entityType: 'Availability',
              entityId: availabilityId,
              metadata: {
                doctorId,
                slotsBlocked: blocked.count,
                orphanedBookingIds: orphaned.map((entry) => entry.bookingId),
              },
              requestId: context.requestId ?? null,
            },
            tx,
          );

          await outboxRepository.enqueue(
            {
              aggregateType: AggregateType.AVAILABILITY,
              aggregateId: availabilityId,
              eventType: EventType.AVAILABILITY_CHANGED,
              payload: {
                availabilityId,
                doctorId,
                changeType: 'deleted',
                slotsGenerated: 0,
                slotsBlocked: blocked.count,
                orphanedBookingIds: orphaned.map((entry) => entry.bookingId),
              },
            },
            tx,
          );

          return blocked.count;
        });

        await this.invalidateSlotCache(doctorId);

        return {
          availability: { ...existing, deletedAt: new Date(), isActive: false },
          slotsGenerated: 0,
          slotsBlocked: result,
          orphanedBookings: orphaned,
          skippedForDstGap: [],
        };
      },
      { resource: 'availability' },
    );
  }

  async listForDoctor(doctorId: string): Promise<Availability[]> {
    return availabilityRepository.findByDoctor(doctorId);
  }

  /**
   * Bring materialised slots back into agreement with an availability
   * definition: block what no longer fits, generate what newly does.
   */
  private async reconcileSlots(
    availability: Availability,
    context: SessionContext,
  ): Promise<AvailabilityChangeResult> {
    const now = new Date();
    const spec = toSpec(availability);

    const futureSlots = await prisma.slot.findMany({
      where: { availabilityId: availability.id, startsAt: { gt: now }, deletedAt: null },
      orderBy: { startsAt: 'asc' },
    });

    // Partition by whether the new window still covers each slot. Duration
    // changes matter as much as boundary changes: a slot generated at 15
    // minutes is no longer valid if the doctor switched to 30.
    const nowOutside = futureSlots.filter(
      (slot) =>
        !windowCoversInstant(spec, slot.startsAt) ||
        slot.durationMinutes !== availability.slotDurationMinutes,
    );

    const toBlock = nowOutside.filter(
      (slot) => slot.status === SlotStatus.AVAILABLE || slot.status === SlotStatus.HELD,
    );
    const stillBooked = nowOutside.filter((slot) => slot.status === SlotStatus.BOOKED);

    const orphanedBookings = await this.describeOrphans(stillBooked);

    const blockedCount = await prisma.$transaction(async (tx) => {
      const blocked = await tx.slot.updateMany({
        where: {
          id: { in: toBlock.map((slot) => slot.id) },
          status: { in: [SlotStatus.AVAILABLE, SlotStatus.HELD] },
        },
        data: {
          status: SlotStatus.BLOCKED,
          blockedReason: 'availability_changed',
          heldUntil: null,
          version: { increment: 1 },
        },
      });

      if (blocked.count > 0) {
        await outboxRepository.enqueue(
          {
            aggregateType: AggregateType.SLOT,
            aggregateId: availability.id,
            eventType: EventType.SLOT_BLOCKED,
            payload: {
              slotIds: toBlock.map((slot) => slot.id),
              doctorId: availability.doctorId,
              availabilityId: availability.id,
              reason: 'availability_changed',
            },
          },
          tx,
        );
      }

      return blocked.count;
    });

    // Generate whatever the widened/retimed window now covers. Idempotent, so
    // slots that survived the change are simply skipped.
    const generation = availability.isActive
      ? await this.materialise(availability, env.SLOT_GENERATION_HORIZON_DAYS)
      : { generated: 0, skippedForDstGap: [] as string[] };

    await prisma.$transaction(async (tx) => {
      await auditLogRepository.record(
        {
          actorId: context.userId ?? null,
          actorRole: Role.DOCTOR,
          action: AuditAction.AVAILABILITY_UPDATED,
          entityType: 'Availability',
          entityId: availability.id,
          metadata: {
            doctorId: availability.doctorId,
            slotsBlocked: blockedCount,
            slotsGenerated: generation.generated,
            orphanedBookingIds: orphanedBookings.map((entry) => entry.bookingId),
          },
          requestId: context.requestId ?? null,
        },
        tx,
      );

      await outboxRepository.enqueue(
        {
          aggregateType: AggregateType.AVAILABILITY,
          aggregateId: availability.id,
          eventType: EventType.AVAILABILITY_CHANGED,
          payload: {
            availabilityId: availability.id,
            doctorId: availability.doctorId,
            changeType: 'updated',
            slotsGenerated: generation.generated,
            slotsBlocked: blockedCount,
            orphanedBookingIds: orphanedBookings.map((entry) => entry.bookingId),
          },
        },
        tx,
      );
    });

    if (orphanedBookings.length > 0) {
      logger.warn(
        {
          availabilityId: availability.id,
          doctorId: availability.doctorId,
          orphanedBookings: orphanedBookings.length,
        },
        'availability change left confirmed bookings outside the declared window',
      );
    }

    return {
      availability,
      slotsGenerated: generation.generated,
      slotsBlocked: blockedCount,
      orphanedBookings,
      skippedForDstGap: generation.skippedForDstGap,
    };
  }

  /**
   * Materialise slots for an availability across the horizon.
   * Safe to call repeatedly: duplicates are dropped by the unique index.
   */
  async materialise(
    availability: Availability,
    horizonDays: number,
  ): Promise<{ generated: number; skippedForDstGap: string[] }> {
    if (!availability.isActive || availability.deletedAt) {
      return { generated: 0, skippedForDstGap: [] };
    }

    const spec = toSpec(availability);
    const now = new Date();

    // Start from today in the doctor's own zone, not UTC — otherwise a doctor
    // in Asia/Kolkata loses the remainder of their current working day
    // whenever UTC is still on the previous date.
    const rangeStart = toZonedDate(now, availability.timezone);
    const horizon = eachLocalDate(
      rangeStart,
      toZonedDate(new Date(now.getTime() + horizonDays * 86_400_000), availability.timezone),
      availability.timezone,
    );
    const rangeEnd = horizon[horizon.length - 1] as string;

    const { slots, skippedForDstGap } = generateSlotsForAvailability(spec, rangeStart, rangeEnd);

    // Never materialise into the past; a partially elapsed day would otherwise
    // reintroduce slots the doctor already worked through.
    const future = slots.filter((slot) => slot.startsAt > now);

    if (future.length > env.MAX_SLOTS_PER_GENERATION) {
      throw new BusinessRuleError(
        `This configuration would generate ${future.length} slots, above the limit of ${env.MAX_SLOTS_PER_GENERATION}`,
        { requested: future.length, limit: env.MAX_SLOTS_PER_GENERATION },
      );
    }

    const generated = await slotRepository.createMany(
      future.map((slot) => ({
        doctorId: availability.doctorId,
        availabilityId: availability.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        durationMinutes: slot.durationMinutes,
        bufferMinutes: slot.bufferMinutes,
        mode: availability.mode,
        appointmentType: availability.appointmentType,
      })),
    );

    slotsGeneratedTotal.inc(generated);

    if (skippedForDstGap.length > 0) {
      logger.info(
        { availabilityId: availability.id, dates: skippedForDstGap },
        'skipped slots falling in a daylight-saving gap',
      );
    }

    return { generated, skippedForDstGap };
  }

  /** Attach booking identifiers to slots that could not be withdrawn. */
  private async describeOrphans(
    slots: Slot[],
  ): Promise<Array<{ bookingId: string; slotId: string; startsAt: Date }>> {
    const orphans: Array<{ bookingId: string; slotId: string; startsAt: Date }> = [];

    for (const slot of slots) {
      const booking = await bookingRepository.findConfirmedForSlot(slot.id);
      if (booking) {
        orphans.push({ bookingId: booking.id, slotId: slot.id, startsAt: slot.startsAt });
      }
    }
    return orphans;
  }

  private assertShapeMatchesKind(request: CreateAvailabilityRequest): void {
    if (request.kind === AvailabilityKind.ONE_OFF) {
      if (!request.date) {
        throw new BusinessRuleError('A one-off availability requires a date');
      }
      if (request.weekday !== null && request.weekday !== undefined) {
        throw new BusinessRuleError('A one-off availability must not carry a weekday');
      }
      return;
    }

    if (request.weekday === null || request.weekday === undefined) {
      throw new BusinessRuleError('A recurring availability requires a weekday');
    }
    if (request.date) {
      throw new BusinessRuleError('A recurring availability must not carry a date');
    }
  }

  /** Reject configurations whose slot count would be unreasonable. */
  private assertGenerationSizeIsSane(input: {
    startMinuteOfDay: number;
    endMinuteOfDay: number;
    slotDurationMinutes: number;
    bufferMinutes: number;
    horizonDays: number;
    timezone: string;
  }): void {
    const perDay = countSlotsForWindow({
      date: '2000-01-03', // An arbitrary DST-free reference date; only the count matters.
      startMinuteOfDay: input.startMinuteOfDay,
      endMinuteOfDay: input.endMinuteOfDay,
      timezone: 'UTC',
      slotDurationMinutes: input.slotDurationMinutes,
      bufferMinutes: input.bufferMinutes,
    });

    // Upper bound: a recurring window hits at most once per week, a one-off
    // once. Using the daily figure is conservative and cheap.
    const upperBound = perDay * Math.ceil(input.horizonDays / 7 + 1);

    if (upperBound > env.MAX_SLOTS_PER_GENERATION) {
      throw new BusinessRuleError(
        `This configuration would generate roughly ${upperBound} slots, above the limit of ${env.MAX_SLOTS_PER_GENERATION}`,
        { estimate: upperBound, limit: env.MAX_SLOTS_PER_GENERATION, slotsPerDay: perDay },
      );
    }
  }

  /**
   * Invalidate cached slot listings for a doctor.
   *
   * Bumping a version counter is O(1) and leaves stale entries to expire on
   * their own TTL. Scanning for and deleting matching keys would be O(keyspace)
   * and is the classic way to stall a production Redis.
   */
  private async invalidateSlotCache(doctorId: string): Promise<void> {
    try {
      await redis.incr(redisKeys.slotsCacheVersion(doctorId));
    } catch (error) {
      // A cache that cannot be invalidated is a staleness problem, not a
      // correctness one — booking re-validates against the database.
      logger.warn({ err: error, doctorId }, 'failed to invalidate slot cache');
    }
  }
}

/** Map a persisted availability onto the pure generator's input type. */
function toSpec(availability: Availability): RecurringWindowSpec {
  return {
    kind: availability.kind,
    date: availability.date ? availability.date.toISOString().slice(0, 10) : null,
    weekday: availability.weekday,
    startMinuteOfDay: availability.startMinuteOfDay,
    endMinuteOfDay: availability.endMinuteOfDay,
    timezone: availability.timezone,
    slotDurationMinutes: availability.slotDurationMinutes,
    bufferMinutes: availability.bufferMinutes,
    effectiveFrom: availability.effectiveFrom
      ? availability.effectiveFrom.toISOString().slice(0, 10)
      : null,
    effectiveUntil: availability.effectiveUntil
      ? availability.effectiveUntil.toISOString().slice(0, 10)
      : null,
  };
}

export const availabilityService = new AvailabilityService();

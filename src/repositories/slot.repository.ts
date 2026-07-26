import { Prisma, SlotStatus, type AppointmentMode, type Slot } from '@prisma/client';
import { prisma, type PrismaExecutor, type TransactionClient } from '../config/prisma';

/**
 * Persistence for slots — the contended resource in this system.
 *
 * The methods that matter for correctness are `lockForUpdate` (pessimistic row
 * lock) and `claimIfAvailable` (conditional update). Everything else is
 * ordinary querying.
 */

export interface SlotSearchFilters {
  doctorId: string;
  from: Date;
  to: Date;
  status?: SlotStatus;
  appointmentType?: string;
  mode?: AppointmentMode;
}

export interface GeneratedSlotInput {
  doctorId: string;
  availabilityId: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  bufferMinutes: number;
  mode: AppointmentMode;
  appointmentType: string;
}

export class SlotRepository {
  /**
   * Bulk-insert generated slots, ignoring ones that already exist.
   *
   * `skipDuplicates` compiles to `ON CONFLICT DO NOTHING`, which makes
   * generation idempotent: re-running it after a partial failure, or when a
   * doctor edits an overlapping window, converges instead of erroring. The
   * partial unique index on `(doctorId, startsAt) WHERE deletedAt IS NULL` is
   * what it conflicts against.
   */
  async createMany(
    slots: GeneratedSlotInput[],
    executor: PrismaExecutor = prisma,
  ): Promise<number> {
    if (slots.length === 0) return 0;

    const result = await executor.slot.createMany({
      data: slots.map((slot) => ({ ...slot, status: SlotStatus.AVAILABLE })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async findById(id: string, executor: PrismaExecutor = prisma): Promise<Slot | null> {
    return executor.slot.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * Acquire a pessimistic row lock on a slot.
   *
   * MUST be called inside a transaction — a row lock outside one is released
   * immediately and buys nothing. Every concurrent booker for this slot
   * serialises here; the winner proceeds and the rest observe the updated
   * status when they finally acquire the lock.
   *
   * `NOWAIT` is deliberately NOT used: waiting is the desired behaviour, since
   * the wait is bounded by one short transaction.
   */
  async lockForUpdate(id: string, tx: TransactionClient): Promise<Slot | null> {
    const rows = await tx.$queryRaw<Slot[]>`
      SELECT * FROM "slots"
      WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /**
   * Atomically move a slot from AVAILABLE (or HELD by this hold) to a target
   * status, returning whether the transition happened.
   *
   * The `status` predicate in the WHERE clause is the compare-and-swap: if
   * another transaction already changed the status, zero rows update and the
   * caller learns it lost without needing to re-read. `version` is bumped so
   * optimistic readers can detect staleness.
   */
  async claimIfAvailable(
    id: string,
    toStatus: SlotStatus,
    fromStatuses: SlotStatus[],
    executor: PrismaExecutor = prisma,
  ): Promise<boolean> {
    const result = await executor.slot.updateMany({
      where: { id, status: { in: fromStatuses }, deletedAt: null },
      data: { status: toStatus, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** Release a slot back to AVAILABLE and clear any hold marker. */
  async release(id: string, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.slot.updateMany({
      where: { id, deletedAt: null, status: { in: [SlotStatus.BOOKED, SlotStatus.HELD] } },
      data: { status: SlotStatus.AVAILABLE, heldUntil: null, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  async markHeld(id: string, heldUntil: Date, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.slot.updateMany({
      where: { id, status: SlotStatus.AVAILABLE, deletedAt: null },
      data: { status: SlotStatus.HELD, heldUntil, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /**
   * Return a held slot to AVAILABLE, but only if the hold has actually
   * expired. The `heldUntil <= now` guard prevents a late-arriving expiry job
   * from stealing a slot whose hold was renewed in the meantime.
   */
  async expireHold(id: string, now: Date, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.slot.updateMany({
      where: {
        id,
        status: SlotStatus.HELD,
        heldUntil: { lte: now },
        deletedAt: null,
      },
      data: { status: SlotStatus.AVAILABLE, heldUntil: null, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** Slots a patient may book: AVAILABLE, in range, not in the past. */
  async findBookable(
    filters: SlotSearchFilters,
    executor: PrismaExecutor = prisma,
  ): Promise<Slot[]> {
    return executor.slot.findMany({
      where: {
        doctorId: filters.doctorId,
        startsAt: { gte: filters.from, lt: filters.to },
        status: filters.status ?? SlotStatus.AVAILABLE,
        deletedAt: null,
        ...(filters.appointmentType ? { appointmentType: filters.appointmentType } : {}),
        ...(filters.mode ? { mode: filters.mode } : {}),
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  async findByAvailability(
    availabilityId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<Slot[]> {
    return executor.slot.findMany({
      where: { availabilityId, deletedAt: null },
      orderBy: { startsAt: 'asc' },
    });
  }

  /**
   * Slots generated from an availability that are still free and in the
   * future — precisely the set a doctor may retroactively withdraw.
   * BOOKED and HELD slots are excluded by construction: an existing
   * commitment is never silently destroyed.
   */
  async findFutureUnbooked(
    availabilityId: string,
    after: Date,
    executor: PrismaExecutor = prisma,
  ): Promise<Slot[]> {
    return executor.slot.findMany({
      where: {
        availabilityId,
        startsAt: { gt: after },
        status: SlotStatus.AVAILABLE,
        deletedAt: null,
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  /**
   * Withdraw slots from sale. BLOCKED rather than deleted, so the audit trail
   * shows what was offered and when it stopped being offered — and so the
   * exclusion constraint (which ignores BLOCKED rows) permits a replacement
   * window to be generated over the same time.
   */
  async blockMany(
    ids: string[],
    reason: string,
    executor: PrismaExecutor = prisma,
  ): Promise<number> {
    if (ids.length === 0) return 0;

    const result = await executor.slot.updateMany({
      where: { id: { in: ids }, status: SlotStatus.AVAILABLE, deletedAt: null },
      data: { status: SlotStatus.BLOCKED, blockedReason: reason, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Slots that still carry a live booking — used to warn on availability edits. */
  async findBookedInRange(
    doctorId: string,
    from: Date,
    to: Date,
    executor: PrismaExecutor = prisma,
  ): Promise<Slot[]> {
    return executor.slot.findMany({
      where: {
        doctorId,
        startsAt: { gte: from, lt: to },
        status: SlotStatus.BOOKED,
        deletedAt: null,
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  /**
   * Held slots whose lease has elapsed — the reconciliation sweeper's query.
   * Bounded by `limit` so a backlog is drained in batches rather than loaded
   * into memory in one go.
   */
  async findExpiredHolds(
    now: Date,
    limit = 500,
    executor: PrismaExecutor = prisma,
  ): Promise<Slot[]> {
    return executor.slot.findMany({
      where: { status: SlotStatus.HELD, heldUntil: { lte: now }, deletedAt: null },
      take: limit,
      orderBy: { heldUntil: 'asc' },
    });
  }

  async countByStatus(
    doctorId: string,
    from: Date,
    to: Date,
    executor: PrismaExecutor = prisma,
  ): Promise<Record<SlotStatus, number>> {
    const grouped = await executor.slot.groupBy({
      by: ['status'],
      where: { doctorId, startsAt: { gte: from, lt: to }, deletedAt: null },
      _count: { _all: true },
    });

    const counts: Record<SlotStatus, number> = {
      [SlotStatus.AVAILABLE]: 0,
      [SlotStatus.HELD]: 0,
      [SlotStatus.BOOKED]: 0,
      [SlotStatus.BLOCKED]: 0,
    };

    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }
    return counts;
  }

  /**
   * Soft-delete future free slots for an availability that is being removed.
   * Same reasoning as `blockMany`: history is preserved, and the partial
   * unique index (which ignores soft-deleted rows) frees the time for reuse.
   */
  async softDeleteFutureUnbooked(
    availabilityId: string,
    after: Date,
    executor: PrismaExecutor = prisma,
  ): Promise<number> {
    const result = await executor.slot.updateMany({
      where: {
        availabilityId,
        startsAt: { gt: after },
        status: SlotStatus.AVAILABLE,
        deletedAt: null,
      },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    return result.count;
  }

  /** Escape hatch for reporting queries that do not fit the typed API. */
  async raw<T>(query: Prisma.Sql, executor: PrismaExecutor = prisma): Promise<T> {
    return executor.$queryRaw<T>(query);
  }
}

export const slotRepository = new SlotRepository();

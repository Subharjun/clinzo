import { AvailabilityKind, type AppointmentMode, type Availability } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';
import { ConflictError } from '../utils/errors';

/**
 * Persistence for availability windows.
 *
 * Updates go through `updateWithVersion`, an optimistic-locking write.
 * Availability edits are rare and low-contention, so a version check costs
 * nothing in the common case while still preventing two clinic administrators
 * from clobbering each other's changes through a stale form.
 */

export interface CreateAvailabilityInput {
  doctorId: string;
  kind: AvailabilityKind;
  date?: Date | null;
  weekday?: number | null;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  timezone: string;
  slotDurationMinutes: number;
  bufferMinutes: number;
  mode: AppointmentMode;
  appointmentType: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
}

export interface UpdateAvailabilityInput {
  startMinuteOfDay?: number;
  endMinuteOfDay?: number;
  slotDurationMinutes?: number;
  bufferMinutes?: number;
  timezone?: string;
  mode?: AppointmentMode;
  appointmentType?: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  isActive?: boolean;
}

export class AvailabilityRepository {
  async create(
    input: CreateAvailabilityInput,
    executor: PrismaExecutor = prisma,
  ): Promise<Availability> {
    return executor.availability.create({ data: input });
  }

  async findById(id: string, executor: PrismaExecutor = prisma): Promise<Availability | null> {
    return executor.availability.findFirst({ where: { id, deletedAt: null } });
  }

  async findByDoctor(
    doctorId: string,
    options: { activeOnly?: boolean } = {},
    executor: PrismaExecutor = prisma,
  ): Promise<Availability[]> {
    return executor.availability.findMany({
      where: {
        doctorId,
        deletedAt: null,
        ...(options.activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ kind: 'asc' }, { weekday: 'asc' }, { date: 'asc' }, { startMinuteOfDay: 'asc' }],
    });
  }

  /**
   * Windows that could produce slots on a given local weekday/date.
   * Used to decide whether a manually created slot is covered by any window.
   */
  async findApplicable(
    doctorId: string,
    weekday: number,
    date: Date,
    executor: PrismaExecutor = prisma,
  ): Promise<Availability[]> {
    return executor.availability.findMany({
      where: {
        doctorId,
        deletedAt: null,
        isActive: true,
        OR: [
          { kind: AvailabilityKind.ONE_OFF, date },
          {
            kind: AvailabilityKind.RECURRING,
            weekday,
            AND: [
              { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: date } }] },
              { OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: date } }] },
            ],
          },
        ],
      },
    });
  }

  /**
   * Optimistic update. Throws 409 if the row changed since the caller read it,
   * so a stale edit is rejected rather than applied on top of someone else's.
   */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    input: UpdateAvailabilityInput,
    executor: PrismaExecutor = prisma,
  ): Promise<Availability> {
    const result = await executor.availability.updateMany({
      where: { id, version: expectedVersion, deletedAt: null },
      data: { ...input, version: { increment: 1 } },
    });

    if (result.count === 0) {
      throw new ConflictError(
        'This availability was modified by someone else; reload and try again',
        { availabilityId: id, expectedVersion },
      );
    }

    // updateMany does not return rows; re-read to give the caller the new state.
    const updated = await this.findById(id, executor);
    if (!updated) {
      throw new ConflictError('Availability disappeared during update', { availabilityId: id });
    }
    return updated;
  }

  /** Soft delete — historical slots keep pointing at a readable definition. */
  async softDelete(id: string, executor: PrismaExecutor = prisma): Promise<void> {
    await executor.availability.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, version: { increment: 1 } },
    });
  }

  /**
   * Detect windows that would overlap a proposed one on the same weekday/date.
   *
   * Overlap is computed in wall-clock minutes rather than instants because
   * that is how a doctor reasons about their own diary — and because two
   * windows in different timezones for the same doctor is a configuration
   * error we reject upstream.
   */
  async findOverlapping(
    doctorId: string,
    candidate: {
      kind: AvailabilityKind;
      date?: Date | null;
      weekday?: number | null;
      startMinuteOfDay: number;
      endMinuteOfDay: number;
    },
    excludeId?: string,
    executor: PrismaExecutor = prisma,
  ): Promise<Availability[]> {
    const sameSlotSelector =
      candidate.kind === AvailabilityKind.ONE_OFF
        ? { kind: AvailabilityKind.ONE_OFF, date: candidate.date ?? undefined }
        : { kind: AvailabilityKind.RECURRING, weekday: candidate.weekday ?? undefined };

    return executor.availability.findMany({
      where: {
        doctorId,
        deletedAt: null,
        isActive: true,
        ...sameSlotSelector,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        // Half-open overlap: [aStart, aEnd) intersects [bStart, bEnd).
        startMinuteOfDay: { lt: candidate.endMinuteOfDay },
        endMinuteOfDay: { gt: candidate.startMinuteOfDay },
      },
    });
  }
}

export const availabilityRepository = new AvailabilityRepository();

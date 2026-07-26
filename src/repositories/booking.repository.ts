import {
  BookingStatus,
  Prisma,
  type AppointmentMode,
  type Booking,
  type CancelledBy,
  type Doctor,
  type Patient,
  type Slot,
  type User,
} from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';
import type { PaginationParams } from '../types';

/**
 * Persistence for bookings.
 *
 * The insert path relies on the partial unique index
 * `bookings(slotId) WHERE status = 'CONFIRMED'`. A duplicate raises P2002,
 * which `translatePrismaError` converts into a 409. That index — not any check
 * in this file — is what makes double-booking impossible.
 */

export type BookingWithRelations = Booking & {
  slot: Slot;
  doctor: Doctor & { user: Pick<User, 'fullName' | 'email' | 'timezone' | 'phone'> };
  patient: Patient & { user: Pick<User, 'fullName' | 'email' | 'timezone' | 'phone'> };
};

const relations = {
  slot: true,
  doctor: {
    include: { user: { select: { fullName: true, email: true, timezone: true, phone: true } } },
  },
  patient: {
    include: { user: { select: { fullName: true, email: true, timezone: true, phone: true } } },
  },
} satisfies Prisma.BookingInclude;

export interface CreateBookingInput {
  slotId: string;
  patientId: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
  mode: AppointmentMode;
  appointmentType: string;
  reasonForVisit?: string | null;
  confirmationCode: string;
  rescheduledFromId?: string | null;
}

export interface BookingListFilters {
  patientId?: string;
  doctorId?: string;
  status?: BookingStatus[];
  from?: Date;
  to?: Date;
  /** `upcoming` hides past appointments; `past` shows only those. */
  window?: 'upcoming' | 'past' | 'all';
}

export class BookingRepository {
  async create(input: CreateBookingInput, executor: PrismaExecutor = prisma): Promise<Booking> {
    return executor.booking.create({
      data: { ...input, status: BookingStatus.CONFIRMED },
    });
  }

  async findById(
    id: string,
    executor: PrismaExecutor = prisma,
  ): Promise<BookingWithRelations | null> {
    return executor.booking.findFirst({
      where: { id, deletedAt: null },
      include: relations,
    }) as Promise<BookingWithRelations | null>;
  }

  async findByConfirmationCode(
    code: string,
    executor: PrismaExecutor = prisma,
  ): Promise<BookingWithRelations | null> {
    return executor.booking.findFirst({
      where: { confirmationCode: code, deletedAt: null },
      include: relations,
    }) as Promise<BookingWithRelations | null>;
  }

  /** The live booking occupying a slot, if any. */
  async findConfirmedForSlot(
    slotId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<Booking | null> {
    return executor.booking.findFirst({
      where: { slotId, status: BookingStatus.CONFIRMED, deletedAt: null },
    });
  }

  /**
   * Does this patient already hold a confirmed booking overlapping this time?
   *
   * Guards against a patient booking two doctors for the same hour — a
   * different concern from double-booking a slot, and one no database
   * constraint can express, since it spans rows.
   */
  async hasOverlappingBooking(
    patientId: string,
    startsAt: Date,
    endsAt: Date,
    excludeBookingId: string | undefined,
    executor: PrismaExecutor = prisma,
  ): Promise<boolean> {
    const conflict = await executor.booking.findFirst({
      where: {
        patientId,
        status: BookingStatus.CONFIRMED,
        deletedAt: null,
        // Half-open overlap.
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      },
      select: { id: true },
    });
    return conflict !== null;
  }

  /**
   * Cancel a booking, guarded on its current status so a double-cancel (or a
   * cancel racing a reschedule) updates zero rows instead of corrupting state.
   */
  async cancel(
    id: string,
    cancelledBy: CancelledBy,
    reason: string | null,
    executor: PrismaExecutor = prisma,
  ): Promise<boolean> {
    const result = await executor.booking.updateMany({
      where: { id, status: BookingStatus.CONFIRMED, deletedAt: null },
      data: {
        status: BookingStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy,
        cancellationReason: reason,
      },
    });
    return result.count === 1;
  }

  /**
   * Mark a booking as superseded by a reschedule. Distinct from CANCELLED so
   * reporting can tell "patient dropped out" from "patient moved".
   *
   * `cancelledAt` stays null, which the `bookings_cancellation_coherent` check
   * constraint requires for any non-CANCELLED status.
   */
  async markRescheduled(id: string, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.booking.updateMany({
      where: { id, status: BookingStatus.CONFIRMED, deletedAt: null },
      data: { status: BookingStatus.RESCHEDULED },
    });
    return result.count === 1;
  }

  async list(
    filters: BookingListFilters,
    pagination: PaginationParams,
    executor: PrismaExecutor = prisma,
  ): Promise<{ rows: BookingWithRelations[]; total: number }> {
    const where = this.buildWhere(filters);

    const [rows, total] = await Promise.all([
      executor.booking.findMany({
        where,
        include: relations,
        orderBy: { startsAt: filters.window === 'past' ? 'desc' : 'asc' },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      executor.booking.count({ where }),
    ]);

    return { rows: rows as BookingWithRelations[], total };
  }

  private buildWhere(filters: BookingListFilters): Prisma.BookingWhereInput {
    const now = new Date();

    const where: Prisma.BookingWhereInput = { deletedAt: null };

    if (filters.patientId) where.patientId = filters.patientId;
    if (filters.doctorId) where.doctorId = filters.doctorId;
    if (filters.status?.length) where.status = { in: filters.status };

    const startsAt: Prisma.DateTimeFilter = {};
    if (filters.from) startsAt.gte = filters.from;
    if (filters.to) startsAt.lt = filters.to;

    if (filters.window === 'upcoming') startsAt.gte = filters.from ?? now;
    if (filters.window === 'past') startsAt.lt = filters.to ?? now;

    if (Object.keys(startsAt).length > 0) where.startsAt = startsAt;

    return where;
  }

  /** Bookings starting inside a window — used by the reminder scheduler. */
  async findStartingBetween(
    from: Date,
    to: Date,
    executor: PrismaExecutor = prisma,
  ): Promise<BookingWithRelations[]> {
    return executor.booking.findMany({
      where: {
        status: BookingStatus.CONFIRMED,
        startsAt: { gte: from, lt: to },
        deletedAt: null,
      },
      include: relations,
      orderBy: { startsAt: 'asc' },
    }) as Promise<BookingWithRelations[]>;
  }

  async countForPatient(
    patientId: string,
    status: BookingStatus,
    executor: PrismaExecutor = prisma,
  ): Promise<number> {
    return executor.booking.count({ where: { patientId, status, deletedAt: null } });
  }
}

export const bookingRepository = new BookingRepository();

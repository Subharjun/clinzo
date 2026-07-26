import { HoldStatus, type ReservationHold } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';

/**
 * Persistence for reservation holds.
 *
 * Redis owns the *authoritative* expiry (its TTL is what makes a hold vanish
 * without anyone running code). These rows exist for two reasons Redis cannot
 * serve: an auditable record of who held what and when, and a recovery source
 * if Redis is flushed or fails over with an empty dataset.
 *
 * The partial unique index `(slotId) WHERE status = 'ACTIVE'` means two
 * concurrent checkouts for one slot cannot both create a hold, independent of
 * whether the Redis path behaved.
 */

export interface CreateHoldInput {
  slotId: string;
  patientId: string;
  expiresAt: Date;
  checkoutReference?: string | null;
}

export class ReservationHoldRepository {
  async create(
    input: CreateHoldInput,
    executor: PrismaExecutor = prisma,
  ): Promise<ReservationHold> {
    return executor.reservationHold.create({
      data: { ...input, status: HoldStatus.ACTIVE },
    });
  }

  async findById(id: string, executor: PrismaExecutor = prisma): Promise<ReservationHold | null> {
    return executor.reservationHold.findUnique({ where: { id } });
  }

  async findActiveForSlot(
    slotId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<ReservationHold | null> {
    return executor.reservationHold.findFirst({
      where: { slotId, status: HoldStatus.ACTIVE },
    });
  }

  async findActiveForPatient(
    patientId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<ReservationHold[]> {
    return executor.reservationHold.findMany({
      where: { patientId, status: HoldStatus.ACTIVE },
      orderBy: { expiresAt: 'asc' },
    });
  }

  /**
   * Convert a hold into a booking.
   *
   * Guarded on `status = ACTIVE` *and* `expiresAt > now`: a hold that lapsed
   * between the client's last request and this call must not be honoured, or
   * a patient could complete checkout on a slot the system already offered to
   * someone else.
   */
  async consume(id: string, now: Date, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.reservationHold.updateMany({
      where: { id, status: HoldStatus.ACTIVE, expiresAt: { gt: now } },
      data: { status: HoldStatus.CONSUMED, consumedAt: now },
    });
    return result.count === 1;
  }

  /** Voluntary abandon (patient backed out of checkout). */
  async release(id: string, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.reservationHold.updateMany({
      where: { id, status: HoldStatus.ACTIVE },
      data: { status: HoldStatus.RELEASED, releasedAt: new Date() },
    });
    return result.count === 1;
  }

  /** Mark lapsed holds. Distinguished from RELEASED for conversion analytics. */
  async expire(id: string, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.reservationHold.updateMany({
      where: { id, status: HoldStatus.ACTIVE },
      data: { status: HoldStatus.EXPIRED, releasedAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * Holds whose lease elapsed but which are still marked ACTIVE — i.e. the
   * Redis key expired without the corresponding database transition landing.
   * The reconciliation sweeper's input.
   */
  async findLapsed(
    now: Date,
    limit = 500,
    executor: PrismaExecutor = prisma,
  ): Promise<ReservationHold[]> {
    return executor.reservationHold.findMany({
      where: { status: HoldStatus.ACTIVE, expiresAt: { lte: now } },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });
  }

  async expireManyLapsed(now: Date, executor: PrismaExecutor = prisma): Promise<number> {
    const result = await executor.reservationHold.updateMany({
      where: { status: HoldStatus.ACTIVE, expiresAt: { lte: now } },
      data: { status: HoldStatus.EXPIRED, releasedAt: now },
    });
    return result.count;
  }

  async countActiveForPatient(
    patientId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<number> {
    return executor.reservationHold.count({
      where: { patientId, status: HoldStatus.ACTIVE, expiresAt: { gt: new Date() } },
    });
  }
}

export const reservationHoldRepository = new ReservationHoldRepository();

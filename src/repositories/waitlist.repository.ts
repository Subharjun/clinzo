import { WaitlistStatus, type WaitlistEntry } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';

/**
 * Persistence for the waitlist.
 *
 * When a slot is released, candidates are matched by (doctor, overlapping
 * window, appointment type) and ordered by `priority` then `createdAt` — a
 * stable FIFO with an explicit override for clinically urgent cases.
 *
 * Notification does NOT reserve the slot. Handing an exclusive hold to the
 * first candidate would make one unresponsive patient block the slot for the
 * full hold TTL; instead every matched candidate is told, and the ordinary
 * booking race decides. The database constraint guarantees exactly one wins.
 */

export interface CreateWaitlistInput {
  doctorId: string;
  patientId: string;
  windowStart: Date;
  windowEnd: Date;
  appointmentType: string;
  priority?: number;
}

export class WaitlistRepository {
  async create(
    input: CreateWaitlistInput,
    executor: PrismaExecutor = prisma,
  ): Promise<WaitlistEntry> {
    return executor.waitlistEntry.create({
      data: { ...input, priority: input.priority ?? 0, status: WaitlistStatus.ACTIVE },
    });
  }

  async findById(id: string, executor: PrismaExecutor = prisma): Promise<WaitlistEntry | null> {
    return executor.waitlistEntry.findUnique({ where: { id } });
  }

  async findForPatient(
    patientId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<WaitlistEntry[]> {
    return executor.waitlistEntry.findMany({
      where: { patientId, status: { in: [WaitlistStatus.ACTIVE, WaitlistStatus.NOTIFIED] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Candidates whose desired window contains a newly freed slot.
   * `limit` caps the notification fan-out so releasing one slot cannot page
   * ten thousand patients at once.
   */
  async findCandidatesForSlot(
    doctorId: string,
    slotStart: Date,
    slotEnd: Date,
    appointmentType: string,
    limit = 20,
    executor: PrismaExecutor = prisma,
  ): Promise<WaitlistEntry[]> {
    return executor.waitlistEntry.findMany({
      where: {
        doctorId,
        appointmentType,
        status: WaitlistStatus.ACTIVE,
        // The slot must sit inside the patient's acceptable window.
        windowStart: { lte: slotStart },
        windowEnd: { gte: slotEnd },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  async markNotified(ids: string[], executor: PrismaExecutor = prisma): Promise<number> {
    if (ids.length === 0) return 0;

    const result = await executor.waitlistEntry.updateMany({
      where: { id: { in: ids }, status: WaitlistStatus.ACTIVE },
      data: { status: WaitlistStatus.NOTIFIED, notifiedAt: new Date() },
    });
    return result.count;
  }

  /** Called when a waitlisted patient actually books. */
  async markFulfilled(id: string, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.waitlistEntry.updateMany({
      where: { id, status: { in: [WaitlistStatus.ACTIVE, WaitlistStatus.NOTIFIED] } },
      data: { status: WaitlistStatus.FULFILLED, fulfilledAt: new Date() },
    });
    return result.count === 1;
  }

  async cancel(id: string, patientId: string, executor: PrismaExecutor = prisma): Promise<boolean> {
    const result = await executor.waitlistEntry.updateMany({
      // patientId in the predicate makes this authorisation-safe: a patient
      // cannot cancel someone else's entry even by guessing an id.
      where: { id, patientId, status: { in: [WaitlistStatus.ACTIVE, WaitlistStatus.NOTIFIED] } },
      data: { status: WaitlistStatus.CANCELLED },
    });
    return result.count === 1;
  }

  /** Expire entries whose desired window has entirely passed. */
  async expirePastWindows(now: Date, executor: PrismaExecutor = prisma): Promise<number> {
    const result = await executor.waitlistEntry.updateMany({
      where: {
        status: { in: [WaitlistStatus.ACTIVE, WaitlistStatus.NOTIFIED] },
        windowEnd: { lt: now },
      },
      data: { status: WaitlistStatus.EXPIRED },
    });
    return result.count;
  }

  /**
   * Resolve entries together with their patients' contact details, for the
   * notification worker. A dedicated method rather than a broad include, so
   * the columns leaving the database are explicit.
   */
  async findWithContacts(ids: string[], executor: PrismaExecutor = prisma) {
    if (ids.length === 0) return [];

    return executor.waitlistEntry.findMany({
      where: { id: { in: ids } },
      include: {
        patient: {
          include: {
            user: { select: { fullName: true, email: true, phone: true, timezone: true } },
          },
        },
      },
    });
  }

  /** Prevents a patient stacking duplicate entries for the same window. */
  async findDuplicate(
    input: CreateWaitlistInput,
    executor: PrismaExecutor = prisma,
  ): Promise<WaitlistEntry | null> {
    return executor.waitlistEntry.findFirst({
      where: {
        doctorId: input.doctorId,
        patientId: input.patientId,
        appointmentType: input.appointmentType,
        status: { in: [WaitlistStatus.ACTIVE, WaitlistStatus.NOTIFIED] },
        windowStart: { lt: input.windowEnd },
        windowEnd: { gt: input.windowStart },
      },
    });
  }
}

export const waitlistRepository = new WaitlistRepository();

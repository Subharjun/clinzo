import { Role, type WaitlistEntry } from '@prisma/client';
import { prisma } from '../config/prisma';
import { BusinessRuleError, ConflictError, NotFoundError } from '../utils/errors';
import { waitlistRepository } from '../repositories/waitlist.repository';
import { doctorRepository } from '../repositories/doctor.repository';
import { outboxRepository } from '../repositories/outbox.repository';
import { AuditAction, auditLogRepository } from '../repositories/audit-log.repository';
import { AggregateType, EventType } from '../events/domain-events';
import type { SessionContext } from './auth.service';

/**
 * Waitlist.
 *
 * ## Notification model: broadcast, not exclusive handoff
 *
 * When a slot frees up, every matching candidate (up to a cap) is notified and
 * the ordinary booking race decides who gets it. The alternative — granting an
 * exclusive hold to the first candidate and cascading down the list on
 * timeout — was rejected: it makes one unresponsive patient block the slot for
 * a full hold TTL, and a chain of five such patients leaves a slot unsellable
 * for ten minutes. In a same-day medical context that is the wrong trade.
 *
 * The cost is that losers receive a notification for a slot they may not get.
 * That is mitigated by ordering notifications by priority then FIFO, and by
 * capping fan-out so the race stays small.
 */

/** Cap on how far ahead a patient may waitlist — keeps the table bounded. */
const MAX_WAITLIST_WINDOW_DAYS = 90;

export interface JoinWaitlistInput {
  doctorId: string;
  patientId: string;
  windowStart: Date;
  windowEnd: Date;
  appointmentType?: string;
  priority?: number;
}

export class WaitlistService {
  async join(input: JoinWaitlistInput, context: SessionContext): Promise<WaitlistEntry> {
    const doctor = await doctorRepository.findById(input.doctorId);
    if (!doctor) throw new NotFoundError('Doctor');

    if (input.windowEnd <= input.windowStart) {
      throw new BusinessRuleError('The waitlist window must end after it starts');
    }
    if (input.windowEnd <= new Date()) {
      throw new BusinessRuleError('The waitlist window must be in the future');
    }

    const spanDays = (input.windowEnd.getTime() - input.windowStart.getTime()) / 86_400_000;
    if (spanDays > MAX_WAITLIST_WINDOW_DAYS) {
      throw new BusinessRuleError(
        `A waitlist window may span at most ${MAX_WAITLIST_WINDOW_DAYS} days`,
        { requestedDays: Math.ceil(spanDays), maximumDays: MAX_WAITLIST_WINDOW_DAYS },
      );
    }

    const appointmentType = input.appointmentType ?? 'STANDARD';

    const duplicate = await waitlistRepository.findDuplicate({
      doctorId: input.doctorId,
      patientId: input.patientId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      appointmentType,
    });

    if (duplicate) {
      throw new ConflictError('You are already on the waitlist for an overlapping window', {
        existingEntryId: duplicate.id,
      });
    }

    return prisma.$transaction(async (tx) => {
      const entry = await waitlistRepository.create(
        {
          doctorId: input.doctorId,
          patientId: input.patientId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          appointmentType,
          priority: input.priority ?? 0,
        },
        tx,
      );

      await auditLogRepository.record(
        {
          actorId: context.userId ?? null,
          actorRole: Role.PATIENT,
          action: AuditAction.WAITLIST_JOINED,
          entityType: 'WaitlistEntry',
          entityId: entry.id,
          metadata: {
            doctorId: input.doctorId,
            windowStart: input.windowStart.toISOString(),
            windowEnd: input.windowEnd.toISOString(),
          },
          requestId: context.requestId ?? null,
        },
        tx,
      );

      return entry;
    });
  }

  async listForPatient(patientId: string): Promise<WaitlistEntry[]> {
    return waitlistRepository.findForPatient(patientId);
  }

  async cancel(entryId: string, patientId: string, context: SessionContext): Promise<void> {
    const cancelled = await waitlistRepository.cancel(entryId, patientId);
    if (!cancelled) {
      throw new NotFoundError('Waitlist entry');
    }

    auditLogRepository.recordDetached({
      actorId: context.userId ?? null,
      actorRole: Role.PATIENT,
      action: AuditAction.WAITLIST_CANCELLED,
      entityType: 'WaitlistEntry',
      entityId: entryId,
      requestId: context.requestId ?? null,
    });
  }

  /**
   * Match a freed slot against the waitlist and publish a notification event.
   *
   * Invoked by the event consumer for `slot.released` — not synchronously from
   * the cancellation path, which must stay short.
   */
  async notifyForReleasedSlot(input: {
    slotId: string;
    doctorId: string;
    startsAt: Date;
    endsAt: Date;
    appointmentType: string;
  }): Promise<string[]> {
    const candidates = await waitlistRepository.findCandidatesForSlot(
      input.doctorId,
      input.startsAt,
      input.endsAt,
      input.appointmentType,
    );

    if (candidates.length === 0) return [];

    const candidateIds = candidates.map((entry) => entry.id);

    await prisma.$transaction(async (tx) => {
      await waitlistRepository.markNotified(candidateIds, tx);

      await auditLogRepository.record(
        {
          actorRole: null,
          action: AuditAction.WAITLIST_NOTIFIED,
          entityType: 'Slot',
          entityId: input.slotId,
          metadata: { candidateEntryIds: candidateIds, doctorId: input.doctorId },
        },
        tx,
      );

      await outboxRepository.enqueue(
        {
          aggregateType: AggregateType.SLOT,
          aggregateId: input.slotId,
          eventType: EventType.WAITLIST_SLOT_AVAILABLE,
          payload: {
            slotId: input.slotId,
            doctorId: input.doctorId,
            startsAt: input.startsAt.toISOString(),
            endsAt: input.endsAt.toISOString(),
            candidateEntryIds: candidateIds,
          },
        },
        tx,
      );
    });

    return candidateIds;
  }
}

export const waitlistService = new WaitlistService();

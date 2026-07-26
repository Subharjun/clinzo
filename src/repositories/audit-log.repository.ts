import type { Prisma, Role } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';
import { logger } from '../utils/logger';

/**
 * Append-only audit trail.
 *
 * Two write modes exist on purpose:
 *
 *  - `record(...)` inside a transaction: the audit row commits atomically with
 *    the change it describes. Used for anything with regulatory or dispute
 *    weight — bookings, cancellations, availability edits.
 *
 *  - `recordDetached(...)`: fire-and-forget, failures swallowed and logged.
 *    Used for low-stakes reads and auth events, where an audit hiccup must not
 *    fail the user's request.
 *
 * Choosing between them is a deliberate call at each site, never a default.
 */

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: Role | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Canonical action names. String literals would drift; this will not. */
export const AuditAction = {
  USER_REGISTERED: 'user.registered',
  USER_LOGIN_SUCCEEDED: 'user.login.succeeded',
  USER_LOGIN_FAILED: 'user.login.failed',
  USER_LOGGED_OUT: 'user.logged_out',
  TOKEN_REFRESHED: 'auth.token.refreshed',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',

  AVAILABILITY_CREATED: 'availability.created',
  AVAILABILITY_UPDATED: 'availability.updated',
  AVAILABILITY_DELETED: 'availability.deleted',
  SLOTS_GENERATED: 'slots.generated',
  SLOTS_BLOCKED: 'slots.blocked',

  BOOKING_CREATED: 'booking.created',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_RESCHEDULED: 'booking.rescheduled',

  HOLD_CREATED: 'hold.created',
  HOLD_CONSUMED: 'hold.consumed',
  HOLD_RELEASED: 'hold.released',
  HOLD_EXPIRED: 'hold.expired',

  WAITLIST_JOINED: 'waitlist.joined',
  WAITLIST_NOTIFIED: 'waitlist.notified',
  WAITLIST_CANCELLED: 'waitlist.cancelled',
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export class AuditLogRepository {
  /** Transactional write — pass the `tx` client to bind it to the change. */
  async record(entry: AuditEntry, executor: PrismaExecutor = prisma): Promise<void> {
    await executor.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata,
        requestId: entry.requestId ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }

  /**
   * Non-blocking write. Deliberately does not await at the call site; a failed
   * audit insert is logged rather than propagated.
   */
  recordDetached(entry: AuditEntry): void {
    void this.record(entry).catch((error) => {
      logger.error({ err: error, action: entry.action }, 'failed to write audit log');
    });
  }

  async findForEntity(
    entityType: string,
    entityId: string,
    limit = 50,
    executor: PrismaExecutor = prisma,
  ) {
    return executor.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

export const auditLogRepository = new AuditLogRepository();

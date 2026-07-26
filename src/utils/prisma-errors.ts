import { Prisma } from '@prisma/client';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  SlotUnavailableError,
  ValidationError,
} from './errors';

/**
 * Translation layer between database-level failures and the API's error model.
 *
 * This exists so that the integrity constraints defined in the migration —
 * which are the system's real correctness guarantees — surface as precise,
 * intentional HTTP responses instead of leaking as opaque 500s.
 *
 * The mapping is keyed on constraint NAME, so adding a constraint without
 * teaching this module about it is a visible gap, not a silent regression.
 */

/** Constraint names as defined in the init migration's integrity layer. */
const CONSTRAINT = {
  ONE_CONFIRMED_BOOKING_PER_SLOT: 'bookings_one_confirmed_per_slot',
  ONE_ACTIVE_HOLD_PER_SLOT: 'reservation_holds_one_active_per_slot',
  UNIQUE_SLOT_START: 'slots_unique_start_per_doctor',
  NO_OVERLAPPING_SLOTS: 'slots_no_overlap_per_doctor',
} as const;

/** Raw Postgres SQLSTATE codes that Prisma surfaces on `$queryRaw`. */
const PG_CODE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
} as const;

/**
 * Extract the offending constraint/index name from a Prisma error.
 * Prisma reports it as `meta.target` (array or string) or, for raw queries,
 * inside the driver message.
 */
function extractTarget(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.['target'];
  if (Array.isArray(target)) return target.join(',');
  if (typeof target === 'string') return target;

  const constraint = error.meta?.['constraint'];
  if (typeof constraint === 'string') return constraint;

  return error.message;
}

/**
 * True when the failure is transient and the caller may safely retry the whole
 * transaction — serialization conflicts and deadlocks, specifically.
 * Uniqueness violations are NOT retryable: retrying produces the same result.
 */
export function isRetryableDatabaseError(error: unknown): boolean {
  const code = extractSqlState(error);
  return code === PG_CODE.SERIALIZATION_FAILURE || code === PG_CODE.DEADLOCK_DETECTED;
}

/** Pull a SQLSTATE out of whichever error shape the driver produced. */
export function extractSqlState(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const code = error.meta?.['code'];
    if (typeof code === 'string') return code;
    // P2034 is Prisma's own "transaction conflict / deadlock" wrapper.
    if (error.code === 'P2034') return PG_CODE.SERIALIZATION_FAILURE;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^\d{2}[\dA-Z]{3}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * True when the failure means "someone else already claimed this slot".
 * The booking service uses this to convert a lost race into a clean 409
 * rather than an unhandled exception.
 */
export function isSlotContentionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = extractTarget(error);
    return (
      target.includes(CONSTRAINT.ONE_CONFIRMED_BOOKING_PER_SLOT) ||
      target.includes(CONSTRAINT.ONE_ACTIVE_HOLD_PER_SLOT) ||
      target.includes('slotId')
    );
  }

  const sqlState = extractSqlState(error);
  if (sqlState === PG_CODE.UNIQUE_VIOLATION || sqlState === PG_CODE.EXCLUSION_VIOLATION) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes(CONSTRAINT.ONE_CONFIRMED_BOOKING_PER_SLOT) ||
      message.includes(CONSTRAINT.ONE_ACTIVE_HOLD_PER_SLOT)
    );
  }

  return false;
}

/**
 * Convert any database error into an `AppError`. Returns `null` when the error
 * is not database-shaped, so callers can fall through to generic handling.
 */
export function translatePrismaError(error: unknown): AppError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return translateKnownRequestError(error);
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return new ValidationError('The request could not be mapped onto the data model');
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new ServiceUnavailableError('Database is unavailable');
  }

  // Raw-query failures arrive as driver errors carrying a SQLSTATE. Depending
  // on the driver these are sometimes `Error` instances and sometimes plain
  // objects, so the message is read structurally rather than assumed.
  const sqlState = extractSqlState(error);
  if (sqlState) {
    return translateSqlState(sqlState, extractMessage(error));
  }

  return null;
}

/** Best-effort message extraction that works for Errors and plain objects alike. */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }

  return String(error);
}

function translateKnownRequestError(error: Prisma.PrismaClientKnownRequestError): AppError {
  const target = extractTarget(error);

  switch (error.code) {
    case 'P2002': {
      // Unique constraint violation — the interesting case.
      if (target.includes(CONSTRAINT.ONE_CONFIRMED_BOOKING_PER_SLOT)) {
        return new SlotUnavailableError('This slot has just been booked by someone else', {
          constraint: CONSTRAINT.ONE_CONFIRMED_BOOKING_PER_SLOT,
        });
      }
      if (target.includes(CONSTRAINT.ONE_ACTIVE_HOLD_PER_SLOT)) {
        return new SlotUnavailableError('This slot is currently held by another patient', {
          constraint: CONSTRAINT.ONE_ACTIVE_HOLD_PER_SLOT,
        });
      }
      if (target.includes(CONSTRAINT.UNIQUE_SLOT_START)) {
        return new ConflictError('A slot already exists at this start time for this doctor', {
          constraint: CONSTRAINT.UNIQUE_SLOT_START,
        });
      }
      if (target.includes('email')) {
        return new ConflictError('An account with this email already exists', { field: 'email' });
      }
      return new ConflictError('A record with these values already exists', { target });
    }

    case 'P2003':
      return new ValidationError('Referenced record does not exist', { target });

    case 'P2025':
      return new NotFoundError('Record');

    case 'P2034':
      // Prisma's write-conflict / deadlock wrapper.
      return new ConflictError('The operation conflicted with a concurrent change; please retry');

    case 'P1001':
    case 'P1002':
      return new ServiceUnavailableError('Database is unreachable');

    case 'P1008':
      return new ServiceUnavailableError('Database operation timed out');

    default:
      return new ConflictError('The database rejected this operation', { code: error.code });
  }
}

function translateSqlState(sqlState: string, message: string): AppError {
  switch (sqlState) {
    case PG_CODE.UNIQUE_VIOLATION:
      if (message.includes(CONSTRAINT.ONE_CONFIRMED_BOOKING_PER_SLOT)) {
        return new SlotUnavailableError('This slot has just been booked by someone else');
      }
      if (message.includes(CONSTRAINT.ONE_ACTIVE_HOLD_PER_SLOT)) {
        return new SlotUnavailableError('This slot is currently held by another patient');
      }
      return new ConflictError('A record with these values already exists');

    case PG_CODE.EXCLUSION_VIOLATION:
      if (message.includes(CONSTRAINT.NO_OVERLAPPING_SLOTS)) {
        return new ConflictError(
          'The generated slots would overlap an existing slot for this doctor',
          { constraint: CONSTRAINT.NO_OVERLAPPING_SLOTS },
        );
      }
      return new ConflictError('The operation violated an exclusion constraint');

    case PG_CODE.CHECK_VIOLATION:
      return new ValidationError('The operation violated a data integrity rule');

    case PG_CODE.FOREIGN_KEY_VIOLATION:
      return new ValidationError('Referenced record does not exist');

    case PG_CODE.SERIALIZATION_FAILURE:
    case PG_CODE.DEADLOCK_DETECTED:
      return new ConflictError('The operation conflicted with a concurrent change; please retry');

    case PG_CODE.LOCK_NOT_AVAILABLE:
      return new ConflictError('The record is locked by another operation; please retry');

    default:
      return new ConflictError('The database rejected this operation');
  }
}

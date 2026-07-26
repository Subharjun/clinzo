import { Prisma } from '@prisma/client';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SlotUnavailableError,
  UnauthorizedError,
  ValidationError,
  isAppError,
} from '../../src/utils/errors';
import {
  isRetryableDatabaseError,
  isSlotContentionError,
  translatePrismaError,
} from '../../src/utils/prisma-errors';

/**
 * The error model, and the translation from database failures into it.
 *
 * These matter because the API's contract with clients is expressed in status
 * codes and error codes — a constraint violation surfacing as a 500 would tell
 * a client to retry something that will never succeed.
 */

describe('error hierarchy', () => {
  it.each([
    [new ValidationError('bad'), 422, 'VALIDATION_ERROR'],
    [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [new NotFoundError('Slot'), 404, 'NOT_FOUND'],
    [new ConflictError('clash'), 409, 'CONFLICT'],
    [new SlotUnavailableError(), 409, 'SLOT_UNAVAILABLE'],
    [new BusinessRuleError('rule'), 422, 'BUSINESS_RULE_VIOLATION'],
  ])('%s maps to %i / %s', (error, statusCode, code) => {
    expect(error.statusCode).toBe(statusCode);
    expect(error.code).toBe(code);
    expect(error.isOperational).toBe(true);
    expect(isAppError(error)).toBe(true);
  });

  it('composes a readable not-found message', () => {
    expect(new NotFoundError('Booking').message).toBe('Booking not found');
  });

  it('carries structured details for clients to branch on', () => {
    const error = new SlotUnavailableError('gone', { slotId: 'abc' });
    expect(error.details).toEqual({ slotId: 'abc' });
  });

  it('does not classify a plain Error as an application error', () => {
    expect(isAppError(new Error('boom'))).toBe(false);
    expect(isAppError('a string')).toBe(false);
  });
});

/** Build a Prisma unique-violation error the way the client reports one. */
function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });
}

describe('translatePrismaError', () => {
  it('maps the anti-double-booking index to SLOT_UNAVAILABLE', () => {
    // The single most important mapping in the system: a lost booking race
    // must reach the client as a specific, actionable 409.
    const translated = translatePrismaError(uniqueViolation('bookings_one_confirmed_per_slot'));

    expect(translated).toBeInstanceOf(SlotUnavailableError);
    expect(translated!.statusCode).toBe(409);
    expect(translated!.code).toBe('SLOT_UNAVAILABLE');
  });

  it('maps the active-hold index to SLOT_UNAVAILABLE', () => {
    const translated = translatePrismaError(
      uniqueViolation('reservation_holds_one_active_per_slot'),
    );
    expect(translated!.code).toBe('SLOT_UNAVAILABLE');
  });

  it('maps a duplicate email to a 409 naming the field', () => {
    const translated = translatePrismaError(uniqueViolation('email'));
    expect(translated!.statusCode).toBe(409);
    expect(translated!.details).toEqual({ field: 'email' });
  });

  it('maps a missing record to 404', () => {
    const translated = translatePrismaError(
      new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    expect(translated!.statusCode).toBe(404);
  });

  it('maps a foreign-key violation to 422', () => {
    const translated = translatePrismaError(
      new Prisma.PrismaClientKnownRequestError('FK failed', {
        code: 'P2003',
        clientVersion: 'test',
        meta: { target: 'doctorId' },
      }),
    );
    expect(translated!.statusCode).toBe(422);
  });

  it('maps an unreachable database to 503, not 500', () => {
    // 503 tells a load balancer to route elsewhere; 500 does not.
    const translated = translatePrismaError(
      new Prisma.PrismaClientKnownRequestError('unreachable', {
        code: 'P1001',
        clientVersion: 'test',
      }),
    );
    expect(translated!.statusCode).toBe(503);
  });

  it('maps a raw exclusion violation to a 409 explaining the overlap', () => {
    const translated = translatePrismaError({
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint "slots_no_overlap_per_doctor"',
    });

    expect(translated!.statusCode).toBe(409);
    expect(translated!.message).toContain('overlap');
  });

  it('maps a raw check violation to 422', () => {
    const translated = translatePrismaError({
      code: '23514',
      message: 'violates check constraint "slots_positive_duration"',
    });
    expect(translated!.statusCode).toBe(422);
  });

  it('returns null for something that is not a database error', () => {
    // So the caller falls through to generic handling rather than
    // mislabelling an application bug as a database problem.
    expect(translatePrismaError(new Error('ordinary failure'))).toBeNull();
    expect(translatePrismaError('a string')).toBeNull();
  });
});

describe('isSlotContentionError', () => {
  it('recognises a lost booking race', () => {
    expect(isSlotContentionError(uniqueViolation('bookings_one_confirmed_per_slot'))).toBe(true);
    expect(isSlotContentionError(uniqueViolation('reservation_holds_one_active_per_slot'))).toBe(
      true,
    );
  });

  it('does not treat an unrelated uniqueness failure as contention', () => {
    // Miscounting these would corrupt the race-loss metric that tells us
    // whether the last line of defence is firing more than it should.
    expect(isSlotContentionError(uniqueViolation('email'))).toBe(false);
    expect(isSlotContentionError(new Error('boom'))).toBe(false);
  });
});

describe('isRetryableDatabaseError', () => {
  it('treats serialization failures and deadlocks as retryable', () => {
    expect(isRetryableDatabaseError({ code: '40001' })).toBe(true);
    expect(isRetryableDatabaseError({ code: '40P01' })).toBe(true);
  });

  it('does not treat a uniqueness violation as retryable', () => {
    // Retrying a lost booking race would loop forever: the slot stays booked.
    expect(isRetryableDatabaseError({ code: '23505' })).toBe(false);
    expect(isRetryableDatabaseError(new Error('boom'))).toBe(false);
  });
});

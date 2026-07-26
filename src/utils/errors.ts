/**
 * Application error hierarchy.
 *
 * Every error thrown by a service is one of these. The error middleware maps
 * `statusCode` straight to the HTTP response and `code` to a stable,
 * machine-readable identifier clients can branch on — response shapes never
 * depend on the message text.
 *
 * `isOperational` separates "expected, handled, describable to the caller"
 * from "we have a bug". Only the former is safe to echo back verbatim.
 */

export type ErrorDetails = Record<string, unknown> | unknown[] | undefined;

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  /** True for errors we anticipated; false means an unexpected defect. */
  readonly isOperational: boolean = true;

  /** Structured, client-safe context. Must never contain secrets or PII. */
  readonly details: ErrorDetails;

  constructor(message: string, details?: ErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

/** 400 — the request is malformed in a way schema validation cannot express. */
export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = 'BAD_REQUEST';
}

/** 401 — no credentials, or credentials that do not verify. */
export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';

  constructor(message = 'Authentication required', details?: ErrorDetails) {
    super(message, details);
  }
}

/** 403 — authenticated, but not permitted to perform this action. */
export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';

  constructor(
    message = 'You do not have permission to perform this action',
    details?: ErrorDetails,
  ) {
    super(message, details);
  }
}

/** 404 — the addressed resource does not exist (or is soft-deleted). */
export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';

  constructor(resource = 'Resource', details?: ErrorDetails) {
    super(`${resource} not found`, details);
  }
}

/**
 * 409 — the request is valid but conflicts with current state.
 * This is the canonical outcome of losing a booking race.
 */
export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

/** 409 with a specific, client-actionable code for the double-booking case. */
export class SlotUnavailableError extends AppError {
  readonly statusCode = 409;
  readonly code = 'SLOT_UNAVAILABLE';

  constructor(message = 'This slot is no longer available', details?: ErrorDetails) {
    super(message, details);
  }
}

/** 422 — syntactically valid, semantically rejected (schema/domain rules). */
export class ValidationError extends AppError {
  readonly statusCode = 422;
  readonly code = 'VALIDATION_ERROR';

  constructor(message = 'Request validation failed', details?: ErrorDetails) {
    super(message, details);
  }
}

/** 422 — an unprocessable business rule, distinct from shape validation. */
export class BusinessRuleError extends AppError {
  readonly statusCode = 422;
  readonly code = 'BUSINESS_RULE_VIOLATION';
}

/** 429 — the caller exceeded a rate limit or failed to acquire a lock in time. */
export class TooManyRequestsError extends AppError {
  readonly statusCode = 429;
  readonly code = 'TOO_MANY_REQUESTS';

  constructor(message = 'Too many requests', details?: ErrorDetails) {
    super(message, details);
  }
}

/**
 * 409 — an in-flight or completed request already used this idempotency key
 * with a different payload.
 */
export class IdempotencyConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** 503 — a dependency (Redis, Postgres, queue) is unreachable. */
export class ServiceUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly code = 'SERVICE_UNAVAILABLE';

  constructor(message = 'Service temporarily unavailable', details?: ErrorDetails) {
    super(message, details);
  }
}

/** 500 — a defect. The message is logged but never returned to the client. */
export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = 'INTERNAL_ERROR';
  override readonly isOperational = false;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

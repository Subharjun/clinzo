import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import {
  AppError,
  BadRequestError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  isAppError,
} from '../utils/errors';
import { translatePrismaError } from '../utils/prisma-errors';
import { isProduction } from '../config/env';
import type { ApiErrorResponse } from '../types';
import { formatZodIssues } from '../validators/format';

/**
 * The single place an error becomes an HTTP response.
 *
 * Design rules:
 *  - Nothing else in the codebase writes an error body. One shape, always.
 *  - Unknown errors never leak internals. A 500 says "internal error" to the
 *    client and carries the full stack only to the logs.
 *  - The request id is always echoed, so a user-reported failure can be found
 *    in the logs in one query.
 */

/** 404 for anything that reached the end of the router without matching. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl}`));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express requires the 4-arity signature to recognise this as an error
  // handler; if the response is already streaming, hand back to Express.
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = normalise(error);
  const requestId = req.requestId ?? 'unknown';

  logError(req, appError, error);

  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: appError.code,
      // A non-operational error is a defect: describe it generically.
      message: appError.isOperational ? appError.message : 'An unexpected error occurred',
      requestId,
    },
  };

  if (appError.isOperational && appError.details !== undefined) {
    body.error.details = appError.details;
  }

  // Stacks are a development affordance only; never shipped to production.
  if (!isProduction && !appError.isOperational && error instanceof Error) {
    body.error.details = { stack: error.stack?.split('\n').slice(0, 10) };
  }

  res.status(appError.statusCode).json(body);
}

/** Reduce any thrown value to an `AppError`. */
function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    // Reached only if a service validates internally; route-level bodies are
    // already converted by the validate middleware.
    return new ValidationError('Request validation failed', formatZodIssues(error));
  }

  if (error instanceof TokenExpiredError) {
    return new UnauthorizedError('Token has expired', { reason: 'token_expired' });
  }

  if (error instanceof JsonWebTokenError) {
    return new UnauthorizedError('Invalid token', { reason: 'token_invalid' });
  }

  // Body-parser rejects malformed JSON with a tagged SyntaxError.
  if (error instanceof SyntaxError && 'body' in error) {
    return new BadRequestError('Malformed JSON in request body');
  }

  const databaseError = translatePrismaError(error);
  if (databaseError) return databaseError;

  return new InternalError(error instanceof Error ? error.message : 'Unknown error');
}

function logError(req: Request, appError: AppError, original: unknown): void {
  const log = req.log ?? console;
  const context = {
    err: original,
    code: appError.code,
    statusCode: appError.statusCode,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.id ?? null,
    requestId: req.requestId,
  };

  if (!appError.isOperational || appError.statusCode >= 500) {
    // Defects and dependency failures — page-worthy.
    log.error(context, 'unhandled error');
  } else if (appError.statusCode === 429 || appError.statusCode === 409) {
    // Contention is expected under load but worth trending.
    log.warn(context, 'request rejected');
  } else {
    log.info(context, 'request failed');
  }
}

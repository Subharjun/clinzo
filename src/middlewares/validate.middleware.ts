import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, z } from 'zod';
import { ValidationError } from '../utils/errors';
import { formatZodIssues } from '../validators/format';

/**
 * Schema validation for `body`, `query` and `params`.
 *
 * Two properties worth calling out:
 *
 *  1. The *parsed* value replaces the raw input. Zod coercion and defaults are
 *     therefore visible to controllers, and — more importantly — unknown keys
 *     are stripped, so a client cannot smuggle `role: "ADMIN"` into a payload
 *     that a service later spreads into a Prisma call (mass-assignment).
 *
 *  2. All three targets are validated in one pass and reported together, so a
 *     client fixing a form sees every problem at once rather than one per
 *     round trip.
 */

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: RequestSchemas): RequestHandler {
  const composed = z.object({
    body: schemas.body ?? z.any(),
    query: schemas.query ?? z.any(),
    params: schemas.params ?? z.any(),
  });

  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = composed.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      next(new ValidationError('Request validation failed', formatZodIssues(result.error)));
      return;
    }

    if (schemas.body) req.body = result.data.body;

    // `req.query` and `req.params` are getter-only in Express 4.x when the
    // query parser is active, so assign onto the existing object rather than
    // replacing the reference.
    if (schemas.query) {
      Object.keys(req.query).forEach((key) => delete (req.query as Record<string, unknown>)[key]);
      Object.assign(req.query, result.data.query);
    }
    if (schemas.params) {
      Object.assign(req.params, result.data.params);
    }

    next();
  };
}

/**
 * Validate an arbitrary value inside a service, converting Zod failures into
 * the same `ValidationError` the HTTP layer produces.
 */
export function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError('Validation failed', formatZodIssues(error));
    }
    throw error;
  }
}

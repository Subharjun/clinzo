import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { hashRequestBody } from '../utils/crypto';
import { ConflictError, IdempotencyConflictError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Idempotency keys for unsafe operations.
 *
 * The problem: a patient taps "Book" and the response is lost to a flaky
 * mobile connection. The client retries. Without protection, the retry either
 * creates a second booking or — more likely here — hits the slot constraint
 * and reports a conflict for an appointment the patient actually holds.
 *
 * With an `Idempotency-Key` header, the retry replays the original response.
 *
 * Three cases, distinguished deliberately:
 *
 *  - Same key, same body, completed  -> replay the stored response (200/201).
 *  - Same key, same body, in flight  -> 409, tell the client to poll. Waiting
 *    would tie up a connection for an unbounded time.
 *  - Same key, DIFFERENT body        -> 422. This is a client bug: reusing a
 *    key for a different request. Silently replaying would return a response
 *    describing an operation the client did not ask for.
 *
 * Retention is 24h — comfortably longer than any realistic client retry window
 * and short enough that the table stays small.
 */

const KEY_HEADER = 'idempotency-key';
const RETENTION_HOURS = 24;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 255;

/**
 * @param required When true, the header is mandatory. Left false for booking
 *   so that adopting idempotency is not a breaking API change; clients that
 *   send a key get the guarantee, clients that do not are unaffected.
 */
export function idempotency(options: { required?: boolean } = {}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header(KEY_HEADER);

    if (!key) {
      if (options.required) {
        next(new ValidationError(`The ${KEY_HEADER} header is required for this operation`));
        return;
      }
      next();
      return;
    }

    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      next(
        new ValidationError(
          `${KEY_HEADER} must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters`,
        ),
      );
      return;
    }

    // Scoped to the user: keys are client-generated, so one client's key must
    // never collide with another's.
    const userId = req.user?.id;
    if (!userId) {
      next(new ValidationError('Idempotent requests must be authenticated'));
      return;
    }

    const endpoint = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    const requestHash = hashRequestBody(req.body);

    try {
      const existing = await prisma.idempotencyKey.findUnique({
        where: { userId_key_endpoint: { userId, key, endpoint } },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          next(
            new IdempotencyConflictError(
              `This ${KEY_HEADER} was already used with a different request body`,
              { key },
            ),
          );
          return;
        }

        if (existing.completedAt && existing.responseStatus) {
          res
            .status(existing.responseStatus)
            .setHeader('idempotency-replayed', 'true')
            .json(existing.responseBody);
          return;
        }

        next(
          new ConflictError(
            'A request with this idempotency key is still being processed; retry shortly',
            { key },
          ),
        );
        return;
      }

      // Claim the key before the handler runs. The unique constraint makes
      // this the serialisation point: two simultaneous retries race here, and
      // exactly one proceeds.
      await prisma.idempotencyKey.create({
        data: {
          key,
          userId,
          endpoint,
          requestHash,
          expiresAt: new Date(Date.now() + RETENTION_HOURS * 3_600_000),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Lost the race to claim the key — the other request is in flight.
        next(
          new ConflictError(
            'A request with this idempotency key is already being processed; retry shortly',
            { key },
          ),
        );
        return;
      }
      next(error);
      return;
    }

    req.idempotencyKey = key;
    captureResponse(req, res, { userId, key, endpoint });
    next();
  };
}

/**
 * Record the outcome so a later retry can replay it.
 *
 * Only successful responses are stored. A failed request should be genuinely
 * retryable — replaying a 500 forever would strand the client on a transient
 * error that has since cleared.
 */
function captureResponse(
  req: Request,
  res: Response,
  identity: { userId: string; key: string; endpoint: string },
): void {
  const originalJson = res.json.bind(res);

  res.json = (body: unknown): Response => {
    const status = res.statusCode;

    if (status >= 200 && status < 300) {
      void prisma.idempotencyKey
        .update({
          where: {
            userId_key_endpoint: {
              userId: identity.userId,
              key: identity.key,
              endpoint: identity.endpoint,
            },
          },
          data: {
            responseStatus: status,
            responseBody: body as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        })
        .catch((error: unknown) => {
          logger.error(
            { err: error, key: identity.key, requestId: req.requestId },
            'failed to persist idempotent response; a retry will re-execute',
          );
        });
    } else {
      // Release the key so the client can legitimately retry the operation.
      void prisma.idempotencyKey
        .delete({
          where: {
            userId_key_endpoint: {
              userId: identity.userId,
              key: identity.key,
              endpoint: identity.endpoint,
            },
          },
        })
        .catch(() => {
          // Already gone, or the row never landed. Either way it expires.
        });
    }

    return originalJson(body);
  };
}

/** Housekeeping: drop expired keys. Invoked by the maintenance job. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

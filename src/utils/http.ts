import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiSuccessResponse, PaginatedResult, PaginationParams } from '../types';

/**
 * HTTP plumbing shared by every controller.
 *
 * Express 4 does not forward rejected promises to the error middleware, so
 * every async handler must be wrapped. Doing it here — once — is what keeps
 * controllers free of try/catch noise.
 */
export function asyncHandler<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req as unknown as T, res, next)).catch(next);
  };
}

/** Send a 2xx response in the standard success envelope. */
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): void {
  const body: ApiSuccessResponse<T> = meta
    ? { success: true, data, meta }
    : { success: true, data };
  res.status(statusCode).json(body);
}

export function sendCreated<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  sendSuccess(res, data, 201, meta);
}

export function sendNoContent(res: Response): void {
  res.status(204).send();
}

/** Assemble a paginated envelope from a page of rows and a total count. */
export function paginate<T>(
  data: T[],
  total: number,
  { page, limit }: PaginationParams,
): PaginatedResult<T> {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    },
  };
}

/** Convert 1-based page/limit into a Prisma `skip`/`take` pair. */
export function toSkipTake({ page, limit }: PaginationParams): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}

/**
 * Best-effort client IP. Trusts `X-Forwarded-For` only because `trust proxy`
 * is configured on the app; Express has already validated the hop count.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

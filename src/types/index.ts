import type { Role } from '@prisma/client';
import type { Request } from 'express';

/** Claims carried by an access token. Kept minimal — tokens are not a cache. */
export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  role: Role;
  /** Domain profile id (doctorId or patientId), when the role has one. */
  profileId: string | null;
  /** Token type discriminator; prevents a refresh token being used as access. */
  typ: 'access';
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  /** Rotation family — reuse detection revokes the whole family. */
  fid: string;
  /** Opaque per-token id; hashed form is what the database stores. */
  jti: string;
  typ: 'refresh';
  iat?: number;
  exp?: number;
}

/** The authenticated principal attached to a request. */
export interface AuthenticatedUser {
  id: string;
  role: Role;
  profileId: string | null;
  email: string;
}

/**
 * Express request augmented by our middleware chain.
 * Declared as an interface (not a global `declare module`) so the extra fields
 * are explicit at every use site rather than implicitly present everywhere.
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  requestId: string;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

/** Uniform success envelope. Every 2xx body has this shape. */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

/** Uniform failure envelope. Every 4xx/5xx body has this shape. */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** A half-open UTC interval `[start, end)`. */
export interface TimeRange {
  start: Date;
  end: Date;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      requestId: string;
      /**
       * Request-scoped child logger. Provided by `pino-http`, which declares
       * the property itself; re-declaring it here would conflict.
       */
      /** Populated by the idempotency middleware for POST/PUT handlers. */
      idempotencyKey?: string;
    }
  }
}

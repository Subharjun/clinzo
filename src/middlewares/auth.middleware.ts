import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { tokenService } from '../services/token.service';
import { userRepository } from '../repositories/user.repository';

/**
 * Authentication and authorisation.
 *
 * `authenticate` is deliberately stateless — it verifies a signature and reads
 * claims, with no database round trip. That is what makes an access token
 * cheap enough to require on every request. The cost of statelessness is a
 * revocation window bounded by the 15-minute access TTL; `authenticateStrict`
 * exists for the small number of endpoints where that window is unacceptable.
 */

const BEARER_PREFIX = 'Bearer ';

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;

  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Require a valid access token. Populates `req.user`.
 * Verification errors propagate to the error middleware, which maps
 * `TokenExpiredError` to a distinct `token_expired` reason so clients know to
 * refresh rather than to re-prompt for a password.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);

  if (!token) {
    next(new UnauthorizedError('Missing bearer token', { reason: 'missing_token' }));
    return;
  }

  try {
    const payload = tokenService.verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      profileId: payload.profileId,
      // The token intentionally omits email; endpoints that need it read the
      // user record. Keeping tokens small keeps every request header small.
      email: '',
    };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * As `authenticate`, plus a database check that the account still exists and
 * is active. Reserved for high-consequence operations where honouring a token
 * issued to an account deactivated 10 minutes ago would be unacceptable.
 */
export function authenticateStrict(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearerToken(req);

    if (!token) {
      next(new UnauthorizedError('Missing bearer token', { reason: 'missing_token' }));
      return;
    }

    try {
      const payload = tokenService.verifyAccessToken(token);
      const user = await userRepository.findById(payload.sub);

      if (!user || !user.isActive) {
        next(new UnauthorizedError('Account is no longer active', { reason: 'account_inactive' }));
        return;
      }

      req.user = {
        id: user.id,
        role: user.role,
        profileId: user.doctor?.id ?? user.patient?.id ?? null,
        email: user.email,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Attach `req.user` when a token is present, but do not require one.
 * Used by endpoints whose response varies for signed-in users (e.g. the doctor
 * directory highlighting your own upcoming appointments) yet remain public.
 */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) return next();

  try {
    const payload = tokenService.verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      profileId: payload.profileId,
      email: '',
    };
  } catch {
    // A bad token on an optional path is treated as no token, not as an error.
  }
  next();
}

/**
 * Restrict a route to one or more roles.
 * Must run after `authenticate`; the missing-user branch is a wiring bug
 * guard, not an expected path.
 */
export function authorize(...allowedRoles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(
        new ForbiddenError('Your role does not permit this action', {
          requiredRoles: allowedRoles,
          actualRole: req.user.role,
        }),
      );
      return;
    }

    next();
  };
}

/**
 * Require that the caller's role carries a domain profile.
 *
 * A DOCTOR whose token has `profileId: null` cannot own availability, so this
 * turns what would be a confusing downstream null-dereference into a clear 403.
 */
export function requireProfile(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (!req.user.profileId) {
      next(new ForbiddenError('This account has no associated profile'));
      return;
    }
    next();
  };
}

/** Convenience aliases for the three role gates used across the router. */
export const requirePatient = (): RequestHandler[] => [authorize(Role.PATIENT), requireProfile()];
export const requireDoctor = (): RequestHandler[] => [authorize(Role.DOCTOR), requireProfile()];
export const requireAdmin = (): RequestHandler => authorize(Role.ADMIN);

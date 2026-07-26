import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response } from 'express';
import { redis } from '../config/redis';
import { env, isTest } from '../config/env';
import { logger } from '../utils/logger';
import type { ApiErrorResponse } from '../types';

/**
 * Rate limiting.
 *
 * Counters live in Redis, not in process memory. With N API replicas behind a
 * load balancer, an in-memory limiter permits N x the intended rate — which is
 * to say it does not limit anything. This is the single most common way rate
 * limiting is deployed broken.
 *
 * Three tiers, because the endpoints have genuinely different risk profiles:
 *
 *  - `globalLimiter`  — broad abuse protection.
 *  - `authLimiter`    — brute-force protection, keyed on IP + email so one
 *                       attacker cannot lock out every user behind a NAT.
 *  - `bookingLimiter` — inventory protection against scripted slot hoarding.
 */

/**
 * Identify the caller. Authenticated users are limited per-account so that a
 * shared corporate IP does not throttle an entire clinic; anonymous callers
 * fall back to IP.
 */
function keyForRequest(req: Request): string {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

function buildStore(prefix: string): RedisStore {
  return new RedisStore({
    // rate-limit-redis speaks the node-redis command signature; ioredis needs
    // the arguments spread.
    sendCommand: (...args: string[]) =>
      redis.call(...(args as [string, ...string[]])) as Promise<never>,
    prefix: `clinzo:ratelimit:${prefix}:`,
  });
}

function limitHandler(req: Request, res: Response): void {
  logger.warn(
    { key: keyForRequest(req), path: req.path, requestId: req.requestId },
    'rate limit exceeded',
  );

  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests; please slow down and try again shortly',
      requestId: req.requestId ?? 'unknown',
    },
  };

  res.status(429).json(body);
}

const sharedOptions = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  handler: limitHandler,
  // Tests assert on business behaviour; a limiter firing mid-suite would make
  // failures non-deterministic. Limits are exercised by their own test.
  skip: () => isTest && env.RATE_LIMIT_MAX >= 100_000,
};

/** Broad protection applied to every route. */
export const globalLimiter: RateLimitRequestHandler = rateLimit({
  ...sharedOptions,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  keyGenerator: keyForRequest,
  store: buildStore('global'),
});

/**
 * Credential-endpoint protection.
 *
 * Keyed on IP *and* submitted email: keying on email alone would let an
 * attacker lock a victim out of their own account by burning the limit;
 * keying on IP alone lets a botnet spread an attack across addresses. Both
 * together raise the cost of each strategy.
 */
export const authLimiter: RateLimitRequestHandler = rateLimit({
  ...sharedOptions,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'anonymous';
    return `${req.ip ?? 'unknown'}:${email}`;
  },
  // A correct password should not consume budget; only failures should.
  skipSuccessfulRequests: true,
  store: buildStore('auth'),
  skip: () => isTest && env.AUTH_RATE_LIMIT_MAX >= 100_000,
});

/** Inventory protection on booking and hold creation. */
export const bookingLimiter: RateLimitRequestHandler = rateLimit({
  ...sharedOptions,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.BOOKING_RATE_LIMIT_MAX,
  keyGenerator: keyForRequest,
  store: buildStore('booking'),
  skip: () => isTest && env.BOOKING_RATE_LIMIT_MAX >= 100_000,
});

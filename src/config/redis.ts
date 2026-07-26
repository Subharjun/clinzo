import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * Redis connection management.
 *
 * Three logically distinct clients, because their requirements conflict:
 *
 *  - `redis`      — general commands (cache, locks, holds, rate limiting).
 *  - `bullConnection` — BullMQ requires `maxRetriesPerRequest: null`, which we
 *                   do NOT want on the request path (there, a wedged Redis
 *                   should fail fast rather than hang the HTTP handler).
 *  - `subscriber` — a client in subscribe mode cannot issue normal commands,
 *                   so pub/sub needs its own socket.
 */

const baseOptions: RedisOptions = {
  // Fail fast on the request path: a hung Redis must not become a hung API.
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 5_000,
  // Queue commands issued before the socket is ready instead of throwing;
  // this smooths over process start-up ordering.
  enableOfflineQueue: true,
  retryStrategy(times: number): number {
    // Exponential backoff, capped, so a Redis outage does not turn into a
    // reconnect storm against a recovering node.
    const delay = Math.min(times * 200, 5_000);
    logger.warn({ attempt: times, delayMs: delay }, 'redis reconnecting');
    return delay;
  },
};

function instrument(client: Redis, name: string): Redis {
  client.on('connect', () => logger.debug({ client: name }, 'redis connecting'));
  client.on('ready', () => logger.info({ client: name }, 'redis ready'));
  client.on('error', (error: Error) => logger.error({ client: name, err: error }, 'redis error'));
  client.on('close', () => logger.warn({ client: name }, 'redis connection closed'));
  return client;
}

const globalForRedis = globalThis as unknown as {
  __clinzoRedis?: Redis;
  __clinzoRedisBull?: Redis;
  __clinzoRedisSub?: Redis;
};

export const redis: Redis =
  globalForRedis.__clinzoRedis ?? instrument(new IORedis(env.REDIS_URL, baseOptions), 'primary');

/**
 * BullMQ's blocking commands (BRPOPLPUSH etc.) must never be aborted by the
 * retry limiter, hence `maxRetriesPerRequest: null` — this is a hard library
 * requirement, not a preference.
 */
export const bullConnection: Redis =
  globalForRedis.__clinzoRedisBull ??
  instrument(
    new IORedis(env.REDIS_URL, {
      ...baseOptions,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    }),
    'bullmq',
  );

export const subscriber: Redis =
  globalForRedis.__clinzoRedisSub ??
  instrument(new IORedis(env.REDIS_URL, baseOptions), 'subscriber');

if (env.NODE_ENV !== 'production') {
  globalForRedis.__clinzoRedis = redis;
  globalForRedis.__clinzoRedisBull = bullConnection;
  globalForRedis.__clinzoRedisSub = subscriber;
}

/** Namespaced key builders — keeps key formats in exactly one place. */
export const redisKeys = {
  /** Distributed mutex guarding a single slot's booking transaction. */
  slotLock: (slotId: string) => `clinzo:lock:slot:${slotId}`,
  /** Mutex guarding slot (re)generation for one availability. */
  availabilityLock: (availabilityId: string) => `clinzo:lock:availability:${availabilityId}`,
  /** TTL-bearing reservation hold; the key's expiry IS the hold expiry. */
  hold: (slotId: string) => `clinzo:hold:slot:${slotId}`,
  /** Reverse index so a patient's holds can be listed without a scan. */
  patientHolds: (patientId: string) => `clinzo:hold:patient:${patientId}`,
  /** Cached availability listing for a doctor/day. */
  slotsCache: (doctorId: string, from: string, to: string) =>
    `clinzo:cache:slots:${doctorId}:${from}:${to}`,
  /** Version counter used for O(1) cache invalidation of a doctor's slots. */
  slotsCacheVersion: (doctorId: string) => `clinzo:cache:slots-version:${doctorId}`,
  idempotency: (userId: string, key: string) => `clinzo:idem:${userId}:${key}`,
  rateLimit: (bucket: string) => `clinzo:ratelimit:${bucket}`,
} as const;

export async function connectRedis(): Promise<void> {
  // ioredis connects lazily; a ping forces the handshake so start-up fails
  // loudly rather than on the first user request.
  await redis.ping();
  logger.info('redis connection established');
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), bullConnection.quit(), subscriber.quit()]);
  logger.info('redis connections closed');
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (error) {
    logger.error({ err: error }, 'redis health check failed');
    return false;
  }
}

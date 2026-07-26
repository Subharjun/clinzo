import { randomUUID } from 'node:crypto';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { lockAcquisitionsTotal, lockWaitDuration } from '../config/metrics';
import { TooManyRequestsError } from '../utils/errors';

/**
 * Redis-backed distributed mutex.
 *
 * ## What this lock is, and is not
 *
 * It is a *contention reducer*, not a correctness mechanism. Redlock-style
 * locks cannot be made safe under arbitrary failure — a process can be paused
 * by GC past its lock TTL and resume believing it still holds the lock. That
 * is a well-known and unfixable property of lease-based distributed locks.
 *
 * Correctness in this system comes from Postgres: `SELECT … FOR UPDATE` plus
 * the partial unique index on `bookings(slotId) WHERE status = 'CONFIRMED'`.
 * If this lock were deleted entirely, no double booking could occur — bookings
 * would simply fail more often with 409 under load.
 *
 * What the lock buys is throughput: 100 simultaneous bookers for one slot
 * serialise in Redis (microseconds) instead of piling onto a single Postgres
 * row lock and holding database connections while they wait.
 *
 * ## Safety properties that DO hold
 *
 *  - Mutual exclusion in the absence of process pauses beyond the TTL.
 *  - **Fencing on release**: a lock is released only if the stored token still
 *    matches ours, checked atomically in Lua. Without this, a slow holder
 *    whose lease expired would delete a *different* holder's lock on the way
 *    out — a far more damaging bug than the contention it was solving.
 *  - Automatic expiry: a crashed holder's lock always drains, so the system
 *    self-heals rather than deadlocking.
 */

/**
 * Compare-and-delete. GET-then-DEL is not equivalent: the lock can expire and
 * be re-acquired between the two commands, at which point the DEL frees
 * someone else's lock.
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Compare-and-extend, for work that legitimately outlives one lease. */
const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface LockOptions {
  /** Lease duration. Must exceed the worst-case critical section. */
  ttlMs?: number;
  /** Give up after this long. 0 means try once and fail immediately. */
  acquireTimeoutMs?: number;
  /** Base delay between retries; jittered to avoid thundering herds. */
  retryDelayMs?: number;
  /** Label used for metrics; keep it low-cardinality. */
  resource?: string;
}

export interface AcquiredLock {
  key: string;
  token: string;
  release: () => Promise<boolean>;
  extend: (ttlMs?: number) => Promise<boolean>;
}

export class LockService {
  /**
   * Attempt to acquire once. Returns null rather than throwing so callers can
   * choose between waiting, degrading, or failing.
   */
  async tryAcquire(key: string, ttlMs = env.LOCK_TTL_MS): Promise<AcquiredLock | null> {
    const token = randomUUID();

    // SET NX PX is a single atomic command: no check-then-act window exists.
    const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') return null;

    return this.buildHandle(key, token, ttlMs);
  }

  /**
   * Acquire, retrying with jittered backoff until the timeout elapses.
   *
   * The jitter matters: 100 clients retrying on a fixed 40ms cadence would
   * synchronise into waves that all miss. Randomising spreads them out.
   */
  async acquire(key: string, options: LockOptions = {}): Promise<AcquiredLock> {
    const ttlMs = options.ttlMs ?? env.LOCK_TTL_MS;
    const timeoutMs = options.acquireTimeoutMs ?? env.LOCK_ACQUIRE_TIMEOUT_MS;
    const retryDelayMs = options.retryDelayMs ?? env.LOCK_RETRY_DELAY_MS;
    const resource = options.resource ?? 'generic';

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    for (;;) {
      const lock = await this.tryAcquire(key, ttlMs);

      if (lock) {
        lockAcquisitionsTotal.inc({ resource, result: 'acquired' });
        lockWaitDuration.observe({ resource }, (Date.now() - startedAt) / 1000);
        return lock;
      }

      if (Date.now() >= deadline) {
        lockAcquisitionsTotal.inc({ resource, result: 'timeout' });
        lockWaitDuration.observe({ resource }, (Date.now() - startedAt) / 1000);

        throw new TooManyRequestsError('This resource is busy; please retry in a moment', {
          resource,
          waitedMs: Date.now() - startedAt,
        });
      }

      const jitter = Math.random() * retryDelayMs;
      await sleep(retryDelayMs + jitter);
    }
  }

  /**
   * Run `work` under the lock, releasing it on every exit path.
   *
   * This is the only API callers should normally use — a manual
   * acquire/release pair invites a leaked lock on the error path.
   */
  async withLock<T>(key: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
    const lock = await this.acquire(key, options);

    try {
      return await work();
    } finally {
      const released = await lock.release();
      if (!released) {
        // The lease expired before the work finished. Correctness still holds
        // (Postgres is authoritative), but it means the TTL is tuned too
        // tight for the real critical-section duration.
        logger.warn(
          { key, resource: options.resource ?? 'generic' },
          'lock lease expired before release; consider raising LOCK_TTL_MS',
        );
      }
    }
  }

  private buildHandle(key: string, token: string, ttlMs: number): AcquiredLock {
    return {
      key,
      token,
      release: async (): Promise<boolean> => {
        try {
          const result = await redis.eval(RELEASE_SCRIPT, 1, key, token);
          return result === 1;
        } catch (error) {
          // A failed release is survivable: the TTL will clear the key.
          logger.error({ err: error, key }, 'failed to release lock; relying on TTL');
          return false;
        }
      },
      extend: async (extendMs = ttlMs): Promise<boolean> => {
        const result = await redis.eval(EXTEND_SCRIPT, 1, key, token, String(extendMs));
        return result === 1;
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const lockService = new LockService();

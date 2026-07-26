import { logger } from '../../utils/logger';
import { holdService } from '../../services/hold.service';
import { reservationHoldRepository } from '../../repositories/reservation-hold.repository';

/**
 * Reservation hold expiry.
 *
 * Two entry points, deliberately redundant:
 *
 *  - `expireHold` runs from a delayed job scheduled for the hold's expiry
 *    instant. This is the fast path: the slot returns to sale within
 *    milliseconds of the hold lapsing.
 *
 *  - `sweepExpiredHolds` runs on a fixed interval and catches anything the
 *    delayed job missed — a worker that was down when the job fired, a Redis
 *    failover that lost the queue, a job that exhausted its retries.
 *
 * The redundancy is the point. A slot stuck in HELD is invisible inventory:
 * nobody can book it and nobody is told why. The sweeper guarantees the system
 * converges even when the fast path fails entirely.
 */

const SWEEP_BATCH_SIZE = 500;

export async function expireHold(holdId: string): Promise<boolean> {
  const released = await holdService.expire(holdId);

  if (released) {
    logger.info({ holdId }, 'reservation hold expired; slot returned to sale');
  }
  return released;
}

/**
 * Reconcile every hold whose lease has lapsed but whose row still says ACTIVE.
 * Idempotent — `holdService.expire` re-checks state before acting.
 */
export async function sweepExpiredHolds(): Promise<number> {
  const now = new Date();
  const lapsed = await reservationHoldRepository.findLapsed(now, SWEEP_BATCH_SIZE);

  if (lapsed.length === 0) return 0;

  let released = 0;

  for (const hold of lapsed) {
    try {
      if (await holdService.expire(hold.id)) released += 1;
    } catch (error) {
      // One stuck hold must not abort the sweep for the rest.
      logger.error({ err: error, holdId: hold.id }, 'failed to expire lapsed hold during sweep');
    }
  }

  if (released > 0) {
    logger.warn(
      { lapsed: lapsed.length, released },
      'sweeper released holds the delayed job did not — investigate if this is not near zero',
    );
  }

  return released;
}

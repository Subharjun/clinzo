import { SlotStatus, type AppointmentMode, type Slot } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { redis, redisKeys } from '../config/redis';
import { slotCacheTotal } from '../config/metrics';
import { logger } from '../utils/logger';
import { BusinessRuleError, NotFoundError } from '../utils/errors';
import { assertValidTimezone, toZonedDate, toZonedIso, toZonedTime } from '../utils/time';
import { slotRepository } from '../repositories/slot.repository';
import { doctorRepository } from '../repositories/doctor.repository';

/**
 * Patient-facing slot discovery.
 *
 * Two concerns live here that do not belong in the repository:
 *
 *  1. **Presentation timezone.** Storage is UTC; a patient in Berlin viewing a
 *     Mumbai doctor needs both renderings. Every slot is returned with its UTC
 *     instant plus a local rendering in the viewer's zone AND the doctor's, so
 *     the client never has to do timezone maths (and get it wrong).
 *
 *  2. **Caching.** Slot listings are the highest-volume read in the system and
 *     are identical for every patient looking at the same doctor and day.
 */

/** Bound on how far ahead a single query may reach; keeps responses bounded. */
const MAX_QUERY_RANGE_DAYS = 92;

export interface SlotQuery {
  doctorId: string;
  /** Inclusive UTC lower bound. */
  from: Date;
  /** Exclusive UTC upper bound. */
  to: Date;
  appointmentType?: string;
  mode?: AppointmentMode;
  /** IANA zone for the local rendering. Defaults to the doctor's. */
  viewerTimezone?: string;
}

export interface SlotView {
  id: string;
  /** Canonical UTC instants — what a client should send back when booking. */
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  appointmentType: string;
  mode: AppointmentMode;
  /** Rendered in the viewer's timezone. */
  local: {
    timezone: string;
    date: string;
    startTime: string;
    endTime: string;
    startsAt: string;
  };
  /** Rendered in the doctor's timezone — what the doctor's diary shows. */
  doctorLocal: {
    timezone: string;
    date: string;
    startTime: string;
  };
}

export interface SlotListing {
  doctorId: string;
  doctorTimezone: string;
  viewerTimezone: string;
  from: string;
  to: string;
  count: number;
  slots: SlotView[];
}

export class SlotService {
  /**
   * List bookable slots for a doctor within a window.
   *
   * Only AVAILABLE slots are returned. HELD slots are deliberately hidden
   * rather than shown as "unavailable": exposing them would leak another
   * patient's in-progress checkout, and showing a slot a patient cannot book
   * is a worse experience than not showing it at all.
   */
  async listAvailable(query: SlotQuery): Promise<SlotListing> {
    const doctor = await doctorRepository.findById(query.doctorId);
    if (!doctor) throw new NotFoundError('Doctor');

    this.assertRangeIsSane(query.from, query.to);

    const viewerTimezone = query.viewerTimezone ?? doctor.timezone;
    assertValidTimezone(viewerTimezone);

    const cached = await this.readCache(query, viewerTimezone);
    if (cached) {
      slotCacheTotal.inc({ result: 'hit' });
      return cached;
    }

    // Never offer a slot that has already started, even if the caller asked
    // for a window beginning in the past.
    const effectiveFrom = query.from > new Date() ? query.from : new Date();

    const slots = await slotRepository.findBookable({
      doctorId: query.doctorId,
      from: effectiveFrom,
      to: query.to,
      status: SlotStatus.AVAILABLE,
      ...(query.appointmentType ? { appointmentType: query.appointmentType } : {}),
      ...(query.mode ? { mode: query.mode } : {}),
    });

    const listing: SlotListing = {
      doctorId: query.doctorId,
      doctorTimezone: doctor.timezone,
      viewerTimezone,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      count: slots.length,
      slots: slots.map((slot) => this.toView(slot, viewerTimezone, doctor.timezone)),
    };

    slotCacheTotal.inc({ result: 'miss' });
    await this.writeCache(query, viewerTimezone, listing);

    return listing;
  }

  /** A doctor's own diary view — every status, not just what is for sale. */
  async listForDoctor(
    doctorId: string,
    from: Date,
    to: Date,
    status?: SlotStatus,
  ): Promise<{ slots: Slot[]; counts: Record<SlotStatus, number>; timezone: string }> {
    this.assertRangeIsSane(from, to);

    // The doctor's own zone is resolved here rather than left to the caller:
    // a diary rendered in UTC is unreadable to the person whose diary it is,
    // and pushing the conversion to the client would put timezone logic in two
    // places with two chances to disagree.
    const doctor = await doctorRepository.findById(doctorId);
    if (!doctor) throw new NotFoundError('Doctor');

    const [slots, counts] = await Promise.all([
      prisma.slot.findMany({
        where: {
          doctorId,
          startsAt: { gte: from, lt: to },
          deletedAt: null,
          ...(status ? { status } : {}),
        },
        orderBy: { startsAt: 'asc' },
      }),
      slotRepository.countByStatus(doctorId, from, to),
    ]);

    return { slots, counts, timezone: doctor.timezone };
  }

  async getById(slotId: string): Promise<Slot> {
    const slot = await slotRepository.findById(slotId);
    if (!slot) throw new NotFoundError('Slot');
    return slot;
  }

  private toView(slot: Slot, viewerTimezone: string, doctorTimezone: string): SlotView {
    return {
      id: slot.id,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      durationMinutes: slot.durationMinutes,
      appointmentType: slot.appointmentType,
      mode: slot.mode,
      local: {
        timezone: viewerTimezone,
        date: toZonedDate(slot.startsAt, viewerTimezone),
        startTime: toZonedTime(slot.startsAt, viewerTimezone),
        endTime: toZonedTime(slot.endsAt, viewerTimezone),
        startsAt: toZonedIso(slot.startsAt, viewerTimezone),
      },
      doctorLocal: {
        timezone: doctorTimezone,
        date: toZonedDate(slot.startsAt, doctorTimezone),
        startTime: toZonedTime(slot.startsAt, doctorTimezone),
      },
    };
  }

  private assertRangeIsSane(from: Date, to: Date): void {
    if (to <= from) {
      throw new BusinessRuleError('The range end must be after its start', {
        from: from.toISOString(),
        to: to.toISOString(),
      });
    }

    const days = (to.getTime() - from.getTime()) / 86_400_000;
    if (days > MAX_QUERY_RANGE_DAYS) {
      throw new BusinessRuleError(`A slot query may span at most ${MAX_QUERY_RANGE_DAYS} days`, {
        requestedDays: Math.ceil(days),
        maximumDays: MAX_QUERY_RANGE_DAYS,
      });
    }
  }

  /**
   * Cache key includes a per-doctor version counter, so invalidation is a
   * single INCR rather than a keyspace scan. Stale entries simply age out.
   */
  private async cacheKey(query: SlotQuery, viewerTimezone: string): Promise<string> {
    const version = (await redis.get(redisKeys.slotsCacheVersion(query.doctorId))) ?? '0';
    const discriminator = [
      query.from.toISOString(),
      query.to.toISOString(),
      query.appointmentType ?? 'any',
      query.mode ?? 'any',
      viewerTimezone,
      `v${version}`,
    ].join('|');

    return redisKeys.slotsCache(query.doctorId, discriminator, '');
  }

  private async readCache(query: SlotQuery, viewerTimezone: string): Promise<SlotListing | null> {
    if (env.SLOT_CACHE_TTL_SECONDS <= 0) {
      slotCacheTotal.inc({ result: 'bypass' });
      return null;
    }

    try {
      const key = await this.cacheKey(query, viewerTimezone);
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as SlotListing) : null;
    } catch (error) {
      // A cache failure must never fail a request; fall through to Postgres.
      logger.warn({ err: error, doctorId: query.doctorId }, 'slot cache read failed');
      return null;
    }
  }

  private async writeCache(
    query: SlotQuery,
    viewerTimezone: string,
    listing: SlotListing,
  ): Promise<void> {
    if (env.SLOT_CACHE_TTL_SECONDS <= 0) return;

    try {
      const key = await this.cacheKey(query, viewerTimezone);
      // A short TTL is the second line of defence behind explicit
      // invalidation: even a missed INCR self-corrects within seconds, which
      // matters because a stale listing shows a slot that is already booked.
      await redis.set(key, JSON.stringify(listing), 'EX', env.SLOT_CACHE_TTL_SECONDS);
    } catch (error) {
      logger.warn({ err: error, doctorId: query.doctorId }, 'slot cache write failed');
    }
  }
}

export const slotService = new SlotService();

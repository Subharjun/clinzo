import { AvailabilityKind } from '@prisma/client';
import {
  MINUTES_PER_DAY,
  addMinutes,
  eachLocalDate,
  localDateTimeToUtc,
  toZonedDate,
  weekdayOf,
} from '../utils/time';
import { ValidationError } from '../utils/errors';

/**
 * Slot generation — the pure core of the scheduling domain.
 *
 * Deliberately free of I/O: no Prisma, no Redis, no clock reads beyond what is
 * passed in. That makes every boundary and DST case exhaustively unit-testable
 * without a database, which is the only realistic way to have confidence in
 * arithmetic this fiddly.
 *
 * ## The generation rule
 *
 * Given a window `[start, end)` in local wall-clock minutes, a consultation
 * `duration`, and a trailing `buffer`:
 *
 *     stride = duration + buffer
 *     slot_i = [start + i*stride, start + i*stride + duration)
 *     emitted while (start + i*stride + duration) <= end
 *
 * Two consequences worth stating explicitly, because both are easy to get
 * wrong and both are asserted in the unit tests:
 *
 *  1. **A slot must fit entirely inside the window.** A 10:00–18:00 window
 *     with 50-minute consultations yields its last slot at 17:00–17:50, not a
 *     truncated 17:50–18:00. Patients are never sold a short appointment.
 *
 *  2. **Buffer is trailing, not leading, and never required after the last
 *     slot.** A 10:00–10:35 window with duration 15 / buffer 5 yields
 *     10:00–10:15 and 10:20–10:35 — the second slot fits even though there is
 *     no room for its trailing buffer, because that buffer would fall outside
 *     the window where it protects nothing.
 *
 * ## Wall-clock intent vs. elapsed duration
 *
 * Slot *starts* are wall-clock times: "10:20 on Monday" is what a patient
 * books and what a doctor agreed to. Slot *durations* are elapsed time: a
 * 15-minute consultation is 15 real minutes. These coincide except around DST
 * transitions, where the distinction matters:
 *
 *  - Spring forward: starts that fall in the skipped hour do not exist and are
 *    reported in `skippedForDstGap` rather than silently invented.
 *  - Fall back: the repeated hour resolves to its first (pre-transition)
 *    occurrence, so slots stay strictly ordered. The consequence is that the
 *    second pass through that hour yields no slots — roughly one hour of
 *    inventory is lost on that date per year, which is the accepted cost of
 *    keeping local times unambiguous.
 */

/** A generated slot as a pair of UTC instants, plus its local rendering. */
export interface GeneratedSlot {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  bufferMinutes: number;
  /** The local calendar date this slot belongs to (`YYYY-MM-DD`). */
  localDate: string;
}

export interface SlotWindow {
  /** Local calendar date the window applies to (`YYYY-MM-DD`). */
  date: string;
  /** Minutes from local midnight, inclusive. */
  startMinuteOfDay: number;
  /** Minutes from local midnight, exclusive. */
  endMinuteOfDay: number;
  timezone: string;
  slotDurationMinutes: number;
  bufferMinutes: number;
}

export interface GenerationResult {
  slots: GeneratedSlot[];
  /**
   * Local dates whose window fell wholly or partly inside a DST spring-forward
   * gap. Surfaced rather than silently dropped: a doctor who loses an hour of
   * availability twice a year deserves to be told which day it was.
   */
  skippedForDstGap: string[];
}

export interface RecurringWindowSpec {
  kind: AvailabilityKind;
  /** ONE_OFF: the concrete local date. */
  date?: string | null;
  /** RECURRING: ISO weekday 1–7. */
  weekday?: number | null;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  timezone: string;
  slotDurationMinutes: number;
  bufferMinutes: number;
  /** RECURRING: inclusive local date bounds. */
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
}

/**
 * Generate the slots for a single day's window.
 *
 * Returns an empty array (not an error) when the window is too short to hold
 * even one consultation — a 10-minute window with 15-minute appointments is a
 * legitimate configuration that simply yields nothing bookable.
 */
export function generateSlotsForWindow(window: SlotWindow): GenerationResult {
  validateWindow(window);

  const { date, startMinuteOfDay, endMinuteOfDay, timezone, slotDurationMinutes, bufferMinutes } =
    window;

  const stride = slotDurationMinutes + bufferMinutes;
  const slots: GeneratedSlot[] = [];
  const skippedForDstGap: string[] = [];

  // The instant the window closes. Slots are additionally required to end at
  // or before this, which is what keeps a slot near a DST transition from
  // running past the doctor's actual finishing time.
  const windowEndInstant = localDateTimeToUtc(date, endMinuteOfDay, timezone);

  for (
    let cursor = startMinuteOfDay;
    cursor + slotDurationMinutes <= endMinuteOfDay;
    cursor += stride
  ) {
    const startsAt = localDateTimeToUtc(date, cursor, timezone);

    // A start inside a spring-forward gap is a wall-clock time that never
    // occurs on this date. There is no instant to offer, so the slot is
    // dropped and the date reported.
    if (startsAt === null) {
      if (!skippedForDstGap.includes(date)) skippedForDstGap.push(date);
      continue;
    }

    // Duration is ELAPSED time, not a wall-clock difference. A 15-minute
    // consultation is 15 real minutes regardless of what the clock does in
    // between — deriving the end from `cursor + duration` as a wall-clock
    // minute instead would make a slot span 75 real minutes across a
    // fall-back transition, blocking the doctor for an hour they never agreed
    // to.
    const endsAt = addMinutes(startsAt, slotDurationMinutes);

    if (windowEndInstant !== null && endsAt > windowEndInstant) {
      // Fits in wall-clock arithmetic but not in real time — can only happen
      // adjacent to a transition. Dropping it is the conservative choice.
      continue;
    }

    slots.push({
      startsAt,
      endsAt,
      durationMinutes: slotDurationMinutes,
      bufferMinutes,
      localDate: date,
    });
  }

  return { slots, skippedForDstGap };
}

/**
 * Expand an availability definition into slots across a date range.
 *
 * `rangeStart`/`rangeEnd` are local dates bounding how far ahead to
 * materialise. Slots are not generated to infinity: an unbounded recurring
 * window would otherwise mean an unbounded table.
 */
export function generateSlotsForAvailability(
  spec: RecurringWindowSpec,
  rangeStart: string,
  rangeEnd: string,
): GenerationResult {
  const slots: GeneratedSlot[] = [];
  const skippedForDstGap: string[] = [];

  const dates = resolveApplicableDates(spec, rangeStart, rangeEnd);

  for (const date of dates) {
    const result = generateSlotsForWindow({
      date,
      startMinuteOfDay: spec.startMinuteOfDay,
      endMinuteOfDay: spec.endMinuteOfDay,
      timezone: spec.timezone,
      slotDurationMinutes: spec.slotDurationMinutes,
      bufferMinutes: spec.bufferMinutes,
    });

    slots.push(...result.slots);
    for (const skipped of result.skippedForDstGap) {
      if (!skippedForDstGap.includes(skipped)) skippedForDstGap.push(skipped);
    }
  }

  return { slots, skippedForDstGap };
}

/**
 * The local dates an availability applies to within `[rangeStart, rangeEnd]`.
 *
 * ONE_OFF contributes at most its own date. RECURRING contributes every
 * matching weekday, further clipped by its own effective range — so a doctor
 * who set "Mondays until 31 March" stops producing slots on 1 April without
 * anyone having to delete the record.
 */
export function resolveApplicableDates(
  spec: RecurringWindowSpec,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  if (spec.kind === AvailabilityKind.ONE_OFF) {
    if (!spec.date) {
      throw new ValidationError('A ONE_OFF availability must carry a date');
    }
    return spec.date >= rangeStart && spec.date <= rangeEnd ? [spec.date] : [];
  }

  if (spec.weekday === null || spec.weekday === undefined) {
    throw new ValidationError('A RECURRING availability must carry a weekday');
  }

  // Intersect the requested range with the recurrence's own effective bounds
  // before iterating, so a 5-year-old recurrence does not cost 1800 iterations.
  const from = maxIsoDate(rangeStart, spec.effectiveFrom ?? rangeStart);
  const until = minIsoDate(rangeEnd, spec.effectiveUntil ?? rangeEnd);

  if (from > until) return [];

  return eachLocalDate(from, until, spec.timezone).filter(
    (date) => weekdayOf(date, spec.timezone) === spec.weekday,
  );
}

/**
 * Does a UTC instant fall inside this availability's window on its own local
 * date? Used when a doctor shrinks a window, to decide whether an existing
 * slot is still covered.
 */
export function windowCoversInstant(spec: RecurringWindowSpec, instant: Date): boolean {
  const localDate = toZonedDate(instant, spec.timezone);

  if (spec.kind === AvailabilityKind.ONE_OFF) {
    if (spec.date !== localDate) return false;
  } else {
    if (weekdayOf(localDate, spec.timezone) !== spec.weekday) return false;
    if (spec.effectiveFrom && localDate < spec.effectiveFrom) return false;
    if (spec.effectiveUntil && localDate > spec.effectiveUntil) return false;
  }

  const windowStart = localDateTimeToUtc(localDate, spec.startMinuteOfDay, spec.timezone);
  const windowEnd = localDateTimeToUtc(localDate, spec.endMinuteOfDay, spec.timezone);

  if (windowStart === null || windowEnd === null) return false;

  return instant >= windowStart && instant < windowEnd;
}

/**
 * How many slots a window would produce, without building them.
 * Lets the API reject an absurd request (a 10-year recurrence at 1-minute
 * granularity) before allocating megabytes of objects.
 */
export function countSlotsForWindow(window: SlotWindow): number {
  validateWindow(window);
  const stride = window.slotDurationMinutes + window.bufferMinutes;
  const usable = window.endMinuteOfDay - window.startMinuteOfDay;

  if (usable < window.slotDurationMinutes) return 0;
  return Math.floor((usable - window.slotDurationMinutes) / stride) + 1;
}

function validateWindow(window: SlotWindow): void {
  const { startMinuteOfDay, endMinuteOfDay, slotDurationMinutes, bufferMinutes } = window;

  if (!Number.isInteger(startMinuteOfDay) || !Number.isInteger(endMinuteOfDay)) {
    throw new ValidationError('Window bounds must be whole minutes');
  }
  if (startMinuteOfDay < 0 || endMinuteOfDay > MINUTES_PER_DAY) {
    throw new ValidationError(`Window must lie within [0, ${MINUTES_PER_DAY}] minutes of the day`, {
      startMinuteOfDay,
      endMinuteOfDay,
    });
  }
  if (endMinuteOfDay <= startMinuteOfDay) {
    throw new ValidationError('Window end must be after window start', {
      startMinuteOfDay,
      endMinuteOfDay,
    });
  }
  if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes <= 0) {
    throw new ValidationError('Consultation duration must be a positive whole number of minutes', {
      slotDurationMinutes,
    });
  }
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0) {
    throw new ValidationError('Buffer must be a non-negative whole number of minutes', {
      bufferMinutes,
    });
  }
}

/** ISO dates are lexicographically ordered, so string comparison is correct. */
function maxIsoDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function minIsoDate(a: string, b: string): string {
  return a <= b ? a : b;
}

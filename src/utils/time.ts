import { DateTime, IANAZone, Interval } from 'luxon';
import { ValidationError } from './errors';

/**
 * Timezone and interval arithmetic.
 *
 * The single rule this module enforces: **instants are UTC, intent is local**.
 *
 * A doctor who says "Mondays, 10:00–18:00, Asia/Kolkata" is expressing intent
 * in wall-clock terms. The correct UTC instant for that intent changes across
 * DST boundaries, so we store the wall-clock minutes plus the IANA zone and
 * resolve to an instant per concrete date. Storing a fixed UTC offset instead
 * would silently shift every appointment by an hour twice a year.
 */

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_HOUR = 60;

/** ISO-8601 weekday numbering, matching Luxon's `weekday` and our schema. */
export const ISO_WEEKDAY = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
} as const;

/**
 * Zones accepted without an `Area/Location` structure.
 * `UTC` is unambiguous and universally understood; nothing else qualifies.
 */
const ALLOWED_BARE_ZONES = new Set(['UTC']);

/**
 * Validate an IANA timezone, rejecting ambiguous legacy abbreviations.
 *
 * The tz database still carries single-word aliases such as `IST`, `EST` and
 * `CST`, so `IANAZone.isValidZone` accepts them. They are a genuine hazard
 * here: `IST` resolves to *Israel* Standard Time (UTC+2), while almost every
 * user typing it means *India* Standard Time (UTC+5:30) — a 3.5-hour error
 * that would silently mis-time every appointment for that doctor. `CST` is
 * worse still, being claimed by three different regions.
 *
 * Requiring the `Area/Location` form makes the caller state which one they
 * mean. `UTC` is the sole exception.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  if (ALLOWED_BARE_ZONES.has(timezone)) return true;
  if (!timezone.includes('/')) return false;

  return IANAZone.isValidZone(timezone);
}

export function assertValidTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) {
    throw new ValidationError(`Unknown IANA timezone: "${timezone}"`, { timezone });
  }
}

/** Parse `"HH:mm"` into minutes from local midnight. `"10:30"` -> 630. */
export function parseTimeToMinutes(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) {
    throw new ValidationError(`Invalid time "${time}"; expected 24-hour HH:mm`, { time });
  }
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
}

/** Inverse of `parseTimeToMinutes`. 630 -> `"10:30"`. Accepts 1440 as "24:00". */
export function formatMinutesToTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new ValidationError(`Minute-of-day must be an integer in [0, ${MINUTES_PER_DAY}]`, {
      minutes,
    });
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const mins = minutes % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Resolve a local date + minute-of-day into a UTC instant.
 *
 * DST handling is explicit rather than accidental:
 *  - Spring-forward gap (e.g. 02:30 on a day where 02:00–03:00 does not exist)
 *    — Luxon returns an invalid DateTime; we surface it as a validation error
 *    so slot generation reports the skipped window instead of inventing one.
 *  - Fall-back overlap (a local time occurring twice) — Luxon resolves to the
 *    first (pre-transition) occurrence, which is the conventional choice and
 *    keeps generated slots monotonically increasing.
 */
export function localDateTimeToUtc(
  isoDate: string,
  minuteOfDay: number,
  timezone: string,
): Date | null {
  assertValidTimezone(timezone);

  const day = DateTime.fromISO(isoDate, { zone: timezone });
  if (!day.isValid) {
    throw new ValidationError(`Invalid date "${isoDate}"; expected YYYY-MM-DD`, { date: isoDate });
  }
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > MINUTES_PER_DAY) {
    throw new ValidationError(`Minute-of-day must be an integer in [0, ${MINUTES_PER_DAY}]`, {
      minuteOfDay,
    });
  }

  // 1440 means "midnight ending this day". Day arithmetic in Luxon is
  // calendar-aware, so this is correct even when the day is 23 or 25 hours.
  if (minuteOfDay === MINUTES_PER_DAY) {
    return day.startOf('day').plus({ days: 1 }).toUTC().toJSDate();
  }

  // Build from calendar components rather than by adding a duration to
  // midnight. `plus({ minutes })` measures ELAPSED time, so on a
  // spring-forward day "midnight + 180 minutes" is 04:00 local, not 03:00 —
  // which would silently shift every slot after the transition by an hour.
  const local = DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour: Math.floor(minuteOfDay / MINUTES_PER_HOUR),
      minute: minuteOfDay % MINUTES_PER_HOUR,
    },
    { zone: timezone },
  );

  if (!local.isValid) return null;

  // Luxon resolves a non-existent local time by shifting it forward out of the
  // gap rather than failing. Verify the round trip: if the resolved wall-clock
  // minute differs from the requested one, that minute did not exist on that
  // date and there is no instant to return.
  const roundTripMinutes = local.hour * MINUTES_PER_HOUR + local.minute;
  if (roundTripMinutes !== minuteOfDay) return null;

  return local.toUTC().toJSDate();
}

/** The ISO weekday (1–7) of a local calendar date. */
export function weekdayOf(isoDate: string, timezone: string): number {
  assertValidTimezone(timezone);
  const date = DateTime.fromISO(isoDate, { zone: timezone });
  if (!date.isValid) {
    throw new ValidationError(`Invalid date "${isoDate}"; expected YYYY-MM-DD`, { date: isoDate });
  }
  return date.weekday;
}

/** Every local calendar date in `[from, to]`, inclusive, as `YYYY-MM-DD`. */
export function eachLocalDate(from: string, to: string, timezone: string): string[] {
  assertValidTimezone(timezone);

  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(to, { zone: timezone }).startOf('day');

  if (!start.isValid || !end.isValid) {
    throw new ValidationError('Invalid date range; expected YYYY-MM-DD bounds', { from, to });
  }
  if (end < start) {
    throw new ValidationError('Range end must not precede range start', { from, to });
  }

  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    // `toISODate()` on a valid DateTime is always a string.
    dates.push(cursor.toISODate() as string);
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

/** Render a UTC instant as an ISO string in the viewer's timezone. */
export function toZonedIso(instant: Date, timezone: string): string {
  assertValidTimezone(timezone);
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone).toISO() as string;
}

/** The local calendar date (`YYYY-MM-DD`) a UTC instant falls on in a zone. */
export function toZonedDate(instant: Date, timezone: string): string {
  assertValidTimezone(timezone);
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone).toISODate() as string;
}

/** The local wall-clock time (`HH:mm`) a UTC instant maps to in a zone. */
export function toZonedTime(instant: Date, timezone: string): string {
  assertValidTimezone(timezone);
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone).toFormat('HH:mm');
}

/** Do half-open intervals `[aStart, aEnd)` and `[bStart, bEnd)` intersect? */
export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Is `[innerStart, innerEnd)` fully inside `[outerStart, outerEnd)`? */
export function intervalContains(
  outerStart: Date,
  outerEnd: Date,
  innerStart: Date,
  innerEnd: Date,
): boolean {
  return innerStart >= outerStart && innerEnd <= outerEnd;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function differenceInMinutes(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 60_000;
}

/** Build a Luxon Interval from two instants; useful for readable assertions. */
export function toInterval(start: Date, end: Date): Interval {
  return Interval.fromDateTimes(DateTime.fromJSDate(start), DateTime.fromJSDate(end));
}

/**
 * Current time, indirected through a function so tests can freeze the clock
 * without monkey-patching the global `Date`.
 */
export const clock = {
  now: (): Date => new Date(),
};

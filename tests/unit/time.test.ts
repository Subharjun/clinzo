import {
  addMinutes,
  eachLocalDate,
  formatMinutesToTime,
  intervalContains,
  intervalsOverlap,
  isValidTimezone,
  localDateTimeToUtc,
  parseTimeToMinutes,
  toZonedDate,
  toZonedTime,
  weekdayOf,
} from '../../src/utils/time';
import { ValidationError } from '../../src/utils/errors';

/**
 * Timezone arithmetic.
 *
 * Every case here corresponds to a way a scheduling system can silently
 * mis-time a real appointment, which is why they are asserted rather than
 * assumed.
 */

describe('parseTimeToMinutes / formatMinutesToTime', () => {
  it.each([
    ['00:00', 0],
    ['09:30', 570],
    ['10:00', 600],
    ['18:00', 1080],
    ['23:59', 1439],
  ])('parses %s to %i', (time, minutes) => {
    expect(parseTimeToMinutes(time)).toBe(minutes);
    expect(formatMinutesToTime(minutes)).toBe(time);
  });

  it.each(['24:00', '9:30', '09:60', '0930', '', 'noon', '-1:00'])('rejects %s', (invalid) => {
    expect(() => parseTimeToMinutes(invalid)).toThrow(ValidationError);
  });

  it('renders the end-of-day boundary as 24:00', () => {
    expect(formatMinutesToTime(1440)).toBe('24:00');
  });

  it('rejects a minute-of-day outside the day', () => {
    expect(() => formatMinutesToTime(1441)).toThrow(ValidationError);
    expect(() => formatMinutesToTime(-1)).toThrow(ValidationError);
  });
});

describe('isValidTimezone', () => {
  it.each(['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney'])(
    'accepts %s',
    (zone) => {
      expect(isValidTimezone(zone)).toBe(true);
    },
  );

  it.each(['Mars/Olympus', 'GMT+5:30', '', 'Asia/Nowhere', 'Europe/Nowhere'])(
    'rejects %s',
    (zone) => {
      expect(isValidTimezone(zone)).toBe(false);
    },
  );

  it.each(['IST', 'EST', 'CST', 'MST', 'CET'])(
    'rejects the ambiguous legacy abbreviation %s',
    (zone) => {
      // These are real tz-database aliases, so Luxon accepts them — but `IST`
      // is Israel, not India, and `CST` is claimed by three regions. Silently
      // accepting one would mis-time every appointment for that doctor.
      expect(isValidTimezone(zone)).toBe(false);
    },
  );
});

describe('localDateTimeToUtc', () => {
  it('applies a fixed offset correctly', () => {
    // Asia/Kolkata is UTC+5:30 all year.
    expect(localDateTimeToUtc('2026-03-02', 600, 'Asia/Kolkata')?.toISOString()).toBe(
      '2026-03-02T04:30:00.000Z',
    );
  });

  it('tracks a daylight-saving offset change for the same local time', () => {
    // 09:00 New York is UTC-5 in winter and UTC-4 in summer.
    expect(localDateTimeToUtc('2026-01-15', 540, 'America/New_York')?.toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    expect(localDateTimeToUtc('2026-07-15', 540, 'America/New_York')?.toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
  });

  it('returns null for a local time inside a spring-forward gap', () => {
    // 2026-03-08: New York jumps 02:00 -> 03:00.
    expect(localDateTimeToUtc('2026-03-08', 120, 'America/New_York')).toBeNull();
    expect(localDateTimeToUtc('2026-03-08', 150, 'America/New_York')).toBeNull();
    // The minutes either side of the gap are real.
    expect(localDateTimeToUtc('2026-03-08', 90, 'America/New_York')).not.toBeNull();
    expect(localDateTimeToUtc('2026-03-08', 180, 'America/New_York')).not.toBeNull();
  });

  it('resolves an ambiguous fall-back time to its first occurrence', () => {
    // 2026-11-01: New York repeats 01:00-02:00. The earlier (EDT, UTC-4)
    // instant is chosen, which keeps generated slots monotonically ordered.
    expect(localDateTimeToUtc('2026-11-01', 90, 'America/New_York')?.toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('treats minute 1440 as midnight ending the day', () => {
    const endOfDay = localDateTimeToUtc('2026-03-02', 1440, 'Asia/Kolkata');
    const nextMidnight = localDateTimeToUtc('2026-03-03', 0, 'Asia/Kolkata');
    expect(endOfDay?.toISOString()).toBe(nextMidnight?.toISOString());
  });

  it('rejects an invalid date or minute', () => {
    expect(() => localDateTimeToUtc('not-a-date', 600, 'UTC')).toThrow(ValidationError);
    expect(() => localDateTimeToUtc('2026-03-02', 1441, 'UTC')).toThrow(ValidationError);
    expect(() => localDateTimeToUtc('2026-03-02', 600, 'Mars/Olympus')).toThrow(ValidationError);
  });
});

describe('weekdayOf', () => {
  it('uses ISO numbering with Monday as 1', () => {
    expect(weekdayOf('2026-03-02', 'UTC')).toBe(1); // Monday
    expect(weekdayOf('2026-03-08', 'UTC')).toBe(7); // Sunday
  });

  it('can differ between zones for the same instant-adjacent date', () => {
    // 2026-03-01 is a Sunday everywhere, but the point is that weekday is
    // computed in the given zone rather than the server's.
    expect(weekdayOf('2026-03-01', 'Asia/Kolkata')).toBe(7);
    expect(weekdayOf('2026-03-01', 'America/New_York')).toBe(7);
  });
});

describe('eachLocalDate', () => {
  it('includes both endpoints', () => {
    expect(eachLocalDate('2026-03-01', '2026-03-04', 'UTC')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
  });

  it('returns a single date when the range is one day', () => {
    expect(eachLocalDate('2026-03-01', '2026-03-01', 'UTC')).toEqual(['2026-03-01']);
  });

  it('spans a month boundary', () => {
    expect(eachLocalDate('2026-02-27', '2026-03-02', 'UTC')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('produces the right number of days across a DST transition', () => {
    // Day arithmetic must be calendar-aware, not 86,400,000ms-aware: the day
    // of a transition is 23 or 25 hours long.
    const dates = eachLocalDate('2026-03-06', '2026-03-10', 'America/New_York');
    expect(dates).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('rejects a reversed range', () => {
    expect(() => eachLocalDate('2026-03-04', '2026-03-01', 'UTC')).toThrow(ValidationError);
  });
});

describe('toZonedDate / toZonedTime', () => {
  it('renders one instant differently per zone', () => {
    // 2026-03-02T19:00Z is still the 2nd in New York but already the 3rd in
    // Kolkata — the exact situation that breaks naive date handling.
    const instant = new Date('2026-03-02T19:00:00.000Z');

    expect(toZonedDate(instant, 'America/New_York')).toBe('2026-03-02');
    expect(toZonedTime(instant, 'America/New_York')).toBe('14:00');

    expect(toZonedDate(instant, 'Asia/Kolkata')).toBe('2026-03-03');
    expect(toZonedTime(instant, 'Asia/Kolkata')).toBe('00:30');
  });
});

describe('interval helpers', () => {
  const at = (hour: number) => new Date(`2026-03-02T${String(hour).padStart(2, '0')}:00:00.000Z`);

  it('treats intervals as half-open when testing overlap', () => {
    // [10,11) and [11,12) touch but do not overlap — this is what allows
    // back-to-back slots to exist at all.
    expect(intervalsOverlap(at(10), at(11), at(11), at(12))).toBe(false);
    expect(intervalsOverlap(at(10), at(12), at(11), at(13))).toBe(true);
    expect(intervalsOverlap(at(10), at(12), at(9), at(11))).toBe(true);
    // Full containment counts as overlap.
    expect(intervalsOverlap(at(10), at(14), at(11), at(12))).toBe(true);
  });

  it('tests containment inclusively at both ends', () => {
    expect(intervalContains(at(10), at(18), at(10), at(11))).toBe(true);
    expect(intervalContains(at(10), at(18), at(17), at(18))).toBe(true);
    expect(intervalContains(at(10), at(18), at(17), at(19))).toBe(false);
    expect(intervalContains(at(10), at(18), at(9), at(11))).toBe(false);
  });

  it('adds elapsed minutes', () => {
    expect(addMinutes(at(10), 15).toISOString()).toBe('2026-03-02T10:15:00.000Z');
    expect(addMinutes(at(10), -30).toISOString()).toBe('2026-03-02T09:30:00.000Z');
  });
});

import { AvailabilityKind } from '@prisma/client';
import {
  countSlotsForWindow,
  generateSlotsForAvailability,
  generateSlotsForWindow,
  resolveApplicableDates,
  windowCoversInstant,
  type RecurringWindowSpec,
  type SlotWindow,
} from '../../src/services/slot-generator';
import { parseTimeToMinutes, toZonedTime } from '../../src/utils/time';
import { ValidationError } from '../../src/utils/errors';

/**
 * Slot generation is the arithmetic everything else in the system trusts.
 * These tests pin the boundary behaviour precisely, because an off-by-one here
 * either sells patients appointments that run past a doctor's day, or silently
 * destroys bookable inventory.
 */

const IST = 'Asia/Kolkata';
const UTC = 'UTC';
const NEW_YORK = 'America/New_York';

function window(overrides: Partial<SlotWindow> = {}): SlotWindow {
  return {
    date: '2026-03-02',
    startMinuteOfDay: parseTimeToMinutes('10:00'),
    endMinuteOfDay: parseTimeToMinutes('18:00'),
    timezone: UTC,
    slotDurationMinutes: 15,
    bufferMinutes: 0,
    ...overrides,
  };
}

/** Render generated slots as local `HH:mm-HH:mm` pairs for readable assertions. */
function asLocalTimes(slots: { startsAt: Date; endsAt: Date }[], timezone: string): string[] {
  return slots.map(
    (s) => `${toZonedTime(s.startsAt, timezone)}-${toZonedTime(s.endsAt, timezone)}`,
  );
}

describe('generateSlotsForWindow', () => {
  it('divides a window into contiguous slots when there is no buffer', () => {
    const { slots } = generateSlotsForWindow(
      window({ startMinuteOfDay: 600, endMinuteOfDay: 660, slotDurationMinutes: 15 }),
    );

    expect(asLocalTimes(slots, UTC)).toEqual([
      '10:00-10:15',
      '10:15-10:30',
      '10:30-10:45',
      '10:45-11:00',
    ]);
  });

  it('applies the buffer as a gap between consecutive slots', () => {
    // The assignment's worked example: 15-minute consultations, 5-minute
    // buffer, producing starts at 10:00, 10:20, 10:40.
    const { slots } = generateSlotsForWindow(
      window({
        startMinuteOfDay: 600,
        endMinuteOfDay: 660,
        slotDurationMinutes: 15,
        bufferMinutes: 5,
      }),
    );

    expect(slots.map((s) => toZonedTime(s.startsAt, UTC))).toEqual(['10:00', '10:20', '10:40']);
    expect(asLocalTimes(slots, UTC)).toEqual(['10:00-10:15', '10:20-10:35', '10:40-10:55']);
  });

  it('never emits a slot that would run past the end of the window', () => {
    // 10:00-17:00 is 420 minutes; 50-minute consultations fit 8 times (400
    // minutes), leaving 20 minutes that must NOT become a short appointment.
    const { slots } = generateSlotsForWindow(
      window({ startMinuteOfDay: 600, endMinuteOfDay: 1020, slotDurationMinutes: 50 }),
    );

    expect(slots).toHaveLength(8);
    const last = slots[slots.length - 1]!;
    // Last slot is 15:50-16:40; the remaining 20 minutes stay unsold rather
    // than becoming a truncated appointment.
    expect(toZonedTime(last.startsAt, UTC)).toBe('15:50');
    expect(toZonedTime(last.endsAt, UTC)).toBe('16:40');
    expect(slots.every((s) => s.endsAt.getTime() - s.startsAt.getTime() === 50 * 60_000)).toBe(
      true,
    );
  });

  it('emits a final slot that fits even when its trailing buffer would not', () => {
    // 10:00-10:35 with duration 15 + buffer 5: the second slot ends exactly at
    // 10:35. Requiring room for its trailing buffer would wrongly drop it.
    const { slots } = generateSlotsForWindow(
      window({
        startMinuteOfDay: 600,
        endMinuteOfDay: 635,
        slotDurationMinutes: 15,
        bufferMinutes: 5,
      }),
    );

    expect(asLocalTimes(slots, UTC)).toEqual(['10:00-10:15', '10:20-10:35']);
  });

  it('produces no slots when the window is shorter than one consultation', () => {
    const { slots } = generateSlotsForWindow(
      window({ startMinuteOfDay: 600, endMinuteOfDay: 610, slotDurationMinutes: 15 }),
    );
    expect(slots).toEqual([]);
  });

  it('produces exactly one slot when the window fits it precisely', () => {
    const { slots } = generateSlotsForWindow(
      window({ startMinuteOfDay: 600, endMinuteOfDay: 615, slotDurationMinutes: 15 }),
    );
    expect(asLocalTimes(slots, UTC)).toEqual(['10:00-10:15']);
  });

  it('generates non-overlapping slots for every duration/buffer combination', () => {
    for (const duration of [5, 10, 15, 20, 30, 45, 50, 60, 90]) {
      for (const buffer of [0, 5, 10, 15]) {
        const { slots } = generateSlotsForWindow(
          window({ slotDurationMinutes: duration, bufferMinutes: buffer }),
        );

        for (let i = 1; i < slots.length; i += 1) {
          const previous = slots[i - 1]!;
          const current = slots[i]!;
          expect(current.startsAt.getTime()).toBeGreaterThanOrEqual(previous.endsAt.getTime());
          expect(current.startsAt.getTime() - previous.endsAt.getTime()).toBe(buffer * 60_000);
        }
      }
    }
  });

  it('agrees with countSlotsForWindow without materialising the slots', () => {
    for (const duration of [7, 15, 20, 45]) {
      for (const buffer of [0, 3, 10]) {
        const spec = window({ slotDurationMinutes: duration, bufferMinutes: buffer });
        expect(countSlotsForWindow(spec)).toBe(generateSlotsForWindow(spec).slots.length);
      }
    }
  });

  describe('timezone handling', () => {
    it('resolves local wall-clock times to the correct UTC instants', () => {
      // Asia/Kolkata is UTC+5:30 year-round: 10:00 IST is 04:30 UTC.
      const { slots } = generateSlotsForWindow(
        window({ timezone: IST, startMinuteOfDay: 600, endMinuteOfDay: 630 }),
      );

      expect(slots).toHaveLength(2);
      expect(slots[0]!.startsAt.toISOString()).toBe('2026-03-02T04:30:00.000Z');
      expect(slots[1]!.startsAt.toISOString()).toBe('2026-03-02T04:45:00.000Z');
    });

    it('keeps the same local time across a DST transition', () => {
      // US DST began 2026-03-08. A 09:00 New York window is 14:00Z before the
      // transition and 13:00Z after it — storing a fixed offset would drift.
      const before = generateSlotsForWindow(
        window({
          date: '2026-03-06',
          timezone: NEW_YORK,
          startMinuteOfDay: 540,
          endMinuteOfDay: 555,
        }),
      );
      const after = generateSlotsForWindow(
        window({
          date: '2026-03-10',
          timezone: NEW_YORK,
          startMinuteOfDay: 540,
          endMinuteOfDay: 555,
        }),
      );

      expect(before.slots[0]!.startsAt.toISOString()).toBe('2026-03-06T14:00:00.000Z');
      expect(after.slots[0]!.startsAt.toISOString()).toBe('2026-03-10T13:00:00.000Z');

      // Same local wall-clock time in both cases — that is the invariant.
      expect(toZonedTime(before.slots[0]!.startsAt, NEW_YORK)).toBe('09:00');
      expect(toZonedTime(after.slots[0]!.startsAt, NEW_YORK)).toBe('09:00');
    });

    it('skips local times that do not exist in a spring-forward gap', () => {
      // On 2026-03-08 New York jumps 02:00 -> 03:00; 02:00-02:59 never occurs.
      const { slots, skippedForDstGap } = generateSlotsForWindow(
        window({
          date: '2026-03-08',
          timezone: NEW_YORK,
          startMinuteOfDay: parseTimeToMinutes('01:30'),
          endMinuteOfDay: parseTimeToMinutes('03:30'),
          slotDurationMinutes: 30,
        }),
      );

      const localStarts = slots.map((s) => toZonedTime(s.startsAt, NEW_YORK));
      // 02:00 and 02:30 never occur on this date, so no slot may start there.
      expect(localStarts).not.toContain('02:00');
      expect(localStarts).not.toContain('02:30');
      expect(skippedForDstGap).toContain('2026-03-08');
      // The real wall-clock times on either side of the gap still generate.
      expect(localStarts).toEqual(['01:30', '03:00']);

      // Every surviving slot is exactly 30 real minutes, and they do not
      // overlap in instant space even though their labels jump an hour.
      expect(slots[0]!.startsAt.toISOString()).toBe('2026-03-08T06:30:00.000Z');
      expect(slots[0]!.endsAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
      expect(slots[1]!.startsAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
      expect(slots[1]!.endsAt.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    });

    it('gives every slot exactly its configured duration in real elapsed time', () => {
      // Across a fall-back, wall-clock subtraction would report 75 minutes for
      // a 30-minute consultation. Durations must be elapsed time, not labels.
      const { slots } = generateSlotsForWindow(
        window({
          date: '2026-11-01',
          timezone: NEW_YORK,
          startMinuteOfDay: parseTimeToMinutes('00:00'),
          endMinuteOfDay: parseTimeToMinutes('04:00'),
          slotDurationMinutes: 30,
        }),
      );

      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(slot.endsAt.getTime() - slot.startsAt.getTime()).toBe(30 * 60_000);
      }
    });

    it('keeps slots strictly ordered and positive-length through a fall-back overlap', () => {
      // On 2026-11-01 New York repeats 01:00-02:00.
      const { slots } = generateSlotsForWindow(
        window({
          date: '2026-11-01',
          timezone: NEW_YORK,
          startMinuteOfDay: parseTimeToMinutes('00:30'),
          endMinuteOfDay: parseTimeToMinutes('03:30'),
          slotDurationMinutes: 30,
        }),
      );

      for (let i = 0; i < slots.length; i += 1) {
        expect(slots[i]!.endsAt.getTime()).toBeGreaterThan(slots[i]!.startsAt.getTime());
        if (i > 0) {
          expect(slots[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(
            slots[i - 1]!.endsAt.getTime(),
          );
        }
      }
    });
  });

  describe('input validation', () => {
    it.each([
      ['end before start', { startMinuteOfDay: 660, endMinuteOfDay: 600 }],
      ['end equal to start', { startMinuteOfDay: 600, endMinuteOfDay: 600 }],
      ['negative start', { startMinuteOfDay: -1 }],
      ['end past midnight', { endMinuteOfDay: 1441 }],
      ['zero duration', { slotDurationMinutes: 0 }],
      ['negative duration', { slotDurationMinutes: -15 }],
      ['negative buffer', { bufferMinutes: -5 }],
      ['fractional duration', { slotDurationMinutes: 12.5 }],
    ])('rejects %s', (_label, overrides) => {
      expect(() => generateSlotsForWindow(window(overrides as Partial<SlotWindow>))).toThrow(
        ValidationError,
      );
    });
  });
});

describe('resolveApplicableDates', () => {
  const recurring: RecurringWindowSpec = {
    kind: AvailabilityKind.RECURRING,
    weekday: 1, // Monday
    startMinuteOfDay: 600,
    endMinuteOfDay: 1080,
    timezone: UTC,
    slotDurationMinutes: 15,
    bufferMinutes: 5,
  };

  it('selects only the matching weekday within the range', () => {
    const dates = resolveApplicableDates(recurring, '2026-03-01', '2026-03-31');
    expect(dates).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']);
  });

  it('clips the recurrence to its own effective bounds', () => {
    const dates = resolveApplicableDates(
      { ...recurring, effectiveFrom: '2026-03-09', effectiveUntil: '2026-03-17' },
      '2026-03-01',
      '2026-03-31',
    );
    expect(dates).toEqual(['2026-03-09', '2026-03-16']);
  });

  it('returns nothing when the effective range and query range are disjoint', () => {
    const dates = resolveApplicableDates(
      { ...recurring, effectiveUntil: '2026-02-01' },
      '2026-03-01',
      '2026-03-31',
    );
    expect(dates).toEqual([]);
  });

  it('returns a one-off date only when it falls inside the range', () => {
    const oneOff: RecurringWindowSpec = {
      ...recurring,
      kind: AvailabilityKind.ONE_OFF,
      weekday: null,
      date: '2026-03-15',
    };

    expect(resolveApplicableDates(oneOff, '2026-03-01', '2026-03-31')).toEqual(['2026-03-15']);
    expect(resolveApplicableDates(oneOff, '2026-04-01', '2026-04-30')).toEqual([]);
  });

  it('rejects a recurring definition with no weekday', () => {
    expect(() =>
      resolveApplicableDates({ ...recurring, weekday: null }, '2026-03-01', '2026-03-31'),
    ).toThrow(ValidationError);
  });
});

describe('generateSlotsForAvailability', () => {
  it('materialises every occurrence of a recurring window across a range', () => {
    const spec: RecurringWindowSpec = {
      kind: AvailabilityKind.RECURRING,
      weekday: 1,
      startMinuteOfDay: 600,
      endMinuteOfDay: 660,
      timezone: IST,
      slotDurationMinutes: 15,
      bufferMinutes: 5,
    };

    const { slots } = generateSlotsForAvailability(spec, '2026-03-01', '2026-03-16');

    // 3 Mondays in range x 3 slots per Monday.
    expect(slots).toHaveLength(9);
    expect(slots.every((s) => toZonedTime(s.startsAt, IST).startsWith('10:'))).toBe(true);

    const localDates = [...new Set(slots.map((s) => s.localDate))];
    expect(localDates).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
  });

  it('produces slots in strictly ascending instant order', () => {
    const spec: RecurringWindowSpec = {
      kind: AvailabilityKind.RECURRING,
      weekday: 3,
      startMinuteOfDay: 540,
      endMinuteOfDay: 1020,
      timezone: NEW_YORK,
      slotDurationMinutes: 20,
      bufferMinutes: 10,
    };

    const { slots } = generateSlotsForAvailability(spec, '2026-02-01', '2026-04-30');

    expect(slots.length).toBeGreaterThan(50);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.startsAt.getTime()).toBeGreaterThan(slots[i - 1]!.startsAt.getTime());
    }
  });
});

describe('windowCoversInstant', () => {
  const spec: RecurringWindowSpec = {
    kind: AvailabilityKind.RECURRING,
    weekday: 1,
    startMinuteOfDay: parseTimeToMinutes('10:00'),
    endMinuteOfDay: parseTimeToMinutes('18:00'),
    timezone: IST,
    slotDurationMinutes: 15,
    bufferMinutes: 0,
  };

  it('accepts an instant inside the window on a matching weekday', () => {
    // 2026-03-02 is a Monday; 11:00 IST = 05:30 UTC.
    expect(windowCoversInstant(spec, new Date('2026-03-02T05:30:00.000Z'))).toBe(true);
  });

  it('rejects an instant before the window opens', () => {
    // 09:00 IST = 03:30 UTC.
    expect(windowCoversInstant(spec, new Date('2026-03-02T03:30:00.000Z'))).toBe(false);
  });

  it('treats the window as half-open at its end', () => {
    // Exactly 18:00 IST = 12:30 UTC is outside `[start, end)`.
    expect(windowCoversInstant(spec, new Date('2026-03-02T12:30:00.000Z'))).toBe(false);
    // One minute earlier is inside.
    expect(windowCoversInstant(spec, new Date('2026-03-02T12:29:00.000Z'))).toBe(true);
  });

  it('rejects an instant on a non-matching weekday', () => {
    // 2026-03-03 is a Tuesday.
    expect(windowCoversInstant(spec, new Date('2026-03-03T05:30:00.000Z'))).toBe(false);
  });

  it('respects the effective range of the recurrence', () => {
    const bounded = { ...spec, effectiveFrom: '2026-03-09' };
    expect(windowCoversInstant(bounded, new Date('2026-03-02T05:30:00.000Z'))).toBe(false);
    expect(windowCoversInstant(bounded, new Date('2026-03-09T05:30:00.000Z'))).toBe(true);
  });
});

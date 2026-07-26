import request from 'supertest';
import type { Application } from 'express';
import { SlotStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import { tokenService } from '../../src/services/token.service';
import { bookingService } from '../../src/services/booking.service';
import { toZonedTime } from '../../src/utils/time';
import {
  createDoctor,
  createPatient,
  resetAll,
  teardown,
  type DoctorFixture,
} from '../helpers/database';

/**
 * Availability management and slot materialisation.
 *
 * The most important block here is `retroactive availability changes` — it
 * pins the policy that a doctor shrinking their hours never silently cancels a
 * patient's confirmed appointment.
 */

let app: Application;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await teardown();
});

function doctorToken(fixture: DoctorFixture): string {
  return tokenService.signAccessToken({
    userId: fixture.userId,
    role: 'DOCTOR',
    profileId: fixture.doctor.id,
  });
}

/** A weekday that is comfortably inside the generation horizon. */
function upcomingWeekday(timezone: string, weekday: number): DateTime {
  let cursor = DateTime.now().setZone(timezone).plus({ days: 1 }).startOf('day');
  while (cursor.weekday !== weekday) cursor = cursor.plus({ days: 1 });
  return cursor;
}

describe('POST /availability', () => {
  it('generates slots at the configured duration and buffer', async () => {
    const doctor = await createDoctor({ timezone: 'Asia/Kolkata' });

    const response = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 1,
        startTime: '10:00',
        endTime: '18:00',
        slotDurationMinutes: 15,
        bufferMinutes: 5,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.availability.startTime).toBe('10:00');
    expect(response.body.data.availability.endTime).toBe('18:00');
    expect(response.body.data.slotsGenerated).toBeGreaterThan(0);

    const slots = await prisma.slot.findMany({
      where: { doctorId: doctor.doctor.id },
      orderBy: { startsAt: 'asc' },
    });

    // 10:00-18:00 with a 20-minute stride yields 24 slots per Monday.
    const perDay = new Map<string, number>();
    for (const slot of slots) {
      const date = toZonedTime(slot.startsAt, 'Asia/Kolkata');
      perDay.set(date, (perDay.get(date) ?? 0) + 1);
    }

    // The worked example from the brief: starts at 10:00, 10:20, 10:40.
    const firstThree = slots.slice(0, 3).map((s) => toZonedTime(s.startsAt, 'Asia/Kolkata'));
    expect(firstThree).toEqual(['10:00', '10:20', '10:40']);

    expect(slots.every((slot) => slot.durationMinutes === 15)).toBe(true);
    expect(slots.every((slot) => slot.bufferMinutes === 5)).toBe(true);
    expect(slots.every((slot) => slot.status === SlotStatus.AVAILABLE)).toBe(true);
  });

  it('materialises the doctor local time, not the server local time', async () => {
    const doctor = await createDoctor({ timezone: 'America/New_York' });

    await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 3,
        startTime: '09:00',
        endTime: '10:00',
        slotDurationMinutes: 30,
      })
      .expect(201);

    const slots = await prisma.slot.findMany({ where: { doctorId: doctor.doctor.id } });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(['09:00', '09:30']).toContain(toZonedTime(slot.startsAt, 'America/New_York'));
    }
  });

  it('rejects a window that overlaps an existing one', async () => {
    const doctor = await createDoctor();
    const token = doctorToken(doctor);

    await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${token}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '10:00', endTime: '14:00' })
      .expect(201);

    const overlap = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${token}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '13:00', endTime: '18:00' });

    expect(overlap.status).toBe(409);
  });

  it('allows adjacent windows that merely touch', async () => {
    // Half-open intervals: [10:00, 14:00) and [14:00, 18:00) do not overlap.
    const doctor = await createDoctor();
    const token = doctorToken(doctor);

    await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${token}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '10:00', endTime: '14:00' })
      .expect(201);

    await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${token}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '14:00', endTime: '18:00' })
      .expect(201);
  });

  it('rejects a window too short to hold a single consultation', async () => {
    const doctor = await createDoctor();

    const response = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 1,
        startTime: '10:00',
        endTime: '10:10',
        slotDurationMinutes: 15,
      });

    expect(response.status).toBe(422);
  });

  it('rejects a one-off window carrying a weekday, and vice versa', async () => {
    const doctor = await createDoctor();
    const token = doctorToken(doctor);

    const badOneOff = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${token}`)
      .send({ kind: 'ONE_OFF', weekday: 1, startTime: '10:00', endTime: '18:00' });
    expect(badOneOff.status).toBe(422);

    const badRecurring = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${token}`)
      .send({ kind: 'RECURRING', date: '2026-03-02', startTime: '10:00', endTime: '18:00' });
    expect(badRecurring.status).toBe(422);
  });

  it('refuses a configuration that would generate an unreasonable number of slots', async () => {
    const doctor = await createDoctor();

    const response = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 1,
        startTime: '00:00',
        endTime: '23:59',
        slotDurationMinutes: 5,
        bufferMinutes: 0,
        horizonDays: 365,
      });

    // Either the size guard (422) or the schema fires; both are acceptable
    // refusals, but it must not succeed and materialise ~100k rows.
    expect([422, 409]).toContain(response.status);
  });
});

describe('PUT /availability/:id — retroactive changes', () => {
  /**
   * Set up a doctor with a 10:00-18:00 Monday window, one materialised slot at
   * 15:00 that a patient has booked, and one free slot at 16:00.
   */
  async function bookedScheduleFixture() {
    const doctor = await createDoctor({ timezone: 'Asia/Kolkata' });
    const patient = await createPatient();

    const created = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 1,
        startTime: '10:00',
        endTime: '18:00',
        slotDurationMinutes: 60,
        bufferMinutes: 0,
      })
      .expect(201);

    const availabilityId = created.body.data.availability.id as string;
    const version = created.body.data.availability.version as number;

    const monday = upcomingWeekday('Asia/Kolkata', 1);
    const at = (hour: number) => monday.set({ hour }).toUTC().toJSDate();

    const bookedSlot = await prisma.slot.findFirstOrThrow({
      where: { doctorId: doctor.doctor.id, startsAt: at(15) },
    });
    const freeSlot = await prisma.slot.findFirstOrThrow({
      where: { doctorId: doctor.doctor.id, startsAt: at(16) },
    });

    const booking = await bookingService.create(
      { slotId: bookedSlot.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    return { doctor, patient, availabilityId, version, bookedSlot, freeSlot, booking };
  }

  it('blocks future unbooked slots that fall outside the new window', async () => {
    const fixture = await bookedScheduleFixture();

    const response = await request(app)
      .put(`/api/v1/availability/${fixture.availabilityId}`)
      .set('authorization', `Bearer ${doctorToken(fixture.doctor)}`)
      // Shrink 10:00-18:00 down to 10:00-14:00.
      .send({ startTime: '10:00', endTime: '14:00', version: fixture.version });

    expect(response.status).toBe(200);
    expect(response.body.data.slotsBlocked).toBeGreaterThan(0);

    const freeSlot = await prisma.slot.findUniqueOrThrow({ where: { id: fixture.freeSlot.id } });
    expect(freeSlot.status).toBe(SlotStatus.BLOCKED);
    expect(freeSlot.blockedReason).toBe('availability_changed');
  });

  it('never cancels a confirmed booking, and reports it as orphaned instead', async () => {
    // This is the core policy assertion of the whole retroactive-change story.
    const fixture = await bookedScheduleFixture();

    const response = await request(app)
      .put(`/api/v1/availability/${fixture.availabilityId}`)
      .set('authorization', `Bearer ${doctorToken(fixture.doctor)}`)
      .send({ startTime: '10:00', endTime: '14:00', version: fixture.version })
      .expect(200);

    // The booking survives, untouched.
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: fixture.booking.id },
    });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.cancelledAt).toBeNull();

    // The slot stays BOOKED rather than being blocked out from under it.
    const slot = await prisma.slot.findUniqueOrThrow({ where: { id: fixture.bookedSlot.id } });
    expect(slot.status).toBe(SlotStatus.BOOKED);

    // And the doctor is explicitly told what needs resolving by hand.
    expect(response.body.data.orphanedBookings).toEqual([
      expect.objectContaining({ bookingId: fixture.booking.id, slotId: fixture.bookedSlot.id }),
    ]);
  });

  it('leaves past slots alone entirely', async () => {
    const doctor = await createDoctor({ timezone: 'Asia/Kolkata' });

    const created = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '10:00', endTime: '18:00' })
      .expect(201);

    // A slot from last week, outside any horizon the service would regenerate.
    const pastSlot = await prisma.slot.create({
      data: {
        doctorId: doctor.doctor.id,
        availabilityId: created.body.data.availability.id,
        startsAt: new Date(Date.now() - 7 * 86_400_000),
        endsAt: new Date(Date.now() - 7 * 86_400_000 + 900_000),
        durationMinutes: 15,
        bufferMinutes: 0,
        status: SlotStatus.AVAILABLE,
      },
    });

    await request(app)
      .put(`/api/v1/availability/${created.body.data.availability.id}`)
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        startTime: '10:00',
        endTime: '11:00',
        version: created.body.data.availability.version,
      })
      .expect(200);

    // History is immutable: still AVAILABLE, not retroactively blocked.
    const after = await prisma.slot.findUniqueOrThrow({ where: { id: pastSlot.id } });
    expect(after.status).toBe(SlotStatus.AVAILABLE);
    expect(after.deletedAt).toBeNull();
  });

  it('generates new slots when the window widens', async () => {
    const doctor = await createDoctor({ timezone: 'Asia/Kolkata' });

    const created = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 1,
        startTime: '10:00',
        endTime: '12:00',
        slotDurationMinutes: 60,
      })
      .expect(201);

    const before = await prisma.slot.count({ where: { doctorId: doctor.doctor.id } });

    const response = await request(app)
      .put(`/api/v1/availability/${created.body.data.availability.id}`)
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        startTime: '10:00',
        endTime: '18:00',
        version: created.body.data.availability.version,
      })
      .expect(200);

    expect(response.body.data.slotsGenerated).toBeGreaterThan(0);
    expect(await prisma.slot.count({ where: { doctorId: doctor.doctor.id } })).toBeGreaterThan(
      before,
    );
  });

  it('rejects a stale version', async () => {
    const doctor = await createDoctor();

    const created = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '10:00', endTime: '18:00' })
      .expect(201);

    const availabilityId = created.body.data.availability.id;
    const staleVersion = created.body.data.availability.version;

    await request(app)
      .put(`/api/v1/availability/${availabilityId}`)
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({ endTime: '17:00', version: staleVersion })
      .expect(200);

    // A second edit carrying the now-stale version must lose.
    const stale = await request(app)
      .put(`/api/v1/availability/${availabilityId}`)
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({ endTime: '16:00', version: staleVersion });

    expect(stale.status).toBe(409);
  });

  it("forbids editing another doctor's availability", async () => {
    const owner = await createDoctor();
    const intruder = await createDoctor();

    const created = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(owner)}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '10:00', endTime: '18:00' })
      .expect(201);

    const response = await request(app)
      .put(`/api/v1/availability/${created.body.data.availability.id}`)
      .set('authorization', `Bearer ${doctorToken(intruder)}`)
      .send({ endTime: '17:00', version: created.body.data.availability.version });

    expect(response.status).toBe(403);
  });
});

describe('DELETE /availability/:id', () => {
  it('blocks free future slots but preserves booked ones', async () => {
    const doctor = await createDoctor({ timezone: 'Asia/Kolkata' });
    const patient = await createPatient();

    const created = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 1,
        startTime: '10:00',
        endTime: '18:00',
        slotDurationMinutes: 60,
      })
      .expect(201);

    const slot = await prisma.slot.findFirstOrThrow({
      where: { doctorId: doctor.doctor.id },
      orderBy: { startsAt: 'asc' },
    });
    const booking = await bookingService.create(
      { slotId: slot.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    const response = await request(app)
      .delete(`/api/v1/availability/${created.body.data.availability.id}`)
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .expect(200);

    expect(response.body.data.slotsBlocked).toBeGreaterThan(0);
    expect(response.body.data.orphanedBookings).toHaveLength(1);

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'CONFIRMED',
    );
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.BOOKED,
    );
  });
});

describe('GET /doctors/:id/slots', () => {
  it('returns only available slots, rendered in the requested timezone', async () => {
    const doctor = await createDoctor({ timezone: 'Asia/Kolkata' });
    const patient = await createPatient();

    await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${doctorToken(doctor)}`)
      .send({
        kind: 'RECURRING',
        weekday: 1,
        startTime: '10:00',
        endTime: '18:00',
        slotDurationMinutes: 60,
      })
      .expect(201);

    const booked = await prisma.slot.findFirstOrThrow({
      where: { doctorId: doctor.doctor.id },
      orderBy: { startsAt: 'asc' },
    });
    await bookingService.create(
      { slotId: booked.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const response = await request(app)
      .get(`/api/v1/doctors/${doctor.doctor.id}/slots`)
      .query({ from, to, timezone: 'Europe/Berlin' })
      .expect(200);

    const ids = response.body.data.slots.map((slot: { id: string }) => slot.id);
    expect(ids).not.toContain(booked.id);

    expect(response.body.data.viewerTimezone).toBe('Europe/Berlin');
    expect(response.body.data.doctorTimezone).toBe('Asia/Kolkata');

    // Both renderings must be present and must disagree, since the zones do.
    const sample = response.body.data.slots[0];
    expect(sample.local.timezone).toBe('Europe/Berlin');
    expect(sample.doctorLocal.timezone).toBe('Asia/Kolkata');
    expect(sample.local.startTime).not.toBe(sample.doctorLocal.startTime);
  });

  it('refuses an excessive date range', async () => {
    const doctor = await createDoctor();

    const response = await request(app)
      .get(`/api/v1/doctors/${doctor.doctor.id}/slots`)
      .query({
        from: new Date().toISOString(),
        to: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      });

    expect(response.status).toBe(422);
  });

  it('404s for an unknown doctor', async () => {
    const response = await request(app)
      .get(`/api/v1/doctors/${crypto.randomUUID()}/slots`)
      .query({
        from: new Date().toISOString(),
        to: new Date(Date.now() + 86_400_000).toISOString(),
      });

    expect(response.status).toBe(404);
  });
});

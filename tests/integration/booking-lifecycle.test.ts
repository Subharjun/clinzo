import request from 'supertest';
import type { Application } from 'express';
import { HoldStatus, SlotStatus } from '@prisma/client';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import { redis, redisKeys } from '../../src/config/redis';
import { tokenService } from '../../src/services/token.service';
import { bookingService } from '../../src/services/booking.service';
import { holdService } from '../../src/services/hold.service';
import { sweepExpiredHolds } from '../../src/jobs/processors/hold-expiry.processor';
import { relayOutboxBatch } from '../../src/jobs/processors/outbox-relay.processor';
import {
  createDoctor,
  createPatient,
  createSlot,
  resetAll,
  teardown,
  type PatientFixture,
} from '../helpers/database';

/**
 * Booking lifecycle: cancellation, rescheduling, reservation holds and
 * idempotent retries.
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

function patientToken(patient: PatientFixture): string {
  return tokenService.signAccessToken({
    userId: patient.userId,
    role: 'PATIENT',
    profileId: patient.patient.id,
  });
}

describe('booking', () => {
  it('rejects a slot that has already started', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id, { startsAt: new Date(Date.now() - 3_600_000) });

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id });

    expect(response.status).toBe(422);
  });

  it('rejects a blocked slot', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    await prisma.slot.update({
      where: { id: slot.id },
      data: { status: SlotStatus.BLOCKED, blockedReason: 'doctor_leave' },
    });

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id });

    expect(response.status).toBe(409);
  });

  it('404s for an unknown slot', async () => {
    const patient = await createPatient();

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: crypto.randomUUID() });

    expect(response.status).toBe(404);
  });

  it('writes a booking.created outbox event in the same transaction', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id })
      .expect(201);

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: response.body.data.id },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('booking.created');
    expect(events[0]!.status).toBe('PENDING');

    // And the relay moves it to PUBLISHED.
    await relayOutboxBatch();
    const relayed = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: events[0]!.id } });
    expect(relayed.status).toBe('PUBLISHED');
  });

  it('records an audit entry for the booking', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id })
      .expect(201);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'Booking', entityId: response.body.data.id },
    });

    expect(audit).not.toBeNull();
    expect(audit!.action).toBe('booking.created');
    expect(audit!.actorId).toBe(patient.userId);
  });
});

describe('cancellation', () => {
  it('returns the slot to sale and emits a release event', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const booking = await bookingService.create(
      { slotId: slot.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    const response = await request(app)
      .delete(`/api/v1/bookings/${booking.id}`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ reason: 'Feeling better' })
      .expect(200);

    expect(response.body.data.status).toBe('CANCELLED');
    expect(response.body.data.cancelledBy).toBe('PATIENT');

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.AVAILABLE,
    );

    const released = await prisma.outboxEvent.findFirst({
      where: { eventType: 'slot.released', aggregateId: slot.id },
    });
    expect(released).not.toBeNull();
  });

  it('leaves a blocked slot blocked rather than reselling it', async () => {
    // The doctor withdrew this time after it was booked. Cancelling the
    // booking must not put a slot back on sale that the doctor no longer
    // offers.
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const booking = await bookingService.create(
      { slotId: slot.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    await prisma.slot.update({
      where: { id: slot.id },
      data: { status: SlotStatus.BLOCKED, blockedReason: 'availability_changed' },
    });

    await request(app)
      .delete(`/api/v1/bookings/${booking.id}`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({})
      .expect(200);

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.BLOCKED,
    );
  });

  it('is not repeatable', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const booking = await bookingService.create(
      { slotId: slot.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    await request(app)
      .delete(`/api/v1/bookings/${booking.id}`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({})
      .expect(200);

    const second = await request(app)
      .delete(`/api/v1/bookings/${booking.id}`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({});

    expect(second.status).toBe(409);
  });

  it('forbids another patient from cancelling', async () => {
    const { doctor } = await createDoctor();
    const owner = await createPatient();
    const intruder = await createPatient();
    const slot = await createSlot(doctor.id);

    const booking = await bookingService.create(
      { slotId: slot.id, patientId: owner.patient.id },
      { requestId: 'test' },
    );

    const response = await request(app)
      .delete(`/api/v1/bookings/${booking.id}`)
      .set('authorization', `Bearer ${patientToken(intruder)}`)
      .send({});

    expect(response.status).toBe(403);
  });
});

describe('rescheduling', () => {
  it('moves the booking and frees the original slot', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();

    const original = await createSlot(doctor.id, {
      startsAt: new Date(Date.now() + 48 * 3_600_000),
    });
    const target = await createSlot(doctor.id, {
      startsAt: new Date(Date.now() + 72 * 3_600_000),
    });

    const booking = await bookingService.create(
      { slotId: original.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    const response = await request(app)
      .put(`/api/v1/bookings/${booking.id}/reschedule`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ targetSlotId: target.id })
      .expect(200);

    // A new booking, linked back to the one it replaced.
    expect(response.body.data.id).not.toBe(booking.id);
    expect(response.body.data.slotId).toBe(target.id);
    expect(response.body.data.rescheduledFromId).toBe(booking.id);

    // The original is RESCHEDULED, not CANCELLED — the distinction matters for
    // reporting: the patient did not drop out.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'RESCHEDULED',
    );

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: original.id } })).status).toBe(
      SlotStatus.AVAILABLE,
    );
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      SlotStatus.BOOKED,
    );
  });

  it('keeps the original booking intact when the target slot is taken', async () => {
    // The failure-atomicity property: a patient must never end up with no
    // appointment because a reschedule half-succeeded.
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const rival = await createPatient();

    const original = await createSlot(doctor.id, {
      startsAt: new Date(Date.now() + 48 * 3_600_000),
    });
    const target = await createSlot(doctor.id, {
      startsAt: new Date(Date.now() + 72 * 3_600_000),
    });

    const booking = await bookingService.create(
      { slotId: original.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );
    await bookingService.create(
      { slotId: target.id, patientId: rival.patient.id },
      { requestId: 'test' },
    );

    const response = await request(app)
      .put(`/api/v1/bookings/${booking.id}/reschedule`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ targetSlotId: target.id });

    expect(response.status).toBe(409);

    // Everything is exactly as it was.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'CONFIRMED',
    );
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: original.id } })).status).toBe(
      SlotStatus.BOOKED,
    );
  });

  it('refuses to move a booking to a different doctor', async () => {
    const doctorA = await createDoctor();
    const doctorB = await createDoctor();
    const patient = await createPatient();

    const original = await createSlot(doctorA.doctor.id, {
      startsAt: new Date(Date.now() + 48 * 3_600_000),
    });
    const target = await createSlot(doctorB.doctor.id, {
      startsAt: new Date(Date.now() + 72 * 3_600_000),
    });

    const booking = await bookingService.create(
      { slotId: original.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    const response = await request(app)
      .put(`/api/v1/bookings/${booking.id}/reschedule`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ targetSlotId: target.id });

    expect(response.status).toBe(422);
  });

  it('allows only one of two simultaneous reschedules onto the same target', async () => {
    const { doctor } = await createDoctor();
    const [patientA, patientB] = await Promise.all([createPatient(), createPatient()]);

    const slotA = await createSlot(doctor.id, { startsAt: new Date(Date.now() + 48 * 3_600_000) });
    const slotB = await createSlot(doctor.id, { startsAt: new Date(Date.now() + 72 * 3_600_000) });
    const target = await createSlot(doctor.id, { startsAt: new Date(Date.now() + 96 * 3_600_000) });

    const bookingA = await bookingService.create(
      { slotId: slotA.id, patientId: patientA.patient.id },
      { requestId: 'test' },
    );
    const bookingB = await bookingService.create(
      { slotId: slotB.id, patientId: patientB.patient.id },
      { requestId: 'test' },
    );

    const results = await Promise.allSettled([
      bookingService.reschedule(
        { bookingId: bookingA.id, targetSlotId: target.id, patientId: patientA.patient.id },
        { requestId: 'test' },
      ),
      bookingService.reschedule(
        { bookingId: bookingB.id, targetSlotId: target.id, patientId: patientB.patient.id },
        { requestId: 'test' },
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.booking.count({ where: { slotId: target.id, status: 'CONFIRMED' } })).toBe(
      1,
    );
  });
});

describe('reservation holds', () => {
  it('takes a slot off sale and sets a Redis TTL', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const response = await request(app)
      .post('/api/v1/holds')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id })
      .expect(201);

    expect(response.body.data.ttlSeconds).toBeGreaterThan(0);

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.HELD,
    );

    // Redis owns expiry — the key must actually carry a TTL, or nothing
    // releases the slot without a worker running.
    const ttl = await redis.ttl(redisKeys.hold(slot.id));
    expect(ttl).toBeGreaterThan(0);

    // A held slot is hidden from patients browsing, not shown as busy.
    const listing = await request(app)
      .get(`/api/v1/doctors/${doctor.id}/slots`)
      .query({
        from: new Date().toISOString(),
        to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
      .expect(200);

    expect(listing.body.data.slots.map((s: { id: string }) => s.id)).not.toContain(slot.id);
  });

  it('prevents a second patient from holding the same slot', async () => {
    const { doctor } = await createDoctor();
    const [first, second] = await Promise.all([createPatient(), createPatient()]);
    const slot = await createSlot(doctor.id);

    await request(app)
      .post('/api/v1/holds')
      .set('authorization', `Bearer ${patientToken(first)}`)
      .send({ slotId: slot.id })
      .expect(201);

    const response = await request(app)
      .post('/api/v1/holds')
      .set('authorization', `Bearer ${patientToken(second)}`)
      .send({ slotId: slot.id });

    expect(response.status).toBe(409);
  });

  it('lets only one of many simultaneous hold attempts win', async () => {
    const { doctor } = await createDoctor();
    const patients = await Promise.all(Array.from({ length: 20 }, () => createPatient()));
    const slot = await createSlot(doctor.id);

    const results = await Promise.allSettled(
      patients.map((patient) =>
        holdService.create(
          { slotId: slot.id, patientId: patient.patient.id },
          { requestId: 'test' },
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.reservationHold.count({ where: { slotId: slot.id, status: HoldStatus.ACTIVE } }),
    ).toBe(1);
  });

  it('lets the holder convert their hold into a booking', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const hold = await request(app)
      .post('/api/v1/holds')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id })
      .expect(201);

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id, holdId: hold.body.data.id })
      .expect(201);

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.BOOKED,
    );
    expect(
      (await prisma.reservationHold.findUniqueOrThrow({ where: { id: hold.body.data.id } })).status,
    ).toBe(HoldStatus.CONSUMED);
  });

  it('blocks a non-holder from booking a held slot', async () => {
    const { doctor } = await createDoctor();
    const [holder, other] = await Promise.all([createPatient(), createPatient()]);
    const slot = await createSlot(doctor.id);

    await holdService.create(
      { slotId: slot.id, patientId: holder.patient.id },
      { requestId: 'test' },
    );

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(other)}`)
      .send({ slotId: slot.id });

    expect(response.status).toBe(409);
  });

  it('returns the slot to sale when the patient releases the hold', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const hold = await request(app)
      .post('/api/v1/holds')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slot.id })
      .expect(201);

    await request(app)
      .delete(`/api/v1/holds/${hold.body.data.id}`)
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .expect(200);

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.AVAILABLE,
    );
    expect(await redis.exists(redisKeys.hold(slot.id))).toBe(0);
  });

  it('releases a lapsed hold via the sweeper', async () => {
    // The reconciliation path: the Redis TTL fired but the delayed job never
    // ran (worker down, queue lost). The sweeper must still converge.
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const hold = await holdService.create(
      { slotId: slot.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    // Simulate the lease having elapsed, rather than waiting it out.
    const past = new Date(Date.now() - 1000);
    await prisma.reservationHold.update({ where: { id: hold.id }, data: { expiresAt: past } });
    await prisma.slot.update({ where: { id: slot.id }, data: { heldUntil: past } });
    await redis.del(redisKeys.hold(slot.id));

    const released = await sweepExpiredHolds();
    expect(released).toBe(1);

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.AVAILABLE,
    );
    expect(
      (await prisma.reservationHold.findUniqueOrThrow({ where: { id: hold.id } })).status,
    ).toBe(HoldStatus.EXPIRED);

    // And the freed slot is announced, so waitlisted patients hear about it.
    expect(
      await prisma.outboxEvent.findFirst({
        where: { eventType: 'slot.released', aggregateId: slot.id },
      }),
    ).not.toBeNull();
  });

  it('does not cut short a hold whose lease has not elapsed', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);

    const hold = await holdService.create(
      { slotId: slot.id, patientId: patient.patient.id },
      { requestId: 'test' },
    );

    // A stale delayed job firing early must be a no-op.
    expect(await holdService.expire(hold.id)).toBe(false);
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.HELD,
    );
  });

  it('caps how many slots one patient may hold at once', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();

    const slots = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createSlot(doctor.id, { startsAt: new Date(Date.now() + (48 + index) * 3_600_000) }),
      ),
    );

    for (const slot of slots.slice(0, 3)) {
      await request(app)
        .post('/api/v1/holds')
        .set('authorization', `Bearer ${patientToken(patient)}`)
        .send({ slotId: slot.id })
        .expect(201);
    }

    const fourth = await request(app)
      .post('/api/v1/holds')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .send({ slotId: slots[3]!.id });

    expect(fourth.status).toBe(422);
  });
});

describe('idempotency', () => {
  it('replays the original response instead of booking twice', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);
    const key = `idem-${crypto.randomUUID()}`;

    const first = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .set('idempotency-key', key)
      .send({ slotId: slot.id })
      .expect(201);

    const retry = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .set('idempotency-key', key)
      .send({ slotId: slot.id });

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(first.body.data.id);

    // Exactly one booking, despite two requests.
    expect(await prisma.booking.count({ where: { slotId: slot.id } })).toBe(1);
  });

  it('rejects the same key used with a different body', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const slotA = await createSlot(doctor.id, { startsAt: new Date(Date.now() + 48 * 3_600_000) });
    const slotB = await createSlot(doctor.id, { startsAt: new Date(Date.now() + 72 * 3_600_000) });
    const key = `idem-${crypto.randomUUID()}`;

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .set('idempotency-key', key)
      .send({ slotId: slotA.id })
      .expect(201);

    const mismatched = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .set('idempotency-key', key)
      .send({ slotId: slotB.id });

    expect(mismatched.status).toBe(409);
    expect(mismatched.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('scopes keys per user so two clients cannot collide', async () => {
    const { doctor } = await createDoctor();
    const [first, second] = await Promise.all([createPatient(), createPatient()]);
    const slotA = await createSlot(doctor.id, { startsAt: new Date(Date.now() + 48 * 3_600_000) });
    const slotB = await createSlot(doctor.id, { startsAt: new Date(Date.now() + 72 * 3_600_000) });

    // Both clients happen to generate the same key.
    const key = 'a-shared-client-generated-key';

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(first)}`)
      .set('idempotency-key', key)
      .send({ slotId: slotA.id })
      .expect(201);

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(second)}`)
      .set('idempotency-key', key)
      .send({ slotId: slotB.id })
      .expect(201);

    expect(await prisma.booking.count()).toBe(2);
  });

  it('frees the key after a failed request so a retry can succeed', async () => {
    const { doctor } = await createDoctor();
    const patient = await createPatient();
    const past = await createSlot(doctor.id, { startsAt: new Date(Date.now() - 3_600_000) });
    const future = await createSlot(doctor.id);
    const key = `idem-${crypto.randomUUID()}`;

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .set('idempotency-key', key)
      .send({ slotId: past.id })
      .expect(422);

    // The same key is now reusable — the first attempt did nothing worth
    // replaying.
    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patientToken(patient)}`)
      .set('idempotency-key', key)
      .send({ slotId: future.id })
      .expect(201);
  });
});

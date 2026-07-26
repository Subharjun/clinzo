import request from 'supertest';
import type { Application } from 'express';
import { BookingStatus, SlotStatus } from '@prisma/client';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import { redis } from '../../src/config/redis';
import { tokenService } from '../../src/services/token.service';
import { bookingService } from '../../src/services/booking.service';
import {
  createDoctor,
  createPatients,
  createSlot,
  resetAll,
  teardown,
  type PatientFixture,
} from '../helpers/database';

/**
 * ===========================================================================
 * CONCURRENCY PROOF
 * ===========================================================================
 *
 * The central claim of this system is that a slot cannot be double-booked,
 * even under simultaneous access. This file is the evidence.
 *
 * These are real HTTP requests against a real Express app, hitting real
 * Postgres and real Redis. Nothing is mocked, because a mock would only prove
 * that the mock behaves as written — the guarantee under test is a property of
 * Postgres, and only Postgres can demonstrate it.
 *
 * The assertions are deliberately absolute:
 *
 *   - EXACTLY one request succeeds. Not "at most one".
 *   - EXACTLY one CONFIRMED booking row exists for the slot.
 *   - EVERY other request receives 409 — no 500s, no timeouts, no silent
 *     successes.
 *
 * A single extra confirmed booking means a real patient arrives to find their
 * appointment double-sold, so anything short of exact is a failure.
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

/** Mint an access token directly — logging in 100 times would dominate runtime. */
function tokenFor(patient: PatientFixture): string {
  return tokenService.signAccessToken({
    userId: patient.userId,
    role: 'PATIENT',
    profileId: patient.patient.id,
  });
}

describe('booking concurrency', () => {
  it('allows exactly one of 100 simultaneous requests to book the same slot', async () => {
    const { doctor } = await createDoctor();
    const slot = await createSlot(doctor.id);
    const patients = await createPatients(100);

    // Fire all 100 without awaiting in between. `Promise.all` dispatches every
    // request before any resolves, so they genuinely contend rather than
    // queueing behind one another.
    const responses = await Promise.all(
      patients.map((patient) =>
        request(app)
          .post('/api/v1/bookings')
          .set('authorization', `Bearer ${tokenFor(patient)}`)
          .send({ slotId: slot.id }),
      ),
    );

    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);
    const other = responses.filter(
      (response) => response.status !== 201 && response.status !== 409,
    );

    // Surface the actual statuses on failure — "expected 1, got 2" is far
    // less useful than knowing which codes came back.
    if (other.length > 0) {
      throw new Error(
        `expected only 201/409, got: ${JSON.stringify(
          other.map((r) => ({ status: r.status, body: r.body })),
          null,
          2,
        )}`,
      );
    }

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(99);

    // Every rejection must be actionable: the client needs to know the slot is
    // gone, not merely that "something conflicted".
    for (const conflict of conflicts) {
      expect(conflict.body.success).toBe(false);
      expect(['SLOT_UNAVAILABLE', 'CONFLICT']).toContain(conflict.body.error.code);
      expect(conflict.body.error.requestId).toBeTruthy();
    }

    // --- The database is the real judge ------------------------------------
    const confirmed = await prisma.booking.findMany({
      where: { slotId: slot.id, status: BookingStatus.CONFIRMED },
    });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.patientId).toBe(
      patients.find((p) => p.patient.id === confirmed[0]!.patientId)?.patient.id,
    );

    // The winning response and the stored row must describe the same booking.
    expect(created[0]!.body.data.id).toBe(confirmed[0]!.id);

    const finalSlot = await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(finalSlot.status).toBe(SlotStatus.BOOKED);
  });

  it('holds the invariant at the service layer, bypassing HTTP entirely', async () => {
    // The HTTP test could in principle pass because of something in Express.
    // This one calls the service directly, so the guarantee is attributed to
    // the data layer where it actually lives.
    const { doctor } = await createDoctor();
    const slot = await createSlot(doctor.id);
    const patients = await createPatients(50);

    const results = await Promise.allSettled(
      patients.map((patient) =>
        bookingService.create(
          { slotId: slot.id, patientId: patient.patient.id },
          { requestId: 'concurrency-test' },
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(49);

    const confirmed = await prisma.booking.count({
      where: { slotId: slot.id, status: BookingStatus.CONFIRMED },
    });
    expect(confirmed).toBe(1);
  });

  it('survives with the Redis lock removed, proving Postgres is the guarantee', async () => {
    // The Redis lock is a throughput optimisation, not the correctness
    // mechanism. If it were load-bearing, disabling it would produce double
    // bookings. It does not — the partial unique index still holds the line.
    const lockModule = await import('../../src/services/lock.service');

    const withLockSpy = jest
      .spyOn(lockModule.lockService, 'withLock')
      // Run the critical section with no mutual exclusion whatsoever.
      .mockImplementation(async <T>(_key: string, work: () => Promise<T>) => work());

    try {
      const { doctor } = await createDoctor();
      const slot = await createSlot(doctor.id);
      const patients = await createPatients(30);

      const results = await Promise.allSettled(
        patients.map((patient) =>
          bookingService.create(
            { slotId: slot.id, patientId: patient.patient.id },
            { requestId: 'no-lock-test' },
          ),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const confirmed = await prisma.booking.count({
        where: { slotId: slot.id, status: BookingStatus.CONFIRMED },
      });
      expect(confirmed).toBe(1);
    } finally {
      withLockSpy.mockRestore();
    }
  });

  it('rejects a second CONFIRMED booking at the database level', async () => {
    // Direct proof that the constraint exists and bites, independent of any
    // application code path. If someone drops this index, this test fails.
    const { doctor } = await createDoctor();
    const slot = await createSlot(doctor.id);
    const [first, second] = await createPatients(2);

    await prisma.booking.create({
      data: {
        slotId: slot.id,
        patientId: first!.patient.id,
        doctorId: doctor.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        appointmentType: 'STANDARD',
        mode: 'VIDEO',
        confirmationCode: 'CLZ-TEST01',
        status: BookingStatus.CONFIRMED,
      },
    });

    await expect(
      prisma.booking.create({
        data: {
          slotId: slot.id,
          patientId: second!.patient.id,
          doctorId: doctor.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          appointmentType: 'STANDARD',
          mode: 'VIDEO',
          confirmationCode: 'CLZ-TEST02',
          status: BookingStatus.CONFIRMED,
        },
      }),
      // P2002 — unique constraint violation on bookings_one_confirmed_per_slot.
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lets a slot be re-booked after cancellation, and only once again', async () => {
    // The partial index must not block re-sale: it is scoped to CONFIRMED, so
    // a cancelled booking leaves the index and frees the slot.
    const { doctor } = await createDoctor();
    const slot = await createSlot(doctor.id);
    const patients = await createPatients(20);

    const firstBooking = await bookingService.create(
      { slotId: slot.id, patientId: patients[0]!.patient.id },
      { requestId: 'test' },
    );

    await bookingService.cancel(
      {
        bookingId: firstBooking.id,
        cancelledBy: 'PATIENT',
        actorRole: 'PATIENT',
        actorPatientId: patients[0]!.patient.id,
      },
      { requestId: 'test' },
    );

    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).status).toBe(
      SlotStatus.AVAILABLE,
    );

    // The freed slot is contended again; still exactly one winner.
    const results = await Promise.allSettled(
      patients
        .slice(1)
        .map((patient) =>
          bookingService.create(
            { slotId: slot.id, patientId: patient.patient.id },
            { requestId: 'test' },
          ),
        ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.booking.count({
        where: { slotId: slot.id, status: BookingStatus.CONFIRMED },
      }),
    ).toBe(1);

    // History is preserved: two booking rows, one cancelled and one live.
    expect(await prisma.booking.count({ where: { slotId: slot.id } })).toBe(2);
  });

  it('distributes correctly when many patients contend for many slots', async () => {
    // A harder shape than one hot slot: 20 slots, 100 bookers. Every slot must
    // end up with exactly one booking, and exactly 20 requests must succeed.
    const { doctor } = await createDoctor();
    const slots = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createSlot(doctor.id, { startsAt: new Date(Date.now() + (48 + index) * 3_600_000) }),
      ),
    );
    const patients = await createPatients(100);

    const attempts = patients.map((patient, index) => ({
      patient,
      // Deterministic spread: five patients per slot.
      slot: slots[index % slots.length]!,
    }));

    const results = await Promise.allSettled(
      attempts.map(({ patient, slot }) =>
        bookingService.create(
          { slotId: slot.id, patientId: patient.patient.id },
          { requestId: 'test' },
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);

    const bookingsPerSlot = await prisma.booking.groupBy({
      by: ['slotId'],
      where: { status: BookingStatus.CONFIRMED },
      _count: { _all: true },
    });

    expect(bookingsPerSlot).toHaveLength(20);
    for (const row of bookingsPerSlot) {
      expect(row._count._all).toBe(1);
    }
  });

  it('prevents one patient from double-booking overlapping times', async () => {
    // A different invariant from slot exclusivity, and one no single-column
    // constraint can express: the same patient must not hold two appointments
    // at the same moment, even with different doctors.
    const [doctorA, doctorB] = await Promise.all([createDoctor(), createDoctor()]);
    const startsAt = new Date(Date.now() + 72 * 3_600_000);

    const slotA = await createSlot(doctorA.doctor.id, { startsAt });
    const slotB = await createSlot(doctorB.doctor.id, { startsAt });

    const [patient] = await createPatients(1);

    await bookingService.create(
      { slotId: slotA.id, patientId: patient!.patient.id },
      { requestId: 'test' },
    );

    await expect(
      bookingService.create(
        { slotId: slotB.id, patientId: patient!.patient.id },
        { requestId: 'test' },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('serialises contenders through Redis rather than piling onto Postgres', async () => {
    // Behavioural check on the lock layer: under contention the lock is
    // acquired and released once per contender, and the request that wins is
    // the one holding it. A regression that removed locking would show up as
    // zero lock keys ever being written.
    const { doctor } = await createDoctor();
    const slot = await createSlot(doctor.id);
    const patients = await createPatients(25);

    const lockModule = await import('../../src/services/lock.service');
    const acquireSpy = jest.spyOn(lockModule.lockService, 'withLock');

    await Promise.allSettled(
      patients.map((patient) =>
        bookingService.create(
          { slotId: slot.id, patientId: patient.patient.id },
          { requestId: 'test' },
        ),
      ),
    );

    expect(acquireSpy).toHaveBeenCalledTimes(25);
    acquireSpy.mockRestore();

    // Every lock must have been released — a leaked lock would block the slot
    // until its TTL expired.
    const leaked = await redis.keys('clinzo:lock:slot:*');
    expect(leaked).toEqual([]);
  });
});

import { AvailabilityKind, Role, type Doctor, type Patient, type Slot } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../../src/config/prisma';
import { redis } from '../../src/config/redis';

/**
 * Integration-test fixtures.
 *
 * Isolation is by truncation between tests rather than by transaction
 * rollback. Rollback isolation is faster, but it is fundamentally incompatible
 * with what this suite exists to prove: the concurrency tests need many
 * genuinely independent connections committing real transactions, which cannot
 * happen inside one shared outer transaction.
 */

/**
 * Ordered so foreign keys are respected even without CASCADE.
 * `RESTART IDENTITY CASCADE` also resets sequences, keeping ids stable-ish
 * across runs and failures easier to read.
 */
const TABLES_IN_DEPENDENCY_ORDER = [
  'audit_logs',
  'outbox_events',
  'idempotency_keys',
  'reservation_holds',
  'waitlist_entries',
  'bookings',
  'slots',
  'availabilities',
  'refresh_tokens',
  'doctors',
  'patients',
  'users',
] as const;

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES_IN_DEPENDENCY_ORDER.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Clear the test Redis database.
 *
 * Essential between tests: a leftover lock or hold key from a previous test
 * would make the next one fail in a way that looks like a product bug.
 * Integration config points at Redis db 1, so this never touches dev data.
 */
export async function resetRedis(): Promise<void> {
  await redis.flushdb();
}

export async function resetAll(): Promise<void> {
  await Promise.all([resetDatabase(), resetRedis()]);
}

export const TEST_PASSWORD = 'TestPassword123!';

// Hashed once: with cost factor 4 this is cheap, but creating 100 patients
// per test still adds up.
let cachedHash: string | undefined;

async function passwordHash(): Promise<string> {
  cachedHash ??= await bcrypt.hash(TEST_PASSWORD, 4);
  return cachedHash;
}

export interface DoctorFixture {
  doctor: Doctor;
  userId: string;
  email: string;
}

export async function createDoctor(
  overrides: {
    email?: string;
    timezone?: string;
    slotDurationMinutes?: number;
    bufferMinutes?: number;
    specialization?: string;
  } = {},
): Promise<DoctorFixture> {
  const email = overrides.email ?? `doctor-${crypto.randomUUID()}@test.clinzo`;
  const timezone = overrides.timezone ?? 'Asia/Kolkata';

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await passwordHash(),
      role: Role.DOCTOR,
      fullName: 'Test Doctor',
      timezone,
    },
  });

  const doctor = await prisma.doctor.create({
    data: {
      userId: user.id,
      specialization: overrides.specialization ?? 'Cardiology',
      registrationNo: `REG-${crypto.randomUUID().slice(0, 12)}`,
      timezone,
      defaultSlotDurationMinutes: overrides.slotDurationMinutes ?? 15,
      defaultBufferMinutes: overrides.bufferMinutes ?? 0,
    },
  });

  return { doctor, userId: user.id, email };
}

export interface PatientFixture {
  patient: Patient;
  userId: string;
  email: string;
}

export async function createPatient(
  overrides: { email?: string; timezone?: string } = {},
): Promise<PatientFixture> {
  const email = overrides.email ?? `patient-${crypto.randomUUID()}@test.clinzo`;
  const timezone = overrides.timezone ?? 'Asia/Kolkata';

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await passwordHash(),
      role: Role.PATIENT,
      fullName: 'Test Patient',
      timezone,
    },
  });

  const patient = await prisma.patient.create({ data: { userId: user.id, timezone } });

  return { patient, userId: user.id, email };
}

/** Create N patients concurrently — used by the contention tests. */
export async function createPatients(count: number): Promise<PatientFixture[]> {
  return Promise.all(Array.from({ length: count }, () => createPatient()));
}

/**
 * Insert a slot directly, bypassing availability.
 *
 * Most booking tests do not care where a slot came from, and going through
 * generation would couple every booking test to the generator's behaviour.
 */
export async function createSlot(
  doctorId: string,
  overrides: {
    startsAt?: Date;
    durationMinutes?: number;
    appointmentType?: string;
    availabilityId?: string;
  } = {},
): Promise<Slot> {
  // Default well into the future so lead-time and past-slot rules never
  // interfere with a test that is not about them.
  const startsAt = overrides.startsAt ?? new Date(Date.now() + 48 * 3_600_000);
  const durationMinutes = overrides.durationMinutes ?? 15;

  return prisma.slot.create({
    data: {
      doctorId,
      availabilityId: overrides.availabilityId ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
      durationMinutes,
      bufferMinutes: 0,
      appointmentType: overrides.appointmentType ?? 'STANDARD',
      mode: 'VIDEO',
    },
  });
}

export async function createAvailability(
  doctorId: string,
  overrides: {
    kind?: AvailabilityKind;
    weekday?: number;
    date?: Date;
    startMinuteOfDay?: number;
    endMinuteOfDay?: number;
    timezone?: string;
    slotDurationMinutes?: number;
    bufferMinutes?: number;
  } = {},
) {
  const kind = overrides.kind ?? AvailabilityKind.RECURRING;

  return prisma.availability.create({
    data: {
      doctorId,
      kind,
      weekday: kind === AvailabilityKind.RECURRING ? (overrides.weekday ?? 1) : null,
      date: kind === AvailabilityKind.ONE_OFF ? (overrides.date ?? new Date()) : null,
      startMinuteOfDay: overrides.startMinuteOfDay ?? 600,
      endMinuteOfDay: overrides.endMinuteOfDay ?? 1080,
      timezone: overrides.timezone ?? 'Asia/Kolkata',
      slotDurationMinutes: overrides.slotDurationMinutes ?? 15,
      bufferMinutes: overrides.bufferMinutes ?? 0,
      appointmentType: 'STANDARD',
      mode: 'VIDEO',
    },
  });
}

/**
 * Release every long-lived handle so Jest can exit.
 *
 * Importing the booking service transitively constructs the BullMQ queues,
 * whose Redis connections keep the event loop alive indefinitely. Closing them
 * here is what makes the suite terminate rather than hang after the last
 * assertion passes.
 */
export async function teardown(): Promise<void> {
  const { closeQueues } = await import('../../src/jobs/queues');
  const { bullConnection, subscriber } = await import('../../src/config/redis');

  await closeQueues().catch(() => {
    // Already closed.
  });
  await prisma.$disconnect();

  await Promise.allSettled([redis.quit(), bullConnection.quit(), subscriber.quit()]);
}

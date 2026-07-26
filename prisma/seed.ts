import { AvailabilityKind, PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { generateSlotsForAvailability } from '../src/services/slot-generator';
import { toZonedDate } from '../src/utils/time';

/**
 * Development seed.
 *
 * Produces a dataset that exercises the interesting parts of the system rather
 * than a minimal happy path: doctors in two different timezones, recurring and
 * one-off windows, differing consultation durations and buffers, and a patient
 * cohort large enough to run the concurrency demo against.
 *
 * Idempotent — safe to re-run. Uses fixed ids so repeated runs converge.
 */

const prisma = new PrismaClient();

const PASSWORD = 'ClinzoDemo2026!';

/** Deterministic ids so a re-seed updates rather than duplicates. */
const IDS = {
  doctorUserA: '11111111-1111-4111-8111-111111111111',
  doctorUserB: '22222222-2222-4222-8222-222222222222',
  doctorA: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  doctorB: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
} as const;

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  console.log('seeding…');

  // --- Doctors -------------------------------------------------------------
  // Two timezones on purpose: it is the fastest way to notice a bug where UTC
  // conversion silently uses the server's zone.
  const doctorAUser = await prisma.user.upsert({
    where: { id: IDS.doctorUserA },
    update: {},
    create: {
      id: IDS.doctorUserA,
      email: 'dr.mehta@clinzo.test',
      passwordHash,
      role: Role.DOCTOR,
      fullName: 'Dr Anaya Mehta',
      phone: '+919876543210',
      timezone: 'Asia/Kolkata',
    },
  });

  const doctorA = await prisma.doctor.upsert({
    where: { id: IDS.doctorA },
    update: {},
    create: {
      id: IDS.doctorA,
      userId: doctorAUser.id,
      specialization: 'Cardiology',
      registrationNo: 'MCI-2019-88213',
      bio: 'Interventional cardiologist. Online follow-ups and second opinions.',
      timezone: 'Asia/Kolkata',
      consultationFeeCents: 150_000,
      currency: 'INR',
      defaultSlotDurationMinutes: 15,
      defaultBufferMinutes: 5,
    },
  });

  const doctorBUser = await prisma.user.upsert({
    where: { id: IDS.doctorUserB },
    update: {},
    create: {
      id: IDS.doctorUserB,
      email: 'dr.okafor@clinzo.test',
      passwordHash,
      role: Role.DOCTOR,
      fullName: 'Dr Chidi Okafor',
      timezone: 'America/New_York',
    },
  });

  const doctorB = await prisma.doctor.upsert({
    where: { id: IDS.doctorB },
    update: {},
    create: {
      id: IDS.doctorB,
      userId: doctorBUser.id,
      specialization: 'Dermatology',
      registrationNo: 'NY-2021-55190',
      bio: 'Teledermatology, chronic skin conditions.',
      timezone: 'America/New_York',
      consultationFeeCents: 12_000,
      currency: 'USD',
      // A longer default, to exercise variable-length appointment handling.
      defaultSlotDurationMinutes: 30,
      defaultBufferMinutes: 0,
    },
  });

  // --- Patients ------------------------------------------------------------
  const patients = [];
  for (let i = 1; i <= 12; i += 1) {
    const user = await prisma.user.upsert({
      where: { email: `patient${i}@clinzo.test` },
      update: {},
      create: {
        email: `patient${i}@clinzo.test`,
        passwordHash,
        role: Role.PATIENT,
        fullName: `Test Patient ${i}`,
        timezone: i % 3 === 0 ? 'Europe/Berlin' : 'Asia/Kolkata',
      },
    });

    const patient = await prisma.patient.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        timezone: user.timezone,
        dateOfBirth: new Date(`19${70 + i}-04-1${i % 10}`),
      },
    });
    patients.push(patient);
  }

  // --- Admin ---------------------------------------------------------------
  await prisma.user.upsert({
    where: { email: 'admin@clinzo.test' },
    update: {},
    create: {
      email: 'admin@clinzo.test',
      passwordHash,
      role: Role.ADMIN,
      fullName: 'Clinic Administrator',
      timezone: 'UTC',
    },
  });

  // --- Availability --------------------------------------------------------
  // Doctor A: the assignment's worked example — Mon-Fri 10:00-18:00 IST, 15
  // minute consultations with a 5 minute buffer, giving starts at 10:00,
  // 10:20, 10:40 …
  for (const weekday of [1, 2, 3, 4, 5]) {
    const existing = await prisma.availability.findFirst({
      where: { doctorId: doctorA.id, kind: AvailabilityKind.RECURRING, weekday, deletedAt: null },
    });
    if (existing) continue;

    await prisma.availability.create({
      data: {
        doctorId: doctorA.id,
        kind: AvailabilityKind.RECURRING,
        weekday,
        startMinuteOfDay: 10 * 60,
        endMinuteOfDay: 18 * 60,
        timezone: 'Asia/Kolkata',
        slotDurationMinutes: 15,
        bufferMinutes: 5,
        appointmentType: 'STANDARD',
        mode: 'VIDEO',
      },
    });
  }

  // Doctor B: 30-minute first visits, no buffer, on Tue/Thu.
  for (const weekday of [2, 4]) {
    const existing = await prisma.availability.findFirst({
      where: { doctorId: doctorB.id, kind: AvailabilityKind.RECURRING, weekday, deletedAt: null },
    });
    if (existing) continue;

    await prisma.availability.create({
      data: {
        doctorId: doctorB.id,
        kind: AvailabilityKind.RECURRING,
        weekday,
        startMinuteOfDay: 9 * 60,
        endMinuteOfDay: 13 * 60,
        timezone: 'America/New_York',
        slotDurationMinutes: 30,
        bufferMinutes: 0,
        appointmentType: 'FIRST_VISIT',
        mode: 'VIDEO',
      },
    });
  }

  // A one-off Saturday clinic for doctor A, two weeks out.
  const saturday = DateTime.now()
    .setZone('Asia/Kolkata')
    .plus({ weeks: 2 })
    .set({ weekday: 6 })
    .toISODate() as string;

  const existingOneOff = await prisma.availability.findFirst({
    where: {
      doctorId: doctorA.id,
      kind: AvailabilityKind.ONE_OFF,
      date: new Date(`${saturday}T00:00:00.000Z`),
      deletedAt: null,
    },
  });

  if (!existingOneOff) {
    await prisma.availability.create({
      data: {
        doctorId: doctorA.id,
        kind: AvailabilityKind.ONE_OFF,
        date: new Date(`${saturday}T00:00:00.000Z`),
        startMinuteOfDay: 9 * 60,
        endMinuteOfDay: 12 * 60,
        timezone: 'Asia/Kolkata',
        slotDurationMinutes: 20,
        bufferMinutes: 10,
        appointmentType: 'FOLLOW_UP',
        mode: 'IN_CLINIC',
      },
    });
  }

  // --- Slot materialisation ------------------------------------------------
  // Generated with the same pure function the service uses, so seeded data is
  // identical to data produced through the API. Going through the service
  // instead would drag Redis and the job queues into the seed for no benefit.
  const generatedTotal = await materialiseAllSlots();

  console.log(`
seed complete.

  doctors : ${doctorA.id} (Asia/Kolkata, 15m + 5m buffer)
            ${doctorB.id} (America/New_York, 30m, no buffer)
  patients: ${patients.length}
  slots   : ${generatedTotal} materialised over the next ${HORIZON_DAYS} days
  login    : dr.mehta@clinzo.test / patient1@clinzo.test / admin@clinzo.test
  password : ${PASSWORD}
`);
}

/** How far ahead the seed materialises slots. */
const HORIZON_DAYS = 30;

/**
 * Expand every active availability into concrete slots.
 * `skipDuplicates` makes this converge on re-run rather than erroring.
 */
async function materialiseAllSlots(): Promise<number> {
  const availabilities = await prisma.availability.findMany({
    where: { isActive: true, deletedAt: null },
  });

  const now = new Date();
  let total = 0;

  for (const availability of availabilities) {
    const rangeStart = toZonedDate(now, availability.timezone);
    const rangeEnd = toZonedDate(
      new Date(now.getTime() + HORIZON_DAYS * 86_400_000),
      availability.timezone,
    );

    const { slots } = generateSlotsForAvailability(
      {
        kind: availability.kind,
        date: availability.date ? availability.date.toISOString().slice(0, 10) : null,
        weekday: availability.weekday,
        startMinuteOfDay: availability.startMinuteOfDay,
        endMinuteOfDay: availability.endMinuteOfDay,
        timezone: availability.timezone,
        slotDurationMinutes: availability.slotDurationMinutes,
        bufferMinutes: availability.bufferMinutes,
        effectiveFrom: null,
        effectiveUntil: null,
      },
      rangeStart,
      rangeEnd,
    );

    const future = slots.filter((slot) => slot.startsAt > now);

    const result = await prisma.slot.createMany({
      data: future.map((slot) => ({
        doctorId: availability.doctorId,
        availabilityId: availability.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        durationMinutes: slot.durationMinutes,
        bufferMinutes: slot.bufferMinutes,
        mode: availability.mode,
        appointmentType: availability.appointmentType,
      })),
      skipDuplicates: true,
    });

    total += result.count;
  }

  return total;
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

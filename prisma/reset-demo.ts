import { PrismaClient, SlotStatus } from '@prisma/client';

/**
 * Demo reset.
 *
 * `seed.ts` is idempotent by upsert: re-running it converges users, doctors,
 * availability and slot *rows*, but it deliberately never deletes transactional
 * data. That is the right behaviour for a seed — it must be safe to re-run
 * against a database someone is working in — but it means a re-seed does not
 * put the demo back to a clean slate. Bookings, holds and consumed slots all
 * survive, so the console ends up showing 10:00 as taken.
 *
 * This script is the missing half: it clears the transactional layer and
 * returns every slot to AVAILABLE, without touching accounts, availability
 * windows, or the slots themselves. Run it before recording, or between takes.
 *
 *   npm run demo:reset
 *
 * Refuses to run against a production database, because the whole point of it
 * is to delete bookings.
 */

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('demo:reset deletes bookings and must never run in production');
  }

  const url = process.env['DATABASE_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1|postgres:\/\/[^@]*@(postgres|db)[:/]/.test(url)) {
    throw new Error(
      `demo:reset expects a local database; DATABASE_URL points elsewhere.\n` +
        `Set it explicitly if you really mean to reset that host.`,
    );
  }

  console.log('resetting demo state…\n');

  // Order matters only where foreign keys are not cascading; deleting the
  // dependent rows first is correct regardless of how each relation is
  // configured, so it is done explicitly rather than relying on cascades.
  const holds = await prisma.reservationHold.deleteMany({});
  const waitlist = await prisma.waitlistEntry.deleteMany({});
  const bookings = await prisma.booking.deleteMany({});
  const outbox = await prisma.outboxEvent.deleteMany({});
  const idempotency = await prisma.idempotencyKey.deleteMany({});
  const audit = await prisma.auditLog.deleteMany({});

  // Return every slot to bookable. `version` is bumped so any cached optimistic
  // read is invalidated rather than silently winning a later write.
  const slots = await prisma.slot.updateMany({
    where: { NOT: { status: SlotStatus.AVAILABLE } },
    data: {
      status: SlotStatus.AVAILABLE,
      heldUntil: null,
      blockedReason: null,
      version: { increment: 1 },
    },
  });

  const remaining = await prisma.slot.count();

  console.log('  bookings deleted     :', bookings.count);
  console.log('  holds released       :', holds.count);
  console.log('  waitlist cleared     :', waitlist.count);
  console.log('  outbox events cleared:', outbox.count);
  console.log('  idempotency keys     :', idempotency.count);
  console.log('  audit entries        :', audit.count);
  console.log('  slots reset to AVAILABLE:', slots.count);
  console.log('  slots available now  :', remaining);
  console.log('\nreset complete — the console will show a clean schedule.');
  console.log('note: the slot listing is cached for SLOT_CACHE_TTL_SECONDS, so');
  console.log('give the browser a few seconds (or hard-reload) before recording.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

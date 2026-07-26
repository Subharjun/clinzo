-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PATIENT', 'DOCTOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AvailabilityKind" AS ENUM ('ONE_OFF', 'RECURRING');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('PATIENT', 'DOCTOR', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('ACTIVE', 'NOTIFIED', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "AppointmentMode" AS ENUM ('VIDEO', 'IN_CLINIC');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "replacedById" UUID,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "specialization" TEXT NOT NULL,
    "registrationNo" TEXT NOT NULL,
    "bio" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "consultationFeeCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "isAcceptingPatients" BOOLEAN NOT NULL DEFAULT true,
    "defaultSlotDurationMinutes" INTEGER NOT NULL DEFAULT 15,
    "defaultBufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availabilities" (
    "id" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "kind" "AvailabilityKind" NOT NULL,
    "date" DATE,
    "weekday" INTEGER,
    "startMinuteOfDay" INTEGER NOT NULL,
    "endMinuteOfDay" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "slotDurationMinutes" INTEGER NOT NULL,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "mode" "AppointmentMode" NOT NULL DEFAULT 'VIDEO',
    "appointmentType" TEXT NOT NULL DEFAULT 'STANDARD',
    "effectiveFrom" DATE,
    "effectiveUntil" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "availabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slots" (
    "id" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "availabilityId" UUID,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" "SlotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "mode" "AppointmentMode" NOT NULL DEFAULT 'VIDEO',
    "appointmentType" TEXT NOT NULL DEFAULT 'STANDARD',
    "heldUntil" TIMESTAMPTZ(3),
    "blockedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "slotId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "mode" "AppointmentMode" NOT NULL DEFAULT 'VIDEO',
    "appointmentType" TEXT NOT NULL DEFAULT 'STANDARD',
    "reasonForVisit" TEXT,
    "notes" TEXT,
    "rescheduledFromId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledBy" "CancelledBy",
    "cancellationReason" TEXT,
    "confirmationCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_holds" (
    "id" UUID NOT NULL,
    "slotId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "checkoutReference" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservation_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "appointmentType" TEXT NOT NULL DEFAULT 'STANDARD',
    "status" "WaitlistStatus" NOT NULL DEFAULT 'ACTIVE',
    "notifiedAt" TIMESTAMPTZ(3),
    "fulfilledAt" TIMESTAMPTZ(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "actorRole" "Role",
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "requestId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_deletedAt_idx" ON "users"("role", "deletedAt");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_revokedAt_idx" ON "refresh_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_userId_key" ON "doctors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_registrationNo_key" ON "doctors"("registrationNo");

-- CreateIndex
CREATE INDEX "doctors_specialization_deletedAt_idx" ON "doctors"("specialization", "deletedAt");

-- CreateIndex
CREATE INDEX "doctors_isAcceptingPatients_deletedAt_idx" ON "doctors"("isAcceptingPatients", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "patients_userId_key" ON "patients"("userId");

-- CreateIndex
CREATE INDEX "patients_deletedAt_idx" ON "patients"("deletedAt");

-- CreateIndex
CREATE INDEX "availabilities_doctorId_isActive_deletedAt_idx" ON "availabilities"("doctorId", "isActive", "deletedAt");

-- CreateIndex
CREATE INDEX "availabilities_doctorId_kind_weekday_idx" ON "availabilities"("doctorId", "kind", "weekday");

-- CreateIndex
CREATE INDEX "availabilities_doctorId_date_idx" ON "availabilities"("doctorId", "date");

-- CreateIndex
CREATE INDEX "slots_doctorId_startsAt_status_idx" ON "slots"("doctorId", "startsAt", "status");

-- CreateIndex
CREATE INDEX "slots_doctorId_status_startsAt_idx" ON "slots"("doctorId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "slots_availabilityId_status_idx" ON "slots"("availabilityId", "status");

-- CreateIndex
CREATE INDEX "slots_startsAt_idx" ON "slots"("startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_rescheduledFromId_key" ON "bookings"("rescheduledFromId");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_confirmationCode_key" ON "bookings"("confirmationCode");

-- CreateIndex
CREATE INDEX "bookings_patientId_status_startsAt_idx" ON "bookings"("patientId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "bookings_doctorId_status_startsAt_idx" ON "bookings"("doctorId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "bookings_slotId_status_idx" ON "bookings"("slotId", "status");

-- CreateIndex
CREATE INDEX "bookings_startsAt_idx" ON "bookings"("startsAt");

-- CreateIndex
CREATE INDEX "reservation_holds_slotId_status_idx" ON "reservation_holds"("slotId", "status");

-- CreateIndex
CREATE INDEX "reservation_holds_patientId_status_idx" ON "reservation_holds"("patientId", "status");

-- CreateIndex
CREATE INDEX "reservation_holds_status_expiresAt_idx" ON "reservation_holds"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "waitlist_entries_doctorId_status_windowStart_idx" ON "waitlist_entries"("doctorId", "status", "windowStart");

-- CreateIndex
CREATE INDEX "waitlist_entries_patientId_status_idx" ON "waitlist_entries"("patientId", "status");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_createdAt_idx" ON "audit_logs"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_idx" ON "outbox_events"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_userId_key_endpoint_key" ON "idempotency_keys"("userId", "key", "endpoint");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availabilities" ADD CONSTRAINT "availabilities_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_availabilityId_fkey" FOREIGN KEY ("availabilityId") REFERENCES "availabilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rescheduledFromId_fkey" FOREIGN KEY ("rescheduledFromId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_holds" ADD CONSTRAINT "reservation_holds_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_holds" ADD CONSTRAINT "reservation_holds_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-authored integrity layer.
--
-- Everything below is the part Prisma cannot express. These are the actual
-- correctness guarantees of the system: they hold even if application code is
-- buggy, deployed at 20 replicas, or bypassed entirely by a psql session.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- INVARIANT 1 — a slot can back at most one CONFIRMED booking, ever.
--
-- This is THE anti-double-booking guarantee. Two concurrent transactions that
-- both believe the slot is free will serialise on this index; the loser gets
-- SQLSTATE 23505, which the API surfaces as 409 Conflict. No amount of
-- application-level racing can defeat it.
-- Cancelled/rescheduled rows are excluded, so a slot can be re-booked freely
-- after release while still keeping the full booking history.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "bookings_one_confirmed_per_slot"
  ON "bookings" ("slotId")
  WHERE "status" = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- INVARIANT 2 — at most one ACTIVE reservation hold per slot.
-- Mirrors invariant 1 for the pre-payment checkout window.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "reservation_holds_one_active_per_slot"
  ON "reservation_holds" ("slotId")
  WHERE "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- INVARIANT 3 — slot identity. A doctor cannot have two live slots starting
-- at the same instant. Also the ON CONFLICT DO NOTHING target that makes bulk
-- slot generation idempotent and safe to retry.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "slots_unique_start_per_doctor"
  ON "slots" ("doctorId", "startsAt")
  WHERE "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- INVARIANT 4 — no overlapping live slots for a doctor.
--
-- Stronger than invariant 3: catches a 30-minute follow-up window that would
-- straddle two 15-minute standard slots. BLOCKED and soft-deleted slots are
-- inert and excluded, so shrinking then re-expanding availability works.
-- Violations raise SQLSTATE 23P01 -> 409 Conflict.
-- ---------------------------------------------------------------------------
ALTER TABLE "slots"
  ADD CONSTRAINT "slots_no_overlap_per_doctor"
  EXCLUDE USING gist (
    "doctorId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE ("deletedAt" IS NULL AND "status" <> 'BLOCKED');

-- ---------------------------------------------------------------------------
-- Domain check constraints — reject impossible rows at the source.
-- ---------------------------------------------------------------------------
ALTER TABLE "slots"
  ADD CONSTRAINT "slots_positive_duration" CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "slots_duration_matches" CHECK ("durationMinutes" > 0),
  ADD CONSTRAINT "slots_buffer_non_negative" CHECK ("bufferMinutes" >= 0);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_positive_duration" CHECK ("endsAt" > "startsAt"),
  -- A cancelled booking must record when and by whom; an active one must not.
  ADD CONSTRAINT "bookings_cancellation_coherent" CHECK (
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledBy" IS NOT NULL)
    OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL)
  );

ALTER TABLE "availabilities"
  ADD CONSTRAINT "availabilities_window_ordered"
    CHECK ("endMinuteOfDay" > "startMinuteOfDay"),
  ADD CONSTRAINT "availabilities_window_within_day"
    CHECK ("startMinuteOfDay" >= 0 AND "endMinuteOfDay" <= 1440),
  ADD CONSTRAINT "availabilities_positive_slot_duration"
    CHECK ("slotDurationMinutes" > 0 AND "slotDurationMinutes" <= 1440),
  ADD CONSTRAINT "availabilities_buffer_non_negative"
    CHECK ("bufferMinutes" >= 0 AND "bufferMinutes" <= 1440),
  ADD CONSTRAINT "availabilities_weekday_range"
    CHECK ("weekday" IS NULL OR ("weekday" BETWEEN 1 AND 7)),
  -- ONE_OFF carries a date and no weekday; RECURRING is the mirror image.
  ADD CONSTRAINT "availabilities_kind_shape" CHECK (
    ("kind" = 'ONE_OFF'   AND "date" IS NOT NULL AND "weekday" IS NULL)
    OR
    ("kind" = 'RECURRING' AND "weekday" IS NOT NULL AND "date" IS NULL)
  ),
  ADD CONSTRAINT "availabilities_effective_range_ordered" CHECK (
    "effectiveFrom" IS NULL OR "effectiveUntil" IS NULL
    OR "effectiveUntil" >= "effectiveFrom"
  );

ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_window_ordered" CHECK ("windowEnd" > "windowStart");

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_attempts_non_negative" CHECK ("attempts" >= 0);

-- ---------------------------------------------------------------------------
-- Hot-path partial indexes.
--
-- The patient-facing "show me free slots" query only ever touches AVAILABLE,
-- non-deleted, future rows. A partial index keeps that scan proportional to
-- open inventory rather than to all history.
-- ---------------------------------------------------------------------------
CREATE INDEX "slots_open_inventory"
  ON "slots" ("doctorId", "startsAt")
  WHERE "status" = 'AVAILABLE' AND "deletedAt" IS NULL;

-- Sweeper index: "which holds have expired?" — tiny, only live holds.
CREATE INDEX "reservation_holds_active_expiry"
  ON "reservation_holds" ("expiresAt")
  WHERE "status" = 'ACTIVE';

-- Relay index: the outbox poller's only query.
CREATE INDEX "outbox_pending_dispatch"
  ON "outbox_events" ("availableAt")
  WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- `updatedAt` maintenance for rows touched by raw SQL.
--
-- Prisma populates @updatedAt in the client, but the booking hot path uses
-- raw `SELECT ... FOR UPDATE` + `UPDATE`. A trigger keeps the column honest
-- regardless of which code path wrote the row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER slots_set_updated_at
  BEFORE UPDATE ON "slots"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER reservation_holds_set_updated_at
  BEFORE UPDATE ON "reservation_holds"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

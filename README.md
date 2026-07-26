# Clinzo — Doctor Slot Scheduling

A production-grade backend for booking online consultations, built around one
hard guarantee:

> **A slot cannot be double-booked. Ever. Under any amount of concurrent load.**

That guarantee is enforced by the database, not by application code, and it is
demonstrated by an automated test that fires 100 simultaneous booking requests
at a single slot and asserts that exactly one succeeds.

```
Tests:       117 unit, 68 integration = 185 (all passing)
Stack:       Node 22 · TypeScript · Express · PostgreSQL 16 · Prisma · Redis 7 · BullMQ · Docker
```

---

## Table of contents

1. [Quick start](#quick-start)
2. [The concurrency guarantee](#the-concurrency-guarantee)
3. [Architecture](#architecture)
4. [Database design](#database-design)
5. [Slot generation](#slot-generation)
6. [Booking flow](#booking-flow)
7. [Reservation holds](#reservation-holds)
8. [Cancellation and rescheduling](#cancellation-and-rescheduling)
9. [Retroactive availability changes](#retroactive-availability-changes)
10. [Timezones](#timezones)
11. [Redis: locks, cache, rate limits](#redis-locks-cache-rate-limits)
12. [Background jobs and events](#background-jobs-and-events)
13. [API reference](#api-reference)
14. [Security](#security)
15. [Observability](#observability)
16. [Testing](#testing)
17. [Deployment and scaling](#deployment-and-scaling)
18. [Trade-offs and what I would do next](#trade-offs-and-what-i-would-do-next)

---

## Quick start

### Docker (everything, one command)

```bash
git clone <repository-url> && cd Clinzo

# Generate real JWT secrets. The app deliberately refuses to boot in
# production with the placeholders from .env.example.
./scripts/generate-secrets.sh

docker compose up -d --build
```

That starts Postgres, Redis, the migration job, the API and the worker.

```bash
curl localhost:3000/health        # {"status":"healthy", ...}
open  http://localhost:3000/docs  # Swagger UI
```

### Local development

```bash
npm install
cp .env.example .env && ./scripts/generate-secrets.sh

docker compose up -d postgres redis   # dependencies only
npm run prisma:migrate                # apply schema + integrity constraints
npm run seed                          # 2 doctors, 12 patients, ~600 slots

npm run dev          # API   → http://localhost:3000
npm run dev:worker   # worker (separate terminal)
```

Seeded logins — password `ClinzoDemo2026!`:

| Account                                          | Role    | Timezone                             |
| ------------------------------------------------ | ------- | ------------------------------------ |
| `dr.mehta@clinzo.test`                           | DOCTOR  | Asia/Kolkata (15 min + 5 min buffer) |
| `dr.okafor@clinzo.test`                          | DOCTOR  | America/New_York (30 min, no buffer) |
| `patient1@clinzo.test` … `patient12@clinzo.test` | PATIENT | mixed                                |
| `admin@clinzo.test`                              | ADMIN   | UTC                                  |

### Try it

```bash
# Log in
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"patient1@clinzo.test","password":"ClinzoDemo2026!"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['tokens']['accessToken'])")

# Find free slots — note the dual timezone rendering
curl -s "localhost:3000/api/v1/doctors/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/slots\
?from=$(date -u -v+1d +%Y-%m-%dT00:00:00Z)&to=$(date -u -v+3d +%Y-%m-%dT00:00:00Z)\
&timezone=Europe/Berlin"

# Book one
curl -s -X POST localhost:3000/api/v1/bookings \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slotId":"<slot-id>","reasonForVisit":"Follow-up"}'
```

### Commands

| Command                                                             | Purpose                                  |
| ------------------------------------------------------------------- | ---------------------------------------- |
| `npm run dev` / `npm run dev:worker`                                | Hot-reloading API / worker               |
| `npm run build` / `npm start`                                       | Compile / run compiled output            |
| `npm test`                                                          | Everything                               |
| `npm run test:unit`                                                 | Unit only — no database needed           |
| `npm run test:integration`                                          | Integration, incl. the concurrency proof |
| `npm run lint` / `npm run format` / `npm run typecheck`             | Quality gates                            |
| `npm run prisma:migrate` / `npm run seed` / `npm run prisma:studio` | Database                                 |

---

## The concurrency guarantee

Three layers defend the invariant, ordered by distance from the data. **Only
the third is load-bearing** — the first two exist so the third rarely fires.

```
                    100 simultaneous "book slot X" requests
                                    │
        ┌───────────────────────────▼───────────────────────────┐
        │ LAYER 1 — Redis distributed lock  (SET NX PX)          │
        │ Serialises contenders in microseconds, before any      │
        │ database connection is taken.                          │
        │ Purpose: THROUGHPUT.  Not trusted for correctness.     │
        └───────────────────────────┬───────────────────────────┘
                                    │ one at a time
        ┌───────────────────────────▼───────────────────────────┐
        │ LAYER 2 — SELECT … FOR UPDATE inside a transaction     │
        │ Locks the slot row, re-reads its status.               │
        │ Purpose: closes the check-then-act window.             │
        └───────────────────────────┬───────────────────────────┘
                                    │
        ┌───────────────────────────▼───────────────────────────┐
        │ LAYER 3 — PARTIAL UNIQUE INDEX                         │
        │   CREATE UNIQUE INDEX bookings_one_confirmed_per_slot  │
        │     ON bookings ("slotId") WHERE status = 'CONFIRMED'; │
        │ Purpose: THE GUARANTEE. Holds against application      │
        │ bugs, N replicas, Redis outages, and psql.             │
        └───────────────────────────┬───────────────────────────┘
                                    │
                   1 × 201 Created     99 × 409 Conflict
```

### Why the Redis lock is _not_ the guarantee

Lease-based distributed locks cannot be made safe under arbitrary failure. A
process can be paused by GC past its lock TTL and resume believing it still
holds the lock. This is a well-known, unfixable property — designs that treat
Redlock as a correctness mechanism are the ones that double-book.

So the lock is treated as what it is: a way to stop 100 contenders from each
opening a transaction and holding a pooled connection while they queue on the
same Postgres row lock. **Delete Redis entirely and no double booking is
possible** — bookings simply fail more often with 409.

There is a test for exactly this claim:

```ts
it('survives with the Redis lock removed, proving Postgres is the guarantee', ...)
```

It stubs `lockService.withLock` to a pass-through — no mutual exclusion at
all — fires 30 concurrent bookings, and still asserts exactly one succeeds.

### Pessimistic vs optimistic locking — and why both are used

|                                                            | Optimistic                                            | Pessimistic |
| ---------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| Read version, write `WHERE version = ?`, retry on mismatch | Read row with `FOR UPDATE`, others block              |
| Best when contention is **rare**                           | Best when contention is **concentrated**              |
| Losers burn a full transaction before finding out          | Losers wait briefly, then learn the truth in one read |

**Slot booking is concentrated contention by nature.** A popular doctor's 10:00
Monday slot is precisely what everyone wants at precisely the same moment.
Under that load optimistic locking degrades badly: every loser wastes a full
transaction, and retries amplify the load that caused the conflict. Worse, the
correct outcome is _not_ a retry — a booked slot stays booked, so retrying is
guaranteed waste.

So **booking uses pessimistic locking**. The critical section is ~1 ms of index
lookups plus two inserts, so the queue drains fast.

**Optimistic locking is used where it actually fits:**

- `Availability.version` — two clinic administrators editing the same window is
  rare, and a stale write should be _rejected_ (409) rather than serialised.
- `Slot.version` — bumped on every transition so readers can detect staleness
  without taking a lock.

### Every invariant the database enforces

From [`prisma/migrations/*/migration.sql`](prisma/migrations):

| Constraint                                                    | Guarantees                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bookings_one_confirmed_per_slot` (partial unique)            | No double booking. Scoped to `CONFIRMED`, so a cancelled slot can be resold.              |
| `reservation_holds_one_active_per_slot` (partial unique)      | One checkout at a time per slot.                                                          |
| `slots_unique_start_per_doctor` (partial unique)              | Slot identity; also the `ON CONFLICT DO NOTHING` target that makes generation idempotent. |
| `slots_no_overlap_per_doctor` (**GiST EXCLUDE**)              | No overlapping live slots — catches a 30-min follow-up straddling two 15-min slots.       |
| `bookings_cancellation_coherent` (check)                      | A cancelled booking must record when and by whom; an active one must not.                 |
| `availabilities_kind_shape` (check)                           | `ONE_OFF` carries a date and no weekday; `RECURRING` is the mirror image.                 |
| `slots_positive_duration`, `availabilities_window_ordered`, … | Impossible rows are rejected at the source.                                               |

The exclusion constraint is worth highlighting — Prisma cannot express it, so
it is hand-written:

```sql
ALTER TABLE "slots" ADD CONSTRAINT "slots_no_overlap_per_doctor"
  EXCLUDE USING gist (
    "doctorId"                              WITH =,
    tstzrange("startsAt", "endsAt", '[)')   WITH &&
  ) WHERE ("deletedAt" IS NULL AND "status" <> 'BLOCKED');
```

CI additionally asserts the anti-double-booking index exists after migration —
the one failure the test suite could not otherwise detect, because a test
cannot notice an index that never existed.

---

## Architecture

Strict layering. Dependencies point one direction only.

```
  HTTP
   │
   ▼
 routes/            middleware chain: authenticate → authorize → validate
   │
   ▼
 controllers/       HTTP ⇄ service arguments. No business logic. No database.
   │
   ▼
 services/          ALL business logic. Transactions. Orchestration.
   │
   ▼
 repositories/      Prisma queries. Soft-delete filtering. No business rules.
   │
   ▼
 PostgreSQL
```

```
src/
├── config/          env (Zod-validated), prisma, redis, metrics
├── controllers/     thin HTTP adapters
├── routes/          route definitions + middleware wiring
├── services/        business logic
│   ├── slot-generator.ts    ← pure, no I/O, exhaustively unit-tested
│   ├── booking.service.ts   ← the concurrency-critical path
│   ├── hold.service.ts      ← reservation holds
│   ├── availability.service.ts
│   ├── lock.service.ts      ← Redis mutex with Lua fencing
│   ├── auth.service.ts / token.service.ts
│   └── slot.service.ts / waitlist.service.ts
├── repositories/    data access, one per aggregate
├── middlewares/     auth, validate, error, rate-limit, idempotency, context
├── validators/      Zod schemas
├── events/          domain events, publisher abstraction, consumers
├── jobs/            BullMQ queues, workers, processors, schedulers
├── utils/           errors, logger, time, crypto, http
├── docs/            OpenAPI document
├── app.ts           Express assembly (no listen — testable)
└── server.ts        lifecycle: boot, graceful shutdown
```

Two deliberate structural choices:

**`slot-generator.ts` is pure.** No Prisma, no Redis, no clock reads beyond
what is passed in. Slot arithmetic is fiddly and its edge cases (DST gaps,
buffer boundaries, windows too short) are the ones most likely to be wrong, so
they are testable without a database. 33 unit tests cover it.

**`app.ts` exports the app without listening.** Integration tests drive the
real middleware stack via supertest with no open port.

---

## Database design

```
User ──1:1── Doctor ──1:N── Availability ──1:N── Slot ──1:N── Booking
 │                              (intent)        (materialised)   (claim)
 ├──1:1── Patient ─────────────────────────────────1:N───────────┘
 └──1:N── RefreshToken

Slot ──1:N── ReservationHold          AuditLog · OutboxEvent · IdempotencyKey
Doctor/Patient ──1:N── WaitlistEntry
```

**Identity is split from domain profile.** `User` owns credentials and role;
`Doctor` / `Patient` own domain attributes. Auth concerns stay out of the
scheduling aggregate.

**Three tables, three lifecycles, never conflated:**

| Table          | Represents                                                                      | Lifecycle                                               |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Availability` | The doctor's **intent** — a recurring or one-off window in their local timezone | Edited rarely, by the doctor                            |
| `Slot`         | A **materialised, bookable unit** in UTC                                        | Generated from availability; the row bookers contend on |
| `Booking`      | A patient's **claim** on a slot                                                 | Created, cancelled, rescheduled by patients             |

Also present: soft deletes (`deletedAt`) on anything with audit or historical
value; `version` columns for optimistic locking; `timestamptz` throughout;
indexes tuned to the actual access patterns, including partial indexes so the
hot "free slots for doctor D" query scans open inventory rather than history.

### Materialised vs computed slots

Slots are **stored**, not derived on read. The alternative — computing
availability-minus-bookings per request — is tempting because nothing needs
regenerating when a window changes. It was rejected because:

1. **A slot must be a lockable row.** `SELECT … FOR UPDATE` and a unique index
   need something to point at. A computed slot has no identity, so the only
   place to enforce "one booking per slot" would be application code — exactly
   what breaks under concurrency. _This alone decides it._
2. Listing free slots becomes one partial-index scan instead of an
   expansion-and-subtraction per request.
3. Per-slot state (`HELD`, `BLOCKED`, a blocking reason) has somewhere to live.

The cost: generation must be explicit and idempotent, and the table grows with
`horizon × doctors`. Both are handled — writes use `ON CONFLICT DO NOTHING`,
and generation is bounded by `SLOT_GENERATION_HORIZON_DAYS` (default 60).

---

## Slot generation

Given a window `[start, end)` in local wall-clock minutes, a `duration` and a
trailing `buffer`:

```
stride  = duration + buffer
slot_i  = [start + i·stride,  start + i·stride + duration)
emitted while (start + i·stride + duration) <= end
```

Worked example — **10:00–18:00, 15 min duration, 5 min buffer**:

```
10:00–10:15   [5 min buffer]   10:20–10:35   [5 min buffer]   10:40–10:55  …
```

Two boundary rules, both asserted in tests because both are easy to get wrong:

**1. A slot must fit entirely inside the window.** A 10:00–17:00 window with
50-minute consultations ends at 16:40, not with a truncated 17:50–18:00.
Patients are never sold a short appointment.

**2. Buffer is trailing and never required after the last slot.** A
10:00–10:35 window (15 + 5) yields 10:00–10:15 _and_ 10:20–10:35 — the second
fits even though there is no room for its trailing buffer, because that buffer
would fall outside the window where it protects nothing.

### Configurability

Duration and buffer are per-`Availability`, defaulting to per-`Doctor`
settings, defaulting to environment config. Nothing is hardcoded. A doctor can
run 15-minute follow-ups on Monday and 45-minute first visits on Tuesday by
creating two windows with different `appointmentType`.

---

## Booking flow

```
Patient taps "Book"
      │
      ▼
[ Redis lock  SET NX PX ]  ← contenders serialise here, no DB connection held
      │
      ▼
BEGIN TRANSACTION
      │
      ├─ SELECT … FOR UPDATE on slot         ← row lock
      ├─ verify: AVAILABLE? not started? lead time? patient free?
      ├─ consume reservation hold (if any)
      ├─ INSERT booking                      ← unique index adjudicates
      ├─ UPDATE slot → BOOKED  (guarded on previous status)
      ├─ INSERT audit_log
      └─ INSERT outbox_event                 ← same transaction as the booking
      │
COMMIT
      │
      ▼
[ release lock ]  →  201 Created   |   409 SLOT_UNAVAILABLE
```

Nothing slow happens inside the critical section — no email, no payment call,
no cache write. Side effects go to the outbox and run afterwards.

A **409 is final for that slot.** The slot is gone; retrying the same slot will
never succeed. Clients should refresh the listing and offer an alternative.
This is stated explicitly in the OpenAPI description.

---

## Reservation holds

Payment is slow and can fail. Booking only _after_ payment means two patients
can both reach a payment screen for one slot. Booking _before_ payment means an
abandoned checkout destroys inventory permanently. A hold is the middle ground.

```
POST /holds  →  slot HELD, Redis key with TTL (default 120s)
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
  payment ok      payment fails     patient leaves
        │               │                │
  POST /bookings   TTL expires      DELETE /holds/:id
  {holdId}              │                │
        ▼               ▼                ▼
     BOOKED        AVAILABLE         AVAILABLE
```

**Redis owns expiry.** The key is written with `SET NX PX <ttl>`, so the hold
disappears with _no code running at all_ — no cron, no worker, no clock skew.
Even a total application outage cannot strand a slot in `HELD` forever.

Two reconciling mechanisms cover what Redis expiry alone cannot (Redis cannot
write to Postgres):

1. A **BullMQ delayed job** scheduled for the expiry instant flips the row back
   to `AVAILABLE` — the fast path, milliseconds after lapse.
2. A **periodic sweeper** (every 30 s) catches anything the job missed: worker
   restart, lost queue, exhausted retries.

Both are idempotent and both re-check `heldUntil <= now`, so a late job cannot
release a hold that was renewed. The redundancy is the point — a slot stuck in
`HELD` is invisible inventory that nobody can book and nobody is told about.

Patients are capped at 3 concurrent holds, to prevent inventory hoarding.

---

## Cancellation and rescheduling

### Cancellation

The slot returns to sale immediately — **conditionally**. A slot that is
`BLOCKED` (the doctor withdrew that time after it was booked) stays blocked.
Blindly setting `AVAILABLE` would resell a slot the doctor no longer offers.

A `slot.released` event is published, which is what the waitlist listens for.

### Rescheduling

Preserves the existing appointment throughout:

1. Lock both slots **in deterministic id order** — two patients swapping slots
   simultaneously would otherwise acquire the pair in opposite orders and
   deadlock.
2. Validate the target (same doctor, available, patient free).
3. Mark the original `RESCHEDULED` — freeing it from the partial unique index.
4. Insert the new booking, linked via `rescheduledFromId`.
5. Claim the target slot; release the original.

**Failure at any point leaves the patient holding their original
appointment**, never nothing. There is a test for this: when the target is
taken mid-attempt, the original booking and slot are asserted unchanged.

The original ends as `RESCHEDULED`, not `CANCELLED` — reporting can then
distinguish "patient dropped out" from "patient moved".

---

## Retroactive availability changes

A doctor shrinks Monday from 10:00–18:00 to 10:00–14:00. They have already sold
a 15:00 appointment. Three options exist:

|     | Behaviour                                              | Verdict                                                                                                                 |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| (a) | Auto-cancel affected bookings                          | **Rejected.** A confirmed consultation is a commitment between two people; a UI interaction must not silently break it. |
| (b) | Refuse the edit while bookings exist                   | **Rejected.** One appointment would freeze the doctor's entire schedule.                                                |
| (c) | Apply to unbooked capacity, keep bookings, report them | **Implemented.**                                                                                                        |

Concretely:

- Future **unbooked** slots outside the new window → `BLOCKED`
  (`blockedReason: 'availability_changed'`).
- Future **booked** slots → untouched, returned as `orphanedBookings` so the
  doctor is told exactly what to resolve by hand.
- **Past slots** → never modified. History is immutable.
- Widening a window generates the newly-covered slots (idempotently).

```jsonc
// PUT /availability/:id  →  200
{
  "slotsBlocked": 16,
  "slotsGenerated": 0,
  "orphanedBookings": [{ "bookingId": "…", "slotId": "…", "startsAt": "2026-03-02T09:30:00.000Z" }],
}
```

**The trade-off**, stated plainly: this leaves a transient inconsistency — the
doctor's stated availability and their actual calendar disagree until the
orphans are resolved. That inconsistency is _visible, bounded and actionable_,
which is strictly better than silent cancellation or a hard block. A production
follow-up would surface these in the doctor's dashboard with one-tap
"propose new time" flows.

---

## Timezones

**Instants are UTC. Intent is local.** Everything follows from that.

A doctor saying "Mondays, 10:00–18:00, Asia/Kolkata" is expressing intent in
wall-clock terms. The correct UTC instant changes across DST boundaries, so
availability stores **minutes-from-local-midnight plus the IANA zone**, and
resolves to an instant per concrete date. Storing a fixed offset instead would
shift every appointment by an hour twice a year.

```
Storage:      startMinuteOfDay = 600, timezone = 'Asia/Kolkata'
Resolution:   2026-03-02 + 600 min in Asia/Kolkata → 2026-03-02T04:30:00Z
Presentation: rendered in viewer's zone AND doctor's zone
```

### The bug the tests caught

Luxon's `plus({ minutes })` measures **elapsed** time, not wall-clock. On a
spring-forward day, "midnight + 180 minutes" is `04:00` local, not `03:00` —
which would silently shift every slot after the transition by an hour. The fix
is to build from calendar components via `DateTime.fromObject`. A test asserts
the correct behaviour on `2026-03-08` in `America/New_York`.

### DST handling

- **Spring forward** — starts inside the skipped hour do not exist and are
  reported in `skippedForDstGap` rather than silently invented.
- **Fall back** — the repeated hour resolves to its first occurrence, keeping
  slots strictly ordered. Consequence: roughly one hour of inventory is lost on
  that date per year. Accepted, to keep local times unambiguous.
- **Duration is elapsed time.** A 15-minute consultation is 15 real minutes
  regardless of what the clock does in between.

### Ambiguous abbreviations are rejected

`IANAZone.isValidZone('IST')` returns `true` — but `IST` is _Israel_ Standard
Time (UTC+2), while nearly everyone typing it means _India_ (UTC+5:30). A
3.5-hour error on every appointment. `CST` is claimed by three regions. So the
`Area/Location` form is required; `UTC` is the only bare exception.

### Presentation

Every slot and booking is returned three ways:

```jsonc
{
  "startsAt": "2026-07-27T04:30:00.000Z", // canonical UTC
  "local": { "timezone": "Europe/Berlin", "startTime": "06:30" },
  "doctorLocal": { "timezone": "Asia/Kolkata", "startTime": "10:00" },
}
```

Clients display `local` and send back the UTC instant or the slot id. They
never re-derive a time — which is where cross-timezone video consultations
usually go wrong.

---

## Redis: locks, cache, rate limits

| Use                    | Mechanism                                     | Notes                                                                                                                                                      |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Distributed lock**   | `SET NX PX` + Lua compare-and-delete          | Fenced release: a lock is deleted only if the stored token still matches. Without this a slow holder whose lease expired would free _someone else's_ lock. |
| **Reservation holds**  | `SET NX EX <ttl>`                             | The key's TTL _is_ the hold expiry.                                                                                                                        |
| **Slot listing cache** | JSON, short TTL, version-counter invalidation | Invalidation is one `INCR`, not a keyspace scan.                                                                                                           |
| **Rate limiting**      | `rate-limit-redis`                            | Shared across replicas.                                                                                                                                    |
| **Event fan-out**      | pub/sub                                       | Observational only; durable work goes to BullMQ.                                                                                                           |

**Cache invalidation is O(1).** Keys embed a per-doctor version counter; an
availability change bumps it and stale entries age out on their own TTL.
`SCAN`-and-delete would be O(keyspace) — the classic way to stall production
Redis.

Cache failures never fail a request: reads fall through to Postgres, and
booking always re-validates against the database, so a stale listing can only
cost a user one 409.

---

## Background jobs and events

### The transactional outbox

A booking must both commit _and_ trigger a confirmation email. Doing the email
inside the transaction couples commit latency to a third party; doing it after
commit means a crash in between silently loses it — the classic dual-write
failure.

```
BEGIN
  INSERT booking
  INSERT outbox_event      ← same transaction: both commit or neither does
COMMIT
      │
      ▼
Relay (every 2s):  SELECT … FOR UPDATE SKIP LOCKED
      │            → publish → enqueue durable jobs → mark PUBLISHED
      ▼
Workers: email, SMS, waitlist notification
```

`FOR UPDATE SKIP LOCKED` is what makes the relay horizontally scalable —
several relay processes poll the same table and each takes a disjoint batch.
No leader election.

The trade is **at-least-once delivery**: consumers must be idempotent. Job ids
are derived from the event id, so a redelivered event produces the same job
rather than a duplicate notification. That is a far easier property to
guarantee than distributed atomicity.

### Queues

Separated by **failure profile**, not by feature. Notifications talk to flaky
third parties and need aggressive retries; hold expiry is a local write with a
sweeper safety net. One queue would force one retry policy on both — and a
notification backlog would delay slot releases, directly costing revenue.

| Queue           | Concurrency          | Retries          | Jobs                                                                 |
| --------------- | -------------------- | ---------------- | -------------------------------------------------------------------- |
| `notifications` | `WORKER_CONCURRENCY` | 5, exp. from 2 s | confirmation, cancellation, reschedule, reminder, waitlist alert     |
| `hold-expiry`   | 5                    | 3, exp. from 1 s | delayed expiry; 30 s sweeper                                         |
| `outbox-relay`  | 1                    | 3                | relay batch every 2 s                                                |
| `maintenance`   | 1                    | 3                | token/idempotency/outbox purge, reminder scheduling, waitlist expiry |

Repeatable jobs are keyed by name + pattern, so registering the same schedule
from every replica converges on one entry — safe to call at boot without a
designated "cron pod".

### Kafka-ready abstraction

`EventPublisher` is shaped around what **Kafka** needs, not what Redis needs,
so the migration is a swap rather than a redesign:

```ts
interface PublishableEvent {
  topic: string; // Kafka topic / Redis channel
  key: string; // partition key = aggregate id → ordering
  eventType: string;
  payload: unknown;
  headers: Record<string, string>; // event-id → consumer deduplication
}
```

Partitioning by aggregate id guarantees all events for one booking are consumed
in order — the property that is painful to retrofit later. The outbox relay
already speaks `PublishableEvent`, so it needs no changes.

### Notifications

Orchestration is real: recipients resolved, content composed with correct
per-recipient timezones, failures thrown so BullMQ retries, addresses redacted
in logs. The final hop to SendGrid/Twilio is behind a `deliver()` seam — a
deliberate boundary, so the repository runs without external accounts. Swapping
in a provider is one function body.

---

## API reference

Interactive docs at **`/docs`**; raw spec at **`/openapi.json`**.
Base path: `/api/v1`.

| Method   | Endpoint                                     | Auth           | Purpose                           |
| -------- | -------------------------------------------- | -------------- | --------------------------------- |
| `POST`   | `/auth/register/patient`                     | —              | Register patient                  |
| `POST`   | `/auth/register/doctor`                      | —              | Register doctor                   |
| `POST`   | `/auth/login`                                | —              | Obtain tokens                     |
| `POST`   | `/auth/refresh`                              | —              | Rotate refresh token              |
| `POST`   | `/auth/logout`                               | —              | Revoke one session                |
| `POST`   | `/auth/logout-all`                           | any            | Revoke all sessions               |
| `GET`    | `/doctors`                                   | —              | Directory (paginated, filterable) |
| `GET`    | `/doctors/:id`                               | —              | Doctor profile                    |
| `GET`    | `/doctors/:id/slots`                         | —              | **Bookable slots**                |
| `GET`    | `/doctors/me`                                | DOCTOR         | Own profile                       |
| `GET`    | `/patients/me`                               | PATIENT        | Own profile                       |
| `POST`   | `/availability`                              | DOCTOR         | Create window + generate slots    |
| `GET`    | `/availability`                              | DOCTOR         | List own windows                  |
| `PUT`    | `/availability/:id`                          | DOCTOR         | Edit (optimistic-locked)          |
| `DELETE` | `/availability/:id`                          | DOCTOR         | Withdraw window                   |
| `GET`    | `/availability/slots`                        | DOCTOR         | Own calendar, all statuses        |
| `POST`   | `/holds`                                     | PATIENT        | Reserve for checkout              |
| `GET`    | `/holds/me`                                  | PATIENT        | Active holds                      |
| `DELETE` | `/holds/:id`                                 | PATIENT        | Release hold                      |
| `POST`   | `/bookings`                                  | PATIENT        | **Book a slot**                   |
| `GET`    | `/bookings/me`                               | PATIENT/DOCTOR | Own bookings                      |
| `GET`    | `/bookings/:id`                              | party/ADMIN    | One booking                       |
| `DELETE` | `/bookings/:id`                              | party/ADMIN    | Cancel                            |
| `PUT`    | `/bookings/:id/reschedule`                   | PATIENT        | Move to another slot              |
| `POST`   | `/waitlist`                                  | PATIENT        | Join waitlist                     |
| `GET`    | `/waitlist/me`                               | PATIENT        | Own entries                       |
| `DELETE` | `/waitlist/:id`                              | PATIENT        | Leave waitlist                    |
| `GET`    | `/health` · `/health/live` · `/health/ready` | —              | Probes                            |
| `GET`    | `/metrics`                                   | —              | Prometheus                        |

### Response envelopes

```jsonc
// success
{ "success": true, "data": { … }, "meta": { "pagination": { … } } }

// failure
{ "success": false,
  "error": { "code": "SLOT_UNAVAILABLE", "message": "…",
             "details": { "slotId": "…" }, "requestId": "…" } }
```

### Status codes

| Code  | Meaning here                                                             |
| ----- | ------------------------------------------------------------------------ |
| `400` | Malformed request (e.g. invalid JSON)                                    |
| `401` | Missing/invalid/expired token — `details.reason` distinguishes           |
| `403` | Authenticated but not permitted                                          |
| `404` | Not found, **or** not a party to it (avoids id enumeration)              |
| `409` | **Slot taken**, stale version, idempotency conflict, double-cancel       |
| `422` | Validation or business-rule violation (past slot, lead time, size limit) |
| `429` | Rate limit, or lock acquisition timed out                                |
| `500` | Defect — generic message to client, full detail in logs                  |
| `503` | Postgres or Redis unreachable                                            |

### Idempotency

`POST /bookings` and `PUT /bookings/:id/reschedule` accept `Idempotency-Key`.

| Situation                      | Result                                                  |
| ------------------------------ | ------------------------------------------------------- |
| Same key, same body, completed | Replay original response + `Idempotency-Replayed: true` |
| Same key, same body, in flight | `409` — poll, don't block a connection                  |
| Same key, **different** body   | `409 IDEMPOTENCY_CONFLICT` — client bug                 |
| Failed request                 | Key released, so a genuine retry can succeed            |

Keys are scoped per user (client-generated keys must not collide across
clients) and hashed with a **key-order-insensitive** canonical stringify, so a
client reordering its JSON is not told its retry is a conflict.

---

## Security

| Concern             | Measure                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Passwords           | bcrypt, cost 12, per-password salt                                                                                                         |
| Tokens              | HS256, **separate secrets** for access/refresh + `typ` claim, algorithm pinned (blocks `alg:none` confusion), issuer/audience verified     |
| Refresh tokens      | SHA-256 hashed at rest, **rotated on every use**, reuse revokes the whole family                                                           |
| Account enumeration | Login is timing- and response-identical for wrong password vs unknown account (real bcrypt comparison against a decoy hash)                |
| Mass assignment     | Zod strips unknown keys — tested by attempting `role: "ADMIN"` at registration                                                             |
| SQL injection       | Prisma parameterises everything; the few raw queries use tagged templates                                                                  |
| Rate limiting       | Redis-backed (in-memory would permit N× the limit across N replicas); auth keyed on IP **+** email so an attacker cannot lock a victim out |
| Headers             | Helmet, HSTS + CSP in production                                                                                                           |
| CORS                | Explicit allowlist; credentials enabled                                                                                                    |
| Proxy trust         | `trust proxy: 1`, not `true` — trusting the whole chain lets a client spoof its IP and defeat rate limiting                                |
| Body size           | 100 kb cap                                                                                                                                 |
| Secret leakage      | Pino redaction on ~15 paths; request headers excluded wholesale                                                                            |
| Boot safety         | Process refuses to start in production with `.env.example` placeholders                                                                    |
| Container           | Non-root `node` user, `dumb-init` PID 1, no compiler or source in runtime image                                                            |

Secrets are read from the environment only; `.env` is gitignored; `.env.example`
carries placeholders that are actively rejected in production.

---

## Observability

**Health** — liveness and readiness are **separate on purpose**. Conflating
them causes outages: if `/health` checks Postgres and the orchestrator uses it
for liveness, a brief database blip restarts every replica, turning a
recoverable dependency failure into a full outage.

- `/health/live` — process alive. No dependencies checked.
- `/health/ready` — dependencies checked. 503 removes the pod from the load
  balancer without restarting it.

**Metrics** (`/metrics`, Prometheus) — RED for HTTP plus domain counters chosen
to answer the questions this system actually gets asked in an incident:

| Metric                                    | Answers                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clinzo_booking_attempts_total{result}`   | Are bookings succeeding?                                                                                                                               |
| `clinzo_booking_race_losses_total{stage}` | **Is the last line of defence firing?** Non-zero-but-low is _healthy_ — it proves the constraint is live. A spike means lock contention is being lost. |
| `clinzo_lock_wait_duration_seconds`       | Is contention growing?                                                                                                                                 |
| `clinzo_reservation_holds_total{event}`   | Are holds converting or expiring?                                                                                                                      |
| `clinzo_outbox_backlog`                   | Is the relay keeping up?                                                                                                                               |
| `clinzo_slot_cache_total{result}`         | Cache hit rate                                                                                                                                         |

Route labels use the Express **pattern** (`/bookings/:id`), never the concrete
URL — a million booking ids would otherwise become a million time series and
take the metrics endpoint down within a day.

**Logs** — Pino JSON, request id (honoured from upstream when UUID-shaped and
echoed back), latency, user id, role. Probes and metrics scrapes are excluded
so they don't dominate volume.

---

## Testing

```bash
npm run test:unit         # 117 tests, no infrastructure
npm run test:integration  #  51 tests, real Postgres + real Redis
npm test                  # everything
```

Integration tests use a dedicated `clinzo_test` database, created and migrated
with **`prisma migrate deploy`** — the same command production runs, so the
schema under test is byte-identical, constraints included. Generating it any
other way would invalidate the whole exercise.

Isolation is by **truncation**, not transaction rollback. Rollback is faster
but fundamentally incompatible with what this suite exists to prove:
concurrency tests need genuinely independent connections committing real
transactions.

### The concurrency proof

[`tests/integration/booking-concurrency.test.ts`](tests/integration/booking-concurrency.test.ts)

```
✓ allows exactly one of 100 simultaneous requests to book the same slot
✓ holds the invariant at the service layer, bypassing HTTP entirely
✓ survives with the Redis lock removed, proving Postgres is the guarantee
✓ rejects a second CONFIRMED booking at the database level
✓ lets a slot be re-booked after cancellation, and only once again
✓ distributes correctly when many patients contend for many slots
✓ prevents one patient from double-booking overlapping times
✓ serialises contenders through Redis rather than piling onto Postgres
```

Nothing is mocked. The guarantee is a property of Postgres, and only Postgres
can demonstrate it. Assertions are **absolute** — exactly one success, not "at
most one"; every other request 409, with no 500s or timeouts. One extra
confirmed booking means a real patient arrives to find their appointment
double-sold.

### Coverage elsewhere

| Area                   | Highlights                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Slot generation (33)   | Boundary rules, every duration×buffer combination, DST gap/overlap, elapsed-duration invariant |
| Time (30)              | Offset resolution, DST transitions, half-open intervals, ambiguous-abbreviation rejection      |
| Crypto (14)            | Salting, key-order-insensitive hashing, confirmation-code alphabet                             |
| Errors (20)            | Every constraint → HTTP mapping; retryable vs not                                              |
| Auth (17)              | Rotation, reuse detection, enumeration resistance, forged-token rejection, mass assignment     |
| Availability (17)      | Generation, overlap rules, **retroactive changes**, optimistic locking                         |
| Booking lifecycle (26) | Cancel, reschedule atomicity, holds, sweeper, idempotency                                      |

---

## Deployment and scaling

```
        ┌──────────┐
        │    LB    │
        └────┬─────┘
     ┌───────┼───────┐
     ▼       ▼       ▼
   API×N   API×N   API×N        stateless — scale on request rate
     └───────┼───────┘
     ┌───────┴────────┐
     ▼                ▼
 PostgreSQL        Redis         Worker×M  — scale on event volume
 (primary +        (cluster)
  replicas)
```

### Where it breaks first, and what to do

| Bottleneck               | Threshold                       | Response                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API CPU**              | —                               | Stateless; add replicas                                                                                                                                                                                                       |
| **Postgres writes**      | ~5–10 k bookings/s              | Single primary is the ceiling. Partition `slots`/`bookings` by month (most queries are date-ranged, so pruning is very effective); then shard by `doctorId` — the natural key, since every booking touches exactly one doctor |
| **Postgres reads**       | —                               | Read replicas for slot listings; booking must stay on the primary                                                                                                                                                             |
| **`slots` table growth** | `doctors × horizon × slots/day` | Roll off past slots to cold storage; reduce horizon; generate lazily per doctor on first query                                                                                                                                |
| **Redis**                | —                               | Cluster with hash tags so a doctor's lock and cache keys colocate                                                                                                                                                             |
| **Workers**              | —                               | Independent scaling; the relay's `SKIP LOCKED` already supports N processes                                                                                                                                                   |

**Rolling deploys are safe.** `SIGTERM` → stop accepting → drain in-flight →
close dependencies, with a hard timeout. `dumb-init` as PID 1 ensures the
signal actually arrives. Without this, a process killed mid-booking leaves a
slot row locked until Postgres times it out, blocking every other booker.

**Migrations** run as a separate compose service / init container, gated by
`depends_on: service_completed_successfully`.

---

## Trade-offs and what I would do next

Decisions where a reasonable engineer could choose differently:

| Decision                    | Chosen                                               | Trade-off                                                                                                                            |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Slot representation         | Materialised                                         | Storage + regeneration cost, bought a lockable row — the thing that makes the guarantee possible                                     |
| Locking                     | Pessimistic for booking, optimistic for availability | Matched to each contention profile rather than picking one globally                                                                  |
| Redis lock                  | Explicitly **not** the guarantee                     | Some may see it as redundant; it is a throughput optimisation and is documented and tested as such                                   |
| Retroactive edits           | Keep bookings, report orphans                        | Transient visible inconsistency, in exchange for never breaking a commitment                                                         |
| Waitlist                    | Broadcast to all candidates                          | Losers get a notification for a slot they may not get — but one unresponsive patient cannot block a freed slot for minutes           |
| Event delivery              | At-least-once outbox                                 | Consumers must be idempotent; far easier than distributed atomicity                                                                  |
| bcryptjs over native bcrypt | Pure JS                                              | ~2× slower hashing, in exchange for no node-gyp toolchain in any image or CI runner. Isolated to one file; swapping back is one line |
| Idempotency                 | Optional header                                      | Adopting it is not a breaking change; clients that send a key get the guarantee                                                      |
| DST fall-back               | First occurrence                                     | ~1 hour of inventory lost per year per doctor, in exchange for unambiguous local times                                               |
| OpenAPI                     | Hand-authored                                        | Can drift from Zod schemas; generation describes _types_, and here the _behaviour_ (what a 409 means) is what matters                |

### Next steps

1. **Payments** — the hold flow is designed for it; add a provider webhook that
   consumes the hold on success.
2. **Orphaned-booking resolution UI** — one-tap "propose new time" so
   retroactive changes close the loop.
3. **Doctor-side calendar sync** — Google/Outlook, treating external busy time
   as another source of `BLOCKED`.
4. **Multi-doctor booking** — see below.
5. **Partitioning** `slots` and `bookings` by month before the table gets large.
6. **Real notification providers** behind the existing `deliver()` seam.
7. **Distributed tracing** — OpenTelemetry; the request-id plumbing is already
   in place.

### Bonus: how the design changes for booking across multiple doctors

"Any available cardiologist at 3pm" changes the shape of the problem:

- **Slot selection becomes a search**, not a lookup: query the partial index
  across doctors ordered by (price, rating, earliest), then attempt in order.
- **The guarantee is unchanged** — each attempt still contends on one slot's
  unique index, so the existing mechanism carries over untouched. The API gains
  a "book one of these" endpoint that walks candidates and returns the first 201.
- **Fairness matters more.** With one doctor, contention is a race. Across
  doctors, always trying the cheapest first would starve them. A weighted or
  round-robin ordering is needed.
- **Sharding pressure changes.** Sharding by `doctorId` (the plan above) makes
  cross-doctor search a scatter-gather. Either accept the fan-out to a bounded
  candidate set, or maintain a denormalised read model of open inventory keyed
  by (specialisation, time bucket) — updated from the existing `slot.released`
  and `booking.created` events, which is precisely what the outbox already
  publishes.

---

## License

MIT

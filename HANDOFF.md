# HANDOFF

**Purpose of this file:** everything a new session (human or AI) needs to pick
this project up cold — what it is, what is done, what is left, and the
non-obvious decisions and traps that would otherwise have to be rediscovered.

> Read this first, then `README.md` for the deep design rationale.
> This file is about **project state**; the README is about **the system**.

- **Project:** Clinzo — Doctor Slot Scheduling backend (Backend Engineering Assessment)
- **Location:** `/Users/subharjunbose/Desktop/Clinzo`
- **Last updated:** 2026-07-26
- **Repository:** <https://github.com/Subharjun/clinzo> (private)
- **Overall status:** ✅ **Feature-complete, verified, and pushed.** Only the
  video + Drive + email steps remain (see [§8](#8-remaining-work)).

---

## 1. TL;DR for a cold start

```bash
cd /Users/subharjunbose/Desktop/Clinzo

# Dependencies are already installed and .env already has real secrets.
docker compose up -d postgres redis     # start infrastructure
npm test                                # 185 tests, ~7s, all green
npm run dev                             # API on :3000, docs at /docs
```

If anything below contradicts what you observe, **trust the code and the tests**
— they were verified by execution, this file is a description of them.

---

## 2. What was asked for

The assessment (`Doctor Slot Scheduling for Online Consultations`) asked for a
system that turns a doctor's broad availability window into discrete bookable
slots, and keeps that allocation correct under concurrent bookings,
cancellations and reschedules.

The user then specified a much larger production scope on top: Node 22,
Express, TypeScript, PostgreSQL, Prisma, Redis, BullMQ, Docker, JWT + refresh,
Zod, Pino, Swagger, Jest + Supertest, GitHub Actions, ESLint/Prettier, Husky,
clean architecture, and a list of bonus items (recurring availability,
timezones, waitlist, event-driven/Kafka-ready, audit logs, outbox, idempotency).

**All of it was delivered.** Nothing in the requested scope was skipped,
narrowed, or stubbed except one explicitly-flagged boundary (see
[§7](#7-deliberate-boundaries--what-is-intentionally-not-real)).

---

## 3. Current state

### 3.1 Build & quality gates — all passing

| Gate              | Command                        | Status                                                                          |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Lint              | `npm run lint`                 | ✅ clean, 0 warnings                                                            |
| Format            | `npm run format:check`         | ✅ clean                                                                        |
| Typecheck         | `npm run typecheck`            | ✅ clean (strict mode)                                                          |
| Build             | `npm run build`                | ✅ compiles to `dist/`                                                          |
| Unit tests        | `npm run test:unit`            | ✅ **117 passing**                                                              |
| Integration tests | `npm run test:integration`     | ✅ **68 passing**                                                               |
| **Total**         | `npm test`                     | ✅ **185 passing**, ~7s                                                         |
| Docker image      | `docker build -t clinzo .`     | ✅ builds                                                                       |
| Docker compose    | `docker compose up -d --build` | ✅ 5 services defined; `migrate` runs to completion, the other 4 report healthy |

### 3.2 Scale

```
source files : 64 TypeScript files
source LOC   : ~10,758
test LOC     : ~3,170
migration SQL: 563 lines (incl. ~150 lines of hand-written integrity layer)
README       : 956 lines
```

### 3.3 Environment state on this machine

| Thing                       | State                                                                        |
| --------------------------- | ---------------------------------------------------------------------------- |
| `node_modules/`             | ✅ installed (`npm ci` reproducible from `package-lock.json`)                |
| `.env`                      | ✅ exists, **has real generated JWT secrets** (gitignored)                   |
| Docker containers           | ⏸️ `postgres` + `redis` up; `api`/`worker` were torn down after verification |
| Dev database `clinzo`       | ✅ migrated + seeded (2 doctors, 12 patients, ~600 slots)                    |
| Test database `clinzo_test` | ✅ exists and migrated (auto-created by `tests/setup/global.setup.ts`)       |
| Prisma client               | ✅ generated                                                                 |
| **Git**                     | ✅ initialised, 1 commit on `main`, pushed to `origin`                       |
| **GitHub**                  | ✅ `Subharjun/clinzo` (private); CI green on first push                      |

---

## 4. What was built — phase by phase

All phases complete. Listed in build order because later phases depend on
earlier ones.

| #   | Phase                     | Status | Key artefacts                                                                                                       |
| --- | ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Scaffolding               | ✅     | `package.json`, `tsconfig*.json`, `eslint.config.mjs`, `.prettierrc.json`, `.env.example`, `jest.config.js`         |
| 2   | Prisma schema + migration | ✅     | `prisma/schema.prisma` (12 models), `prisma/migrations/*/migration.sql` incl. hand-written constraints              |
| 3   | Infrastructure            | ✅     | `config/{env,prisma,redis,metrics}.ts`, `utils/{errors,logger,time,crypto,http,prisma-errors}.ts`, middleware chain |
| 4   | Authentication            | ✅     | `services/{auth,token}.service.ts`, `middlewares/auth.middleware.ts`, refresh rotation + reuse detection            |
| 5   | Slot generation           | ✅     | `services/slot-generator.ts` (**pure, no I/O**), `services/availability.service.ts`                                 |
| 6   | Booking engine            | ✅     | `services/booking.service.ts` (3-layer concurrency), `hold.service.ts`, cancel + reschedule                         |
| 7   | Redis subsystems          | ✅     | `services/lock.service.ts` (Lua-fenced), cache w/ version invalidation, rate limits, idempotency                    |
| 8   | Events + jobs             | ✅     | `events/*` (outbox, Kafka-ready publisher, consumers), `jobs/*` (4 queues, workers, schedulers)                     |
| 9   | App wiring + docs         | ✅     | `app.ts`, `server.ts` (graceful shutdown), `docs/openapi.ts` (15 paths), health + metrics                           |
| 10  | Tests                     | ✅     | 4 unit + 4 integration suites, **incl. the 100-way concurrency proof**                                              |
| 11  | Docker + CI + hooks       | ✅     | `Dockerfile` (3-stage), `docker-compose.yml` (5 services), `.github/workflows/ci.yml` (4 jobs), `.husky/*`          |
| 12  | Documentation             | ✅     | `README.md`, this file, `scripts/generate-secrets.sh`                                                               |
| 13  | Demo console + video prep | ✅     | `public/` (dependency-free client at `/app`), `docs/video-script.tex`                                               |

### 4.1 API surface — 31 route registrations (27 business + 4 ops)

Every endpoint the user listed was delivered, plus extras. Verify the count
with:

```bash
grep -rhoE "^(apiRouter|authRouter|healthRouter|metricsRouter)\.(get|post|put|delete|patch)" src/routes/*.ts | wc -l
```

- **Required:** `POST /auth/login`, `POST /auth/refresh`, `POST /availability`,
  `PUT /availability/:id`, `GET /doctors/:id/slots`, `POST /bookings`,
  `DELETE /bookings/:id`, `PUT /bookings/:id/reschedule`, `GET /bookings/me`,
  `GET /doctors`, `GET /patients/me`
- **Added:** registration (patient/doctor), logout, logout-all,
  `DELETE /availability/:id`, `GET /availability`, `GET /availability/slots`,
  holds (`POST`/`GET`/`DELETE`), waitlist (`POST`/`GET`/`DELETE`),
  `GET /doctors/me`, `GET /doctors/:id`, `GET /bookings/:id`,
  health (3 variants), metrics, docs

### 4.2 Bonus items — all delivered

| Bonus                             | Where                                                                  |
| --------------------------------- | ---------------------------------------------------------------------- |
| Recurring availability            | `AvailabilityKind.RECURRING` + `effectiveFrom/Until`                   |
| Timezone support (UTC internally) | `utils/time.ts`, dual rendering in every response                      |
| Waitlist                          | `services/waitlist.service.ts`, broadcast-on-release                   |
| Event-driven / Kafka-ready        | `events/event-publisher.ts` — `PublishableEvent` shaped for Kafka      |
| Audit logs                        | `repositories/audit-log.repository.ts`, transactional + detached modes |
| Outbox pattern                    | `repositories/outbox.repository.ts` + relay with `SKIP LOCKED`         |
| Idempotency keys                  | `middlewares/idempotency.middleware.ts`                                |
| Variable-length appointment types | per-`Availability` duration + `appointmentType`                        |
| Multi-doctor booking discussion   | `README.md` § Trade-offs (last section)                                |

---

## 5. The decisions that matter — do not re-litigate these

These were reasoned through carefully. A new session should understand _why_
before changing any of them.

### 5.1 Concurrency: three layers, only one is the guarantee

```
Redis lock (throughput)  →  SELECT FOR UPDATE (closes check-then-act)  →  partial unique index (THE GUARANTEE)
```

The load-bearing element is:

```sql
CREATE UNIQUE INDEX bookings_one_confirmed_per_slot
  ON bookings ("slotId") WHERE status = 'CONFIRMED';
```

**Why the Redis lock is explicitly not trusted:** lease-based distributed locks
cannot be made safe against process pauses (GC past the TTL). Treating Redlock
as correctness is how systems double-book. It is a _throughput_ optimisation —
it stops 100 contenders each holding a pooled DB connection while queueing on
one row lock.

There is a test that **stubs the lock out entirely** and still asserts exactly
one winner. That test is the proof; do not delete it.

**Pessimistic for booking, optimistic for availability.** Booking contention is
concentrated by nature (everyone wants the 10:00 slot), where optimistic
locking makes every loser burn a full transaction to learn something a retry
can never fix. Availability edits are rare and a stale write should be
_rejected_ — hence `version` columns there.

### 5.2 Slots are materialised, not computed

Rejected computing slots on read, for one decisive reason: **a slot must be a
lockable row**. `FOR UPDATE` and a unique index need something to point at. A
computed slot has no identity, so "one booking per slot" could only live in
application code — exactly what breaks under concurrency.

Cost: explicit idempotent generation, table grows with `horizon × doctors`.
Handled via `ON CONFLICT DO NOTHING` and `SLOT_GENERATION_HORIZON_DAYS`.

### 5.3 Retroactive availability changes: keep bookings, report orphans

Doctor shrinks Monday 10:00–18:00 → 10:00–14:00 with a 15:00 booking sold.

- Future **unbooked** slots outside the window → `BLOCKED`
- Future **booked** slots → untouched, returned as `orphanedBookings`
- **Past** slots → never modified

Rejected auto-cancel (breaks a two-person commitment silently) and hard-block
(one appointment freezes the whole schedule). The accepted cost is a
_transient, visible, actionable_ inconsistency.

### 5.4 Timezones: instants UTC, intent local

Availability stores **minutes-from-local-midnight + IANA zone**, resolved to an
instant per concrete date. Storing a fixed offset would shift every appointment
an hour twice a year.

Slot **starts** are wall-clock; slot **durations** are elapsed time.

### 5.5 Other decisions with rationale in the README

| Decision                              | One-line why                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Outbox pattern                        | Avoids dual-write loss; at-least-once + idempotent consumers is easier than distributed atomicity |
| Queues split by failure profile       | A notification backlog must not delay slot releases                                               |
| Waitlist broadcasts to all candidates | One unresponsive patient must not block a freed slot for minutes                                  |
| bcryptjs over native bcrypt           | ~2× slower, but removes node-gyp from every image/CI runner. Isolated to `utils/crypto.ts`        |
| Idempotency header optional           | Adopting it isn't a breaking API change                                                           |
| Hand-authored OpenAPI                 | Generation describes _types_; the _behaviour_ (what a 409 means) is what matters here             |
| Relative imports, no path aliases     | `tsc` doesn't rewrite paths; avoids needing a runtime resolver                                    |
| Truncation not rollback in tests      | Concurrency tests need genuinely independent committing connections                               |

---

## 6. Bugs found and fixed during the build

Recorded because they are the non-obvious traps in this domain — and because
two of them were caught by tests, which is the argument for the test suite.

### 6.1 DST bug — Luxon `plus({minutes})` (caught by a test)

`DateTime.plus({ minutes: 180 })` measures **elapsed** time. On a
spring-forward day, midnight + 180 min = **04:00**, not 03:00 — silently
shifting every slot after the transition by an hour.

**Fix:** build from calendar components with `DateTime.fromObject`, then
round-trip-check the wall-clock minute to detect gap times.
**Location:** `src/utils/time.ts` → `localDateTimeToUtc`.

This also forced the better model: durations became elapsed time, so a
15-minute consultation is 15 real minutes even across a fall-back.

### 6.2 `isValidTimezone('IST')` returned true — and means Israel

The tz database carries legacy aliases. `IST` = **Israel** Standard Time
(UTC+2), but nearly everyone typing it means **India** (UTC+5:30) — a 3.5-hour
error on every appointment. `CST` is claimed by three regions.

**Fix:** require `Area/Location` form; `UTC` is the sole bare exception.
**Location:** `src/utils/time.ts` → `isValidTimezone`.

### 6.3 BullMQ rejects `:` in custom job IDs

`Custom Id cannot contain :`. Job ids like `confirm:${eventId}` failed at
runtime, silently stalling the outbox relay (it retried with backoff correctly,
which is how it was spotted).

**Fix:** hyphen-separated ids (`confirm-${eventId}`).
**Locations:** `events/event-publisher.ts`, `jobs/queues.ts`,
`jobs/processors/maintenance.processor.ts`.

### 6.4 Jest hung after tests passed

Importing `bookingService` transitively constructs the BullMQ queues, whose
Redis connections keep the event loop alive forever.

**Fix:** `tests/helpers/database.ts` → `teardown()` closes queues +
`bullConnection` + `subscriber`. **Do not remove this.**

### 6.5 Error translator only read `.message` from `Error` instances

Driver errors sometimes arrive as plain objects. **Fix:** structural
`extractMessage()` in `utils/prisma-errors.ts`.

### 6.6 Config guard fired on my own test setup (working as intended)

`RESERVATION_HOLD_TTL_SECONDS=2` violated the schema floor of 10. Rather than
weakening the floor, hold-expiry tests now backdate `expiresAt` and drive the
sweeper directly — the same path production takes, and milliseconds instead of
seconds.

---

## 7. Deliberate boundaries — what is intentionally not "real"

**Exactly one**, and it is flagged in the README too:

**Notification delivery** (`jobs/processors/notification.processor.ts`).
Everything around it is real — recipient resolution, per-recipient timezone
rendering, retry/backoff via BullMQ, dedup by event id, address redaction in
logs. Only the final hop to SendGrid/SES/Twilio is behind a `deliver()`
function that logs instead of sending.

This is a boundary, not an unfinished feature: a provider integration is
credentials + an SDK, and stubbing it keeps the repo runnable with no external
accounts. **Swapping in a real provider is one function body.**

Everything else is fully implemented. There are **no TODOs, no placeholder
implementations, and no unimplemented branches** in the codebase.

---

## 8. Remaining work

Only submission logistics. No code work outstanding.

| #   | Task                                                | Owner    | Notes                                                     |
| --- | --------------------------------------------------- | -------- | --------------------------------------------------------- |
| 1   | `git init` + initial commit                         | —        | ✅ done — commit `cd31ec3` on `main`, 100 files           |
| 2   | Push to GitHub                                      | —        | ✅ done — <https://github.com/Subharjun/clinzo> (private) |
| 3   | Record walkthrough video (**max 15 min**)           | **user** | Outline below. Cannot be automated.                       |
| 4   | Upload repo + video + docs to a Google Drive folder | **user** | Drive connector not authorised in this environment        |
| 5   | Reply to the email with **only** the Drive link     | **user** | Assessment: "Do not include any additional text"          |

### 8.1 Git — what was done

`.gitignore` was already correct. Verified before pushing:

- `.env` **excluded** (checked both locally and via the GitHub API — returns 404)
- `.env.example` committed, contains **placeholders only**
- No `dist/` or `node_modules/` staged
- CI green on first push — all 4 jobs (`audit`, `test`, `lint`, `build`) passed

To add a reviewer to the private repo:

```bash
gh repo view Subharjun/clinzo --web              # open it
gh api -X PUT repos/Subharjun/clinzo/collaborators/USERNAME -f permission=pull
```

**Known CI annotation (not a failure):** the `audit` job logs exit code 1 —
24 high-severity findings, all from a single `brace-expansion` DoS advisory
reached only via `eslint` / `jest` / `ts-jest`. All **devDependencies**; nothing
in the production runtime path. `npm audit fix` cannot resolve it without
`--force` (major bumps of jest + eslint). Left as-is deliberately — this is
precisely the case the step's `continue-on-error: true` comment describes.

### 8.2 Video: the script is written

**`docs/video-script.tex`** — a full **verbatim narration script**, not an
outline. Every line to be spoken is in a "SAY THIS" box; stage directions are
separate. Nine segments, ~12 min 45 s of speech at 145 wpm, against a 15 min
limit. Includes a pre-flight checklist, a shot list with running timecodes, a
mid-recording troubleshooting table, and a credentials/URL reference card.

Upload the single `.tex` to Overleaf and hit Recompile — standard TeX Live
packages only, pdfLaTeX, no shell-escape. Verified: compiles clean to 9 A4
pages (checked locally with `tectonic`).

Segment order: problem → stack → slot generation and timezones → booking
lifecycle → **concurrency proof** → retroactive availability → outbox →
ops/CI → trade-offs.

> The script tells you to re-seed immediately before recording. Take that
> seriously: the opening shot depends on Dr Mehta's first three slots being
> free, because they are the brief's worked example (10:00 / 10:20 / 10:40).

### 8.3 Demo console — what the video actually shows

The video is driven by **`/app`**, a demo client added for this purpose.

| Property        | Choice                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| Location        | `public/{index.html,app.css,app.js}`, served by Express at `/app`                    |
| Dependencies    | **None.** No framework, no bundler, no build step, no second lockfile                |
| Mount point     | Before `globalLimiter` — page assets must not consume a caller's request budget      |
| Path resolution | `path.resolve(__dirname, '..', 'public')` — works from both `src/` (tsx) and `dist/` |
| Docker          | `public/` is copied into the runtime stage, so `/app` works in the container too     |

Views: slot discovery with **three server-rendered timezones per slot**,
booking, holds with a live TTL countdown, waitlist, the doctor's diary
(including `HELD` / `BLOCKED`), a live network panel, and the **concurrency
lab**.

**The concurrency lab fires across the 12 seeded patient accounts, not one.**
This is load-bearing, not decoration: `bookingLimiter` is keyed per user at
30/min, so N requests from a single account would return `429`s and the demo
would be showing the throttle instead of the concurrency control. Verified in
a real browser: 12 contenders → **1× 201, 11× 409 `SLOT_UNAVAILABLE`, ~130 ms,
zero 429s**.

Its pass/fail verdict deliberately rests on the response tally alone. Public
availability is polled and reported _separately_, because that listing is
cached for `SLOT_CACHE_TTL_SECONDS` (15) — a read issued milliseconds after the
race can legitimately still show the slot, and folding that into the pass
criterion would produce false failures.

---

## 9. Traps for a future session

Things that will waste your time if you don't know them.

| Trap                                            | What happens                                                                | What to do                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Prettier reformats on write**                 | `npm run format` rewrites many files; edits made from stale reads then fail | Re-`Read` a file before editing after a format run                                         |
| **BullMQ job ids**                              | `:` in a custom `jobId` throws at runtime                                   | Use `-` separators                                                                         |
| **Test teardown**                               | Removing queue-closing from `teardown()` makes Jest hang forever            | Keep `closeQueues()` + connection quits                                                    |
| **`NODE_ENV=production` + placeholder secrets** | App refuses to boot (by design)                                             | Run `./scripts/generate-secrets.sh`                                                        |
| **Integration tests need real infra**           | Suite fails without Postgres + Redis                                        | `docker compose up -d postgres redis`                                                      |
| **Test DB is separate**                         | Integration uses `clinzo_test` on Redis **db 1**                            | Never point tests at `clinzo` / db 0                                                       |
| **`prisma migrate dev` on a changed schema**    | Would generate a _new_ migration and skip the hand-written constraint layer | Constraints live in `migration.sql` **appended after** the generated block — preserve them |
| **Dropping the partial unique index**           | Silent loss of the core guarantee                                           | CI has an explicit `pg_indexes` check for this                                             |
| **Route ordering**                              | `/doctors/me` must precede `/doctors/:id`                                   | Already correct in `routes/index.ts`                                                       |
| **`express.json()` + DELETE body**              | `DELETE /bookings/:id` accepts an optional body                             | Cancel schema is all-optional                                                              |
| **Node version**                                | Local machine runs Node 25; Docker/CI pin Node 22                           | Both verified working                                                                      |

---

## 10. File map — where to look

| I want to…                       | Go to                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Understand the whole design      | `README.md`                                                                               |
| See the concurrency guarantee    | `prisma/migrations/*/migration.sql` (the appended integrity layer)                        |
| See it proven                    | `tests/integration/booking-concurrency.test.ts`                                           |
| Read the booking hot path        | `src/services/booking.service.ts` (long header comment explains all 3 layers)             |
| Understand slot arithmetic       | `src/services/slot-generator.ts` (pure) + `tests/unit/slot-generator.test.ts`             |
| Understand timezone handling     | `src/utils/time.ts` + `tests/unit/time.test.ts`                                           |
| See retroactive-change policy    | `src/services/availability.service.ts` → `update()` header comment                        |
| Understand holds                 | `src/services/hold.service.ts`                                                            |
| See the Redis lock + Lua fencing | `src/services/lock.service.ts`                                                            |
| See the outbox                   | `src/repositories/outbox.repository.ts` + `src/jobs/processors/outbox-relay.processor.ts` |
| See the Kafka migration path     | `src/events/event-publisher.ts` (bottom comment)                                          |
| Change config                    | `src/config/env.ts` (Zod-validated; app won't boot if invalid)                            |
| Add an endpoint                  | `routes/index.ts` → `controllers/` → `services/` → `repositories/`                        |

---

## 11. Verification evidence

All of the following were **executed**, not assumed.

```
✅ npm run lint            → clean, 0 warnings
✅ npm run format:check    → all files match Prettier
✅ npm run typecheck       → clean under strict mode
✅ npm run build           → compiles to dist/
✅ npm run test:unit       → 117 passed
✅ npm run test:integration→  68 passed
✅ docker build            → image builds
✅ docker compose up       → postgres, redis, migrate, api, worker all healthy
✅ GET /health             → {"status":"healthy","checks":{"database":"up","redis":"up"}}
✅ GET /docs               → HTTP 200, Swagger UI renders
✅ GET /openapi.json       → 15 documented paths
✅ GET /metrics            → 166 clinzo_* metric lines
```

### Live concurrency demo against the Docker deployment

Not the test harness — real HTTP against the running container:

```
50 SIMULTANEOUS BOOKINGS for one slot
   201 Created : 1
   409 Conflict: 49          (code: SLOT_UNAVAILABLE)
   other       : 0
   wall clock  : 329 ms
cancel → 200 CANCELLED
re-book same slot → 201      (partial index correctly scoped to CONFIRMED)
```

### Worker pipeline verified in Docker

```
outbox: booking.created ×2, booking.cancelled ×1,
        slot.released ×1, availability.changed ×1   → all PUBLISHED
notifications dispatched: 5   (recipients redacted in logs)
audit entries: 55
```

### Slot generation verified against the assessment's worked example

Doctor in `Asia/Kolkata`, 10:00–18:00, 15 min duration, 5 min buffer:

```
first three starts: 10:00, 10:20, 10:40   ✅ matches the brief exactly
dual rendering:     2026-07-27T04:30:00Z | Berlin 06:30 | Kolkata 10:00
```

---

## 12. Known limitations (honest list)

Not defects — deliberate scope boundaries, all documented in the README.

1. **Notification providers stubbed** — see [§7](#7-deliberate-boundaries--what-is-intentionally-not-real).
2. **No payment integration** — the hold flow is designed for it; a provider
   webhook would consume the hold on success.
3. **Orphaned bookings are reported, not resolved** — no "propose new time" UI
   flow. Deliberate: that's a product surface, not a backend gap.
4. **DST fall-back loses ~1 hour of inventory per doctor per year** — accepted
   trade for unambiguous local times.
5. **No calendar sync** (Google/Outlook) — listed as a next step.
6. **No partitioning yet** on `slots`/`bookings` — the scaling plan in the
   README says to do it before the tables get large, not preemptively.
7. **`admin` role is defined but thin** — it can cancel any booking and read
   any booking; there is no admin CRUD surface. Not in the requested scope.

---

## 13. Quick reference

### Seeded credentials (dev DB) — password `ClinzoDemo2026!`

| Account                                          | Role    | Timezone                             |
| ------------------------------------------------ | ------- | ------------------------------------ |
| `dr.mehta@clinzo.test`                           | DOCTOR  | Asia/Kolkata (15 min + 5 min buffer) |
| `dr.okafor@clinzo.test`                          | DOCTOR  | America/New_York (30 min, no buffer) |
| `patient1@clinzo.test` … `patient12@clinzo.test` | PATIENT | mixed                                |
| `admin@clinzo.test`                              | ADMIN   | UTC                                  |

Fixed doctor IDs (stable across re-seeds):

- Dr Mehta: `aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa`
- Dr Okafor: `bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb`

### URLs

| What         | Where                           |
| ------------ | ------------------------------- |
| Demo console | <http://localhost:3000/app>     |
| Swagger UI   | <http://localhost:3000/docs>    |
| Health       | <http://localhost:3000/health>  |
| Metrics      | <http://localhost:3000/metrics> |

### Ports

| Service    | Port                                |
| ---------- | ----------------------------------- |
| API        | 3000                                |
| PostgreSQL | 5432                                |
| Redis      | 6379 (dev = db 0, tests = **db 1**) |

### Most-used commands

```bash
npm run dev / npm run dev:worker      # hot-reloading API / worker
npm test                              # everything (needs postgres + redis)
npm run test:unit                     # no infrastructure needed
npm run seed                          # reset demo data
npm run prisma:studio                 # browse the database
docker compose up -d --build          # full stack
docker compose logs -f api worker     # tail logs
./scripts/generate-secrets.sh         # fresh JWT secrets into .env
open http://localhost:3000/app        # the demo console used in the video
```

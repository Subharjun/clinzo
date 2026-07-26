/* ===========================================================================
   Clinzo demo console.

   A deliberately thin client. Every time you see on screen was formatted by
   the server (the `local` / `doctorLocal` blocks on each slot and booking),
   not by the browser — the point of the demo is that timezone correctness
   lives in the backend, so recomputing it here would prove nothing.

   No framework, no build step, no dependencies.
   =========================================================================== */

'use strict';

const API = '/api/v1';
const PASSWORD = 'ClinzoDemo2026!';

/** Fixed seed ids — stable across re-seeds, see prisma/seed.ts. */
const RACE_PATIENTS = Array.from({ length: 12 }, (_, i) => `patient${i + 1}@clinzo.test`);

const state = {
  token: null,
  refreshToken: null,
  user: null,
  doctors: [],
  slots: [],
  /** email -> accessToken, for the concurrency lab's competing patients. */
  raceTokens: new Map(),
};

/* ------------------------------- helpers -------------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, kind = '') {
  const node = el('div', `toast ${kind}`, message);
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 3800);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Single fetch wrapper so every call lands in the on-screen network log.
 * `silent` suppresses logging for the concurrency lab, which would otherwise
 * flood the panel with N near-identical rows.
 */
async function api(method, path, { body, token, silent, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const auth = token !== undefined ? token : state.token;
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const startedAt = performance.now();
  const response = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* 204 and friends have no body */
  }

  if (!silent) {
    logRequest({
      method,
      path,
      status: response.status,
      elapsedMs,
      requestId: payload?.error?.requestId ?? response.headers.get('x-request-id'),
      errorCode: payload?.error?.code,
    });
  }

  return { status: response.status, ok: response.ok, payload };
}

/** Throwing variant for call sites that only care about the happy path. */
async function apiOrThrow(method, path, options) {
  const result = await api(method, path, options);
  if (!result.ok) {
    const error = result.payload?.error;
    throw new Error(error?.message ?? `Request failed (${result.status})`);
  }
  return result.payload.data;
}

/* ----------------------------- network log ------------------------------ */

function logRequest({ method, path, status, elapsedMs, requestId, errorCode }) {
  const row = el('div', `log-row s${String(status)[0]}`);

  const line = el('div', 'log-line1');
  line.append(
    el('span', 'log-status', String(status)),
    el('span', 'log-method', method),
    el('span', 'log-path', path.split('?')[0]),
  );

  const bits = [`${elapsedMs}ms`];
  if (errorCode) bits.push(errorCode);
  if (requestId) bits.push(requestId.slice(0, 8));

  row.append(line, el('div', 'log-meta', bits.join('  ·  ')));

  const log = $('#log');
  log.prepend(row);
  while (log.childElementCount > 60) log.lastElementChild.remove();
}

/* -------------------------------- health -------------------------------- */

async function pollHealth() {
  try {
    const response = await fetch('/health');
    const body = await response.json();
    const healthy = body.status === 'healthy';
    $('#health-dot').className = `dot ${healthy ? 'up' : 'down'}`;
    $('#health-text').textContent = healthy
      ? `db ${body.checks.database} · redis ${body.checks.redis}`
      : body.status;
  } catch {
    $('#health-dot').className = 'dot down';
    $('#health-text').textContent = 'unreachable';
  }
}

/* --------------------------------- auth --------------------------------- */

function renderSession() {
  const box = $('#session');
  box.replaceChildren();

  if (!state.user) {
    box.append(el('span', 'muted', 'Not signed in — slot search still works'));
    $('#btn-login').hidden = false;
    $('#btn-logout').hidden = true;
    return;
  }

  const initials = state.user.fullName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('');

  box.append(
    el('div', 'avatar', initials),
    el('strong', null, state.user.fullName),
    el('span', 'role-tag', state.user.role),
    el('span', 'muted', state.user.timezone),
  );

  $('#btn-login').hidden = true;
  $('#btn-logout').hidden = false;
}

async function login(email, password) {
  const data = await apiOrThrow('POST', '/auth/login', { body: { email, password }, token: null });
  state.token = data.tokens.accessToken;
  state.refreshToken = data.tokens.refreshToken;
  state.user = data.user;
  renderSession();
  return data;
}

async function logout() {
  if (state.refreshToken) {
    await api('POST', '/auth/logout', { body: { refreshToken: state.refreshToken } });
  }
  state.token = null;
  state.refreshToken = null;
  state.user = null;
  renderSession();
  $('#bookings').replaceChildren();
  $('#holds').replaceChildren();
  $('#waitlist').replaceChildren();
  toast('Signed out');
}

/* ------------------------------- discover ------------------------------- */

async function loadDoctors() {
  const doctors = await apiOrThrow('GET', '/doctors?limit=50', { token: null });
  state.doctors = doctors;

  const select = $('#doctor-select');
  select.replaceChildren();
  for (const doctor of doctors) {
    const option = el(
      'option',
      null,
      `${doctor.fullName} — ${doctor.specialization} (${doctor.timezone})`,
    );
    option.value = doctor.id;
    select.append(option);
  }

  // Default to the Asia/Kolkata doctor: 15-minute appointments with a 5-minute
  // buffer, which is the worked example in the assessment brief (10:00, 10:20,
  // 10:40) and therefore the most useful starting point for a demo.
  const preferred = doctors.find((doctor) => doctor.timezone === 'Asia/Kolkata');
  if (preferred) select.value = preferred.id;
}

async function searchSlots() {
  const doctorId = $('#doctor-select').value;
  if (!doctorId) return;

  const from = new Date(`${$('#from-date').value}T00:00:00Z`).toISOString();
  const to = new Date(`${$('#to-date').value}T23:59:59Z`).toISOString();
  const timezone = $('#viewer-tz').value;

  const query = new URLSearchParams({ from, to });
  if (timezone) query.set('timezone', timezone);

  const listing = await apiOrThrow('GET', `/doctors/${doctorId}/slots?${query}`, { token: null });
  state.slots = listing.slots;

  const banner = $('#tz-banner');
  banner.hidden = false;
  banner.textContent =
    `${listing.count} available · stored in UTC · shown to you in ${listing.viewerTimezone}` +
    ` · the doctor works in ${listing.doctorTimezone}`;

  renderSlots(listing);
  populateRaceSlots();
}

function renderSlots(listing) {
  const grid = $('#slots');
  grid.replaceChildren();

  if (!listing.slots.length) {
    grid.append(el('div', 'empty', 'No available slots in this range.'));
    return;
  }

  const sameZone = listing.viewerTimezone === listing.doctorTimezone;

  for (const slot of listing.slots) {
    const card = el('div', 'slot');

    card.append(
      el('div', 'slot-time', slot.local.startTime),
      el('div', 'slot-date', slot.local.date),
    );

    // The three renderings side by side — this is the timezone story on screen.
    const zones = el('div', 'slot-tzs');
    zones.append(rowFor('UTC', slot.startsAt.slice(11, 16)));
    zones.append(rowFor(listing.viewerTimezone, slot.local.startTime));
    if (!sameZone) zones.append(rowFor(listing.doctorTimezone, slot.doctorLocal.startTime));
    card.append(zones);

    const meta = el('div', 'slot-meta');
    meta.append(
      el('span', 'pill', `${slot.durationMinutes} min`),
      el('span', 'pill', slot.mode),
      el('span', 'pill pill-available', 'AVAILABLE'),
    );
    card.append(meta);

    const actions = el('div', 'card-actions');
    actions.style.marginTop = '10px';

    const bookBtn = el('button', 'btn btn-mini btn-primary', 'Book');
    bookBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      bookSlot(slot);
    });

    const holdBtn = el('button', 'btn btn-mini', 'Hold');
    holdBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      holdSlot(slot);
    });

    actions.append(bookBtn, holdBtn);
    card.append(actions);

    card.addEventListener('click', () => bookSlot(slot));
    grid.append(card);
  }

  function rowFor(label, value) {
    const row = el('div');
    row.append(el('b', null, value), document.createTextNode(`  ${label}`));
    return row;
  }
}

/* ------------------------------- bookings ------------------------------- */

async function bookSlot(slot) {
  if (!state.user) {
    toast('Sign in as a patient to book', 'bad');
    openLogin();
    return;
  }
  if (state.user.role !== 'PATIENT') {
    toast('Only patients can book — sign in as patient1@clinzo.test', 'bad');
    return;
  }

  const result = await api('POST', '/bookings', {
    body: { slotId: slot.id, reasonForVisit: 'Demo consultation' },
    idempotencyKey: crypto.randomUUID(),
  });

  if (result.ok) {
    toast(`Booked ${result.payload.data.confirmationCode} at ${slot.local.startTime}`, 'ok');
    await Promise.all([searchSlots(), loadBookings()]);
  } else {
    toast(result.payload?.error?.message ?? 'Booking failed', 'bad');
  }
}

async function loadBookings() {
  if (!state.user) return;

  const bookings = await apiOrThrow('GET', '/bookings/me?window=all&limit=50');
  const list = $('#bookings');
  list.replaceChildren();

  if (!bookings.length) {
    list.append(el('div', 'empty', 'No bookings yet — book one from “Find a slot”.'));
    return;
  }

  for (const booking of bookings) {
    const card = el('div', 'card');

    const main = el('div', 'card-main');
    main.append(
      el('div', 'card-title', `${booking.local.startTime} · ${booking.local.date}`),
      el(
        'div',
        'card-sub',
        `${booking.doctor.fullName} — ${booking.doctor.specialization} · ` +
          `${booking.doctor.localStartTime} in ${booking.doctor.timezone}`,
      ),
      el('div', 'card-code', booking.confirmationCode),
    );
    card.append(main);

    card.append(el('span', `pill pill-${booking.status.toLowerCase()}`, booking.status));

    if (booking.status === 'CONFIRMED') {
      const actions = el('div', 'card-actions');

      const rescheduleBtn = el('button', 'btn btn-mini', 'Reschedule');
      rescheduleBtn.addEventListener('click', () => reschedule(booking));

      const cancelBtn = el('button', 'btn btn-mini', 'Cancel');
      cancelBtn.addEventListener('click', () => cancel(booking));

      actions.append(rescheduleBtn, cancelBtn);
      card.append(actions);
    }

    list.append(card);
  }
}

async function cancel(booking) {
  const result = await api('DELETE', `/bookings/${booking.id}`, {
    body: { reason: 'Demo cancellation' },
  });
  if (result.ok) {
    toast('Cancelled — slot released back to the pool', 'ok');
    await Promise.all([loadBookings(), searchSlots()]);
  } else {
    toast(result.payload?.error?.message ?? 'Cancel failed', 'bad');
  }
}

async function reschedule(booking) {
  // Re-read availability rather than reusing `state.slots`: that list was
  // rendered before the booking happened, so its head may already be taken
  // and the reschedule would fail with 409 for a reason that has nothing to
  // do with rescheduling.
  await searchSlots();

  const target = state.slots.find((slot) => slot.id !== booking.slotId);
  if (!target) {
    toast('No other slot free in this range — widen the date range first', 'bad');
    return;
  }

  const result = await api('PUT', `/bookings/${booking.id}/reschedule`, {
    body: { targetSlotId: target.id, reason: 'Demo reschedule' },
    idempotencyKey: crypto.randomUUID(),
  });

  if (result.ok) {
    toast(`Moved to ${result.payload.data.local.startTime} — same booking id`, 'ok');
    await Promise.all([loadBookings(), searchSlots()]);
  } else {
    toast(result.payload?.error?.message ?? 'Reschedule failed', 'bad');
  }
}

/* -------------------------- holds and waitlist -------------------------- */

async function holdSlot(slot) {
  if (!state.user || state.user.role !== 'PATIENT') {
    toast('Sign in as a patient to hold a slot', 'bad');
    return;
  }

  const result = await api('POST', '/holds', { body: { slotId: slot.id } });
  if (result.ok) {
    toast(`Held for ${result.payload.data.ttlSeconds}s — see “Holds & waitlist”`, 'ok');
    await Promise.all([searchSlots(), loadHolds()]);
  } else {
    toast(result.payload?.error?.message ?? 'Could not hold slot', 'bad');
  }
}

async function loadHolds() {
  if (!state.user || state.user.role !== 'PATIENT') return;

  const holds = await apiOrThrow('GET', '/holds/me');
  const list = $('#holds');
  list.replaceChildren();

  if (!holds.length) {
    list.append(el('div', 'empty', 'No active holds. Click “Hold” on a slot to create one.'));
  }

  for (const hold of holds) {
    const card = el('div', 'card');
    const main = el('div', 'card-main');

    const countdown = el('div', 'card-title');
    main.append(countdown, el('div', 'card-sub', `slot ${hold.slotId.slice(0, 8)}…`));
    card.append(main, el('span', `pill pill-held`, hold.status));

    const release = el('button', 'btn btn-mini', 'Release');
    release.addEventListener('click', async () => {
      await api('DELETE', `/holds/${hold.id}`);
      toast('Hold released');
      loadHolds();
    });
    const actions = el('div', 'card-actions');
    actions.append(release);
    card.append(actions);

    // Live countdown makes the TTL visible rather than described.
    const expiresAt = new Date(hold.expiresAt).getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      countdown.textContent = remaining ? `expires in ${remaining}s` : 'expired — slot released';
      if (!remaining) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();

    list.append(card);
  }
}

async function joinWaitlist() {
  if (!state.user || state.user.role !== 'PATIENT') {
    toast('Sign in as a patient first', 'bad');
    return;
  }

  const doctorId = $('#doctor-select').value;
  const result = await api('POST', '/waitlist', {
    body: {
      doctorId,
      windowStart: new Date(`${$('#from-date').value}T00:00:00Z`).toISOString(),
      windowEnd: new Date(`${$('#to-date').value}T23:59:59Z`).toISOString(),
    },
  });

  if (result.ok) {
    toast('Joined the waitlist — you are notified when a slot frees up', 'ok');
    loadWaitlist();
  } else {
    toast(result.payload?.error?.message ?? 'Could not join waitlist', 'bad');
  }
}

async function loadWaitlist() {
  if (!state.user || state.user.role !== 'PATIENT') return;

  const entries = await apiOrThrow('GET', '/waitlist/me');
  const list = $('#waitlist');
  list.replaceChildren();

  if (!entries.length) {
    list.append(el('div', 'empty', 'Not on any waitlist.'));
    return;
  }

  for (const entry of entries) {
    const card = el('div', 'card');
    // The waitlist payload carries `doctorId` only, so resolve the display
    // name from the directory that is already loaded.
    const doctor = state.doctors.find((candidate) => candidate.id === entry.doctorId);

    const main = el('div', 'card-main');
    main.append(
      el('div', 'card-title', doctor?.fullName ?? 'Doctor'),
      el(
        'div',
        'card-sub',
        `${entry.windowStart.slice(0, 10)} → ${entry.windowEnd.slice(0, 10)} · ${entry.appointmentType}`,
      ),
    );
    card.append(main, el('span', 'pill', entry.status));

    const leave = el('button', 'btn btn-mini', 'Leave');
    leave.addEventListener('click', async () => {
      await api('DELETE', `/waitlist/${entry.id}`);
      loadWaitlist();
    });
    const actions = el('div', 'card-actions');
    actions.append(leave);
    card.append(actions);

    list.append(card);
  }
}

/* ---------------------------- concurrency lab ---------------------------- */

function populateRaceSlots() {
  const select = $('#race-slot');
  select.replaceChildren();

  for (const slot of state.slots.slice(0, 40)) {
    const option = el('option', null, `${slot.local.date} · ${slot.local.startTime}`);
    option.value = slot.id;
    select.append(option);
  }
}

/**
 * Sign in every contender up front.
 *
 * This matters for honesty: the booking rate limiter is keyed per user at
 * 30/min. Firing N requests from one account would return 429s and the demo
 * would be showing the throttle, not the concurrency control. N distinct
 * patients is also a truer model of real contention.
 */
async function ensureRaceTokens(count) {
  const needed = RACE_PATIENTS.slice(0, Math.min(count, RACE_PATIENTS.length));

  await Promise.all(
    needed.map(async (email) => {
      if (state.raceTokens.has(email)) return;
      const result = await api('POST', '/auth/login', {
        body: { email, password: PASSWORD },
        token: null,
        silent: true,
      });
      if (result.ok) state.raceTokens.set(email, result.payload.data.tokens.accessToken);
    }),
  );

  return needed.map((email) => state.raceTokens.get(email)).filter(Boolean);
}

async function runRace() {
  const slotId = $('#race-slot').value;
  if (!slotId) {
    toast('Search for slots first', 'bad');
    return;
  }

  const contenders = Number($('#race-n').value);
  const button = $('#btn-race');
  button.disabled = true;
  button.textContent = 'Signing in contenders…';

  const tokens = await ensureRaceTokens(contenders);
  if (!tokens.length) {
    toast('Could not sign in the demo patients', 'bad');
    button.disabled = false;
    button.textContent = 'Fire simultaneously';
    return;
  }

  button.textContent = 'Firing…';
  $('#race-result').hidden = false;
  $('#race-grid').replaceChildren();
  $('#race-verdict').className = 'verdict';
  $('#race-verdict').textContent = '';

  // Build every request first, then release them together. Awaiting inside
  // the loop would serialise them and prove nothing.
  const startedAt = performance.now();
  const attempts = Array.from({ length: contenders }, (_, index) =>
    api('POST', '/bookings', {
      body: { slotId, reasonForVisit: `Contender ${index + 1}` },
      token: tokens[index % tokens.length],
      silent: true,
    }).then((result) => ({ index, result })),
  );

  const settled = await Promise.all(attempts);
  const elapsedMs = Math.round(performance.now() - startedAt);

  let created = 0;
  let conflict = 0;
  let other = 0;

  const grid = $('#race-grid');
  for (const { index, result } of settled.sort((a, b) => a.index - b.index)) {
    const status = result.status;
    let kind = 'other';
    if (status === 201) {
      created += 1;
      kind = 'win';
    } else if (status === 409) {
      conflict += 1;
      kind = 'lose';
    } else {
      other += 1;
    }

    const cell = el('div', `race-cell ${kind}`);
    cell.append(el('b', null, String(status)));
    cell.append(
      document.createTextNode(
        status === 201
          ? `#${index + 1} won`
          : `#${index + 1} ${result.payload?.error?.code ?? ''}`.trim(),
      ),
    );
    grid.append(cell);
  }

  $('#tally-201').textContent = created;
  $('#tally-409').textContent = conflict;
  $('#tally-other').textContent = other;
  $('#tally-ms').textContent = `${elapsedMs}ms`;

  // The verdict rests on the responses themselves, which are authoritative:
  // the API either created a second confirmed booking or it did not.
  //
  // Public availability is reported separately rather than folded into the
  // pass criterion, because that listing is cached for SLOT_CACHE_TTL_SECONDS.
  // A read issued milliseconds after the race can legitimately still show the
  // slot, and treating that as a failure would be wrong.
  const verdict = $('#race-verdict');
  const passed = created === 1 && other === 0;
  verdict.className = `verdict ${passed ? 'pass' : 'fail'}`;
  verdict.textContent = passed
    ? `Exactly one winner out of ${contenders} simultaneous attempts, in ${elapsedMs}ms. ` +
      `The other ${conflict} received 409 SLOT_UNAVAILABLE. No lock was trusted for this — ` +
      `the partial unique index refused the duplicates. Checking public availability…`
    : `Unexpected: ${created} created, ${conflict} conflicts, ${other} other. ` +
      `Anything other than exactly one 201 would be a real defect.`;

  if (passed) confirmSlotWithdrawn(slotId, verdict);

  button.disabled = false;
  button.textContent = 'Fire simultaneously';

  await Promise.all([searchSlots(), loadBookings()]);
}

/**
 * Poll public availability until the booked slot disappears from it.
 *
 * Not part of the pass/fail decision — purely a visible confirmation that the
 * listing converges once the slot cache expires or is invalidated.
 */
async function confirmSlotWithdrawn(slotId, verdict) {
  const deadline = Date.now() + 20_000;
  const query = new URLSearchParams({
    from: new Date(`${$('#from-date').value}T00:00:00Z`).toISOString(),
    to: new Date(`${$('#to-date').value}T23:59:59Z`).toISOString(),
  });

  while (Date.now() < deadline) {
    const listing = await api('GET', `/doctors/${$('#doctor-select').value}/slots?${query}`, {
      token: null,
      silent: true,
    });
    const present = listing.payload?.data?.slots?.some((slot) => slot.id === slotId) ?? false;

    if (!present) {
      verdict.textContent = verdict.textContent.replace(
        'Checking public availability…',
        'The slot has also been withdrawn from public availability.',
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  verdict.textContent = verdict.textContent.replace(
    'Checking public availability…',
    'Public listing is still warm from cache (SLOT_CACHE_TTL_SECONDS) — it converges shortly.',
  );
}

/** Cancel whatever confirmed booking owns the slot, so the demo can re-run. */
async function resetRaceSlot() {
  const slotId = $('#race-slot').value;
  const tokens = [...state.raceTokens.values()];
  if (!tokens.length) {
    toast('Run the race first', 'bad');
    return;
  }

  for (const token of tokens) {
    const bookings = await api('GET', '/bookings/me?window=all&limit=50', {
      token,
      silent: true,
    });
    const owning = bookings.payload?.data?.find(
      (booking) => booking.slotId === slotId && booking.status === 'CONFIRMED',
    );
    if (owning) {
      await api('DELETE', `/bookings/${owning.id}`, {
        body: { reason: 'Demo reset' },
        token,
      });
      toast('Slot released — ready to run again', 'ok');
      await searchSlots();
      return;
    }
  }
  toast('No confirmed booking found on that slot');
}

/* ------------------------------ doctor view ------------------------------ */

async function loadDiary() {
  if (!state.user || state.user.role !== 'DOCTOR') {
    toast('Sign in as dr.mehta@clinzo.test', 'bad');
    openLogin();
    return;
  }

  const from = new Date(`${$('#from-date').value}T00:00:00Z`).toISOString();
  const to = new Date(`${$('#to-date').value}T23:59:59Z`).toISOString();

  const result = await api('GET', `/availability/slots?${new URLSearchParams({ from, to })}`);
  if (!result.ok) {
    toast(result.payload?.error?.message ?? 'Could not load diary', 'bad');
    return;
  }

  const counts = result.payload.meta?.counts ?? {};
  $('#diary-counts').textContent = Object.entries(counts)
    .map(([status, n]) => `${status}: ${n}`)
    .join('   ');

  const grid = $('#diary');
  grid.replaceChildren();

  for (const slot of result.payload.data) {
    const card = el('div', 'slot is-static');
    const time = new Date(slot.startsAt);
    card.append(
      el('div', 'slot-time', time.toISOString().slice(11, 16)),
      el('div', 'slot-date', `${slot.startsAt.slice(0, 10)} · UTC`),
    );
    const meta = el('div', 'slot-meta');
    meta.append(
      el('span', `pill pill-${slot.status.toLowerCase()}`, slot.status),
      el('span', 'pill', `${slot.durationMinutes} min`),
    );
    if (slot.blockedReason) meta.append(el('span', 'pill pill-blocked', slot.blockedReason));
    card.append(meta);
    grid.append(card);
  }
}

/* --------------------------------- modal --------------------------------- */

function openLogin() {
  $('#login-error').hidden = true;
  $('#login-modal').hidden = false;
}

function buildQuickAccounts() {
  const accounts = [
    ['Patient', 'patient1@clinzo.test'],
    ['Patient 2', 'patient2@clinzo.test'],
    ['Dr Mehta', 'dr.mehta@clinzo.test'],
    ['Dr Okafor', 'dr.okafor@clinzo.test'],
    ['Admin', 'admin@clinzo.test'],
  ];

  const box = $('#quick-accounts');
  for (const [label, email] of accounts) {
    const button = el('button', 'quick', label);
    button.addEventListener('click', () => {
      $('#login-email').value = email;
    });
    box.append(button);
  }
}

/* --------------------------------- wiring -------------------------------- */

function switchView(name) {
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('is-active', view.dataset.view === name));

  if (name === 'bookings') loadBookings().catch(() => {});
  if (name === 'holds') {
    loadHolds().catch(() => {});
    loadWaitlist().catch(() => {});
  }
}

function wire() {
  $$('.nav-item').forEach((item) =>
    item.addEventListener('click', () => switchView(item.dataset.view)),
  );

  $('#btn-login').addEventListener('click', openLogin);
  $('#btn-cancel-login').addEventListener('click', () => {
    $('#login-modal').hidden = true;
  });
  $('#btn-logout').addEventListener('click', () => logout().catch(() => {}));

  $('#btn-do-login').addEventListener('click', async () => {
    try {
      await login($('#login-email').value.trim(), $('#login-password').value);
      $('#login-modal').hidden = true;
      toast(`Signed in as ${state.user.fullName}`, 'ok');
      loadBookings().catch(() => {});
    } catch (error) {
      const box = $('#login-error');
      box.textContent = error.message;
      box.hidden = false;
    }
  });

  $('#btn-search').addEventListener('click', () =>
    searchSlots().catch((e) => toast(e.message, 'bad')),
  );
  $('#btn-refresh-bookings').addEventListener('click', () => loadBookings().catch(() => {}));
  $('#btn-refresh-holds').addEventListener('click', () => loadHolds().catch(() => {}));
  $('#btn-join-waitlist').addEventListener('click', () => joinWaitlist().catch(() => {}));
  $('#btn-race').addEventListener('click', () => runRace().catch((e) => toast(e.message, 'bad')));
  $('#btn-race-reset').addEventListener('click', () => resetRaceSlot().catch(() => {}));
  $('#btn-diary').addEventListener('click', () => loadDiary().catch(() => {}));
  $('#btn-clear-log').addEventListener('click', () => $('#log').replaceChildren());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $('#login-modal').hidden = true;
  });
}

async function boot() {
  const today = new Date();
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
  $('#from-date').value = isoDate(today);
  $('#to-date').value = isoDate(inThreeDays);

  buildQuickAccounts();
  wire();
  renderSession();

  pollHealth();
  setInterval(pollHealth, 10_000);

  try {
    await loadDoctors();
    await searchSlots();
  } catch (error) {
    toast(`Could not reach the API: ${error.message}`, 'bad');
  }
}

boot();

import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { env } from './env';

/**
 * Prometheus instrumentation.
 *
 * Metric selection follows RED (Rate, Errors, Duration) for HTTP plus a small
 * set of domain counters that answer the questions this system actually gets
 * asked in an incident: "are we losing booking races?", "are holds expiring
 * instead of converting?", "is lock contention up?".
 *
 * Label cardinality is deliberately bounded — `route` uses the Express route
 * pattern (`/bookings/:id`), never the concrete URL, so a million booking ids
 * cannot become a million time series.
 */

export const registry = new Registry();

registry.setDefaultLabels({ service: 'clinzo-scheduling', env: env.NODE_ENV });

if (env.METRICS_ENABLED) {
  client.collectDefaultMetrics({ register: registry, prefix: 'clinzo_' });
}

export const httpRequestsTotal = new Counter({
  name: 'clinzo_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'clinzo_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  // Buckets tuned for an API whose p99 target is ~500ms.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
  name: 'clinzo_http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [registry],
});

/** Booking outcomes. `result` is one of: confirmed | conflict | rejected. */
export const bookingAttemptsTotal = new Counter({
  name: 'clinzo_booking_attempts_total',
  help: 'Booking attempts by outcome',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Increments when the database — not the application check — rejected a
 * booking. A non-zero rate here is healthy (it proves the last line of defence
 * is live); a *high* rate means lock contention is being lost too often.
 */
export const bookingRaceLossesTotal = new Counter({
  name: 'clinzo_booking_race_losses_total',
  help: 'Bookings rejected by a database uniqueness constraint under contention',
  labelNames: ['stage'] as const,
  registers: [registry],
});

export const bookingDuration = new Histogram({
  name: 'clinzo_booking_duration_seconds',
  help: 'End-to-end duration of the booking transaction',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const lockAcquisitionsTotal = new Counter({
  name: 'clinzo_lock_acquisitions_total',
  help: 'Distributed lock acquisition attempts by outcome',
  labelNames: ['resource', 'result'] as const,
  registers: [registry],
});

export const lockWaitDuration = new Histogram({
  name: 'clinzo_lock_wait_duration_seconds',
  help: 'Time spent waiting to acquire a distributed lock',
  labelNames: ['resource'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 3],
  registers: [registry],
});

export const reservationHoldsTotal = new Counter({
  name: 'clinzo_reservation_holds_total',
  help: 'Reservation hold lifecycle transitions',
  labelNames: ['event'] as const, // created | consumed | released | expired
  registers: [registry],
});

export const slotsGeneratedTotal = new Counter({
  name: 'clinzo_slots_generated_total',
  help: 'Slots materialised from availability windows',
  registers: [registry],
});

export const slotCacheTotal = new Counter({
  name: 'clinzo_slot_cache_total',
  help: 'Slot listing cache lookups',
  labelNames: ['result'] as const, // hit | miss | bypass
  registers: [registry],
});

export const outboxEventsTotal = new Counter({
  name: 'clinzo_outbox_events_total',
  help: 'Outbox event relay outcomes',
  labelNames: ['event_type', 'result'] as const,
  registers: [registry],
});

export const outboxBacklog = new Gauge({
  name: 'clinzo_outbox_backlog',
  help: 'Number of PENDING outbox events awaiting relay',
  registers: [registry],
});

export const jobsProcessedTotal = new Counter({
  name: 'clinzo_jobs_processed_total',
  help: 'Background jobs processed by queue and outcome',
  labelNames: ['queue', 'result'] as const,
  registers: [registry],
});

export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

export function getMetricsContentType(): string {
  return registry.contentType;
}

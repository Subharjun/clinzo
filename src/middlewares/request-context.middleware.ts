import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../utils/logger';
import { httpRequestDuration, httpRequestsInFlight, httpRequestsTotal } from '../config/metrics';

/**
 * Correlation, logging and RED metrics for every request.
 *
 * Ordering matters: this runs before routing, so `requestId` is available to
 * everything downstream including the error handler.
 */

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Attach a request id, honouring an upstream one when present so a trace
 * survives across service hops. Echoed back so clients can quote it in a
 * support ticket.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  // Only trust an upstream id that looks like a UUID; an attacker-controlled
  // free-text header would otherwise pollute log indexes.
  const id = incoming && /^[0-9a-fA-F-]{8,64}$/.test(incoming) ? incoming : randomUUID();

  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/** Structured access logging with per-request child loggers. */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as Request).requestId ?? randomUUID(),
  customLogLevel: (_req, res, err) => {
    if (err) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} failed: ${err.message}`,
  customProps: (req) => {
    const request = req as Request;
    return {
      requestId: request.requestId,
      // Included so every log line can be filtered by actor during an incident.
      userId: request.user?.id ?? null,
      userRole: request.user?.role ?? null,
    };
  },
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      // Headers are excluded wholesale rather than redacted selectively —
      // the safest default for a healthcare API.
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: {
    ignore: (req) => {
      const url = (req as Request).url ?? '';
      // Probes and scrapes would otherwise dominate log volume.
      return url.startsWith('/health') || url.startsWith('/metrics');
    },
  },
});

/**
 * Per-request Prometheus instrumentation.
 *
 * The route label is taken from `req.route.path` (the Express *pattern*), not
 * the concrete URL. Using the URL would create one time series per booking id
 * and take the metrics endpoint down within a day.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/metrics') return next();

  const startedAt = process.hrtime.bigint();
  httpRequestsInFlight.inc();

  res.on('finish', () => {
    httpRequestsInFlight.dec();

    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const route = resolveRoutePattern(req);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
  });

  next();
}

/**
 * Resolve the low-cardinality route label. Falls back to `unmatched` for 404s
 * so scanners probing random paths cannot inflate cardinality.
 */
function resolveRoutePattern(req: Request): string {
  const routePath = req.route?.path as string | undefined;
  if (routePath) {
    const mountPath = req.baseUrl || '';
    return `${mountPath}${routePath === '/' ? '' : routePath}` || '/';
  }
  return 'unmatched';
}

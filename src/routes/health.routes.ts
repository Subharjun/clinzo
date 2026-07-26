import { Router, type Request, type Response } from 'express';
import { checkDatabaseHealth } from '../config/prisma';
import { checkRedisHealth } from '../config/redis';
import { getMetrics, getMetricsContentType } from '../config/metrics';
import { asyncHandler } from '../utils/http';

/**
 * Health and observability endpoints.
 *
 * Liveness and readiness are separate on purpose, because conflating them
 * causes outages: if `/health` checks Postgres and the orchestrator uses it as
 * a liveness probe, a brief database blip restarts every replica — turning a
 * recoverable dependency failure into a full outage.
 *
 *  - `/health/live`  — is the process running? No dependencies checked.
 *  - `/health/ready` — can it serve traffic? Dependencies checked; a failure
 *                      removes the pod from the load balancer but does NOT
 *                      restart it.
 *  - `/health`       — human-facing aggregate.
 */
export const healthRouter = Router();

const startedAt = Date.now();

/** Liveness. Deliberately dependency-free. */
healthRouter.get('/live', (_req: Request, res: Response) => {
  res
    .status(200)
    .json({ status: 'alive', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
});

/** Readiness. 503 when a dependency is down, so traffic is routed elsewhere. */
healthRouter.get(
  '/ready',
  asyncHandler(async (_req: Request, res: Response) => {
    const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
    const ready = database && redis;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: database ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      },
    });
  }),
);

/** Aggregate view for humans and uptime monitors. */
healthRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
    const healthy = database && redis;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      checks: {
        database: database ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      },
    });
  }),
);

/** Prometheus scrape target. */
export const metricsRouter = Router();

metricsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('content-type', getMetricsContentType());
    res.send(await getMetrics());
  }),
);

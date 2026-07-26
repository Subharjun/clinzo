import path from 'node:path';
import express, { type Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import swaggerUi from 'swagger-ui-express';
import { env, isProduction } from './config/env';
import { apiRouter } from './routes';
import { healthRouter, metricsRouter } from './routes/health.routes';
import { openApiDocument } from './docs/openapi';
import {
  metricsMiddleware,
  requestId,
  requestLogger,
} from './middlewares/request-context.middleware';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { globalLimiter } from './middlewares/rate-limit.middleware';
import { ForbiddenError } from './utils/errors';

/**
 * Express application assembly.
 *
 * Middleware order is load-bearing and is documented inline. The application
 * is built as a pure function of configuration and exported without listening,
 * so integration tests can drive it with supertest and no open port.
 */
export function createApp(): Application {
  const app = express();

  // ---- 1. Proxy awareness -------------------------------------------------
  // Required before anything reads `req.ip`. Set to 1 rather than `true`:
  // trusting the whole X-Forwarded-For chain lets a client spoof its own
  // address and defeat IP-based rate limiting.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ---- 2. Correlation -----------------------------------------------------
  // First, so every later log line and error response carries a request id.
  app.use(requestId);
  app.use(requestLogger);
  app.use(metricsMiddleware);

  // ---- 3. Security headers ------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              // Swagger UI injects inline styles and scripts; scoped to the
              // docs route only in production deployments that expose it.
              styleSrc: ["'self'", "'unsafe-inline'"],
              scriptSrc: ["'self'"],
              imgSrc: ["'self'", 'data:'],
            },
          }
        : false,
      // The API is consumed by browsers on other origins; COEP would break
      // those requests for no benefit on a JSON API.
      crossOriginEmbedderPolicy: false,
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser clients (curl, mobile apps) send no
        // Origin header and must not be rejected.
        if (!origin) return callback(null, true);

        if (env.CORS_ORIGINS.includes(origin) || env.CORS_ORIGINS.includes('*')) {
          return callback(null, true);
        }
        callback(new ForbiddenError(`Origin ${origin} is not permitted`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
      maxAge: 86_400,
    }),
  );

  // ---- 4. Body parsing ----------------------------------------------------
  // A 100kb ceiling: no legitimate request to this API is larger, and an
  // unbounded parser is a trivial memory-exhaustion vector.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use(compression());

  // ---- 5. Observability ---------------------------------------------------
  // Mounted before the rate limiter: a probe must never be throttled, or a
  // traffic spike would take healthy replicas out of the load balancer.
  app.use('/health', healthRouter);
  if (env.METRICS_ENABLED) {
    app.use('/metrics', metricsRouter);
  }

  // ---- 6. Documentation ---------------------------------------------------
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'Clinzo Scheduling API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  // ---- 6b. Demo console ---------------------------------------------------
  // A dependency-free static client used to demonstrate the API. Mounted
  // before the rate limiter deliberately: page assets are not API calls and
  // must not consume a caller's request budget — otherwise a reload during
  // the concurrency demo would eat into the very quota being demonstrated.
  //
  // `../public` resolves correctly both from `src/` under tsx and from
  // `dist/` after a build, because both sit one level below the project root.
  app.use(
    '/app',
    express.static(path.resolve(__dirname, '..', 'public'), {
      index: 'index.html',
      maxAge: isProduction ? '1h' : 0,
    }),
  );

  // ---- 7. Rate limiting ---------------------------------------------------
  app.use(globalLimiter);

  // ---- 8. API -------------------------------------------------------------
  // Versioned prefix so a breaking change can ship alongside v1 rather than
  // replacing it.
  app.use('/api/v1', apiRouter);

  app.get('/', (_req, res) => {
    res.json({
      service: 'clinzo-scheduling',
      version: '1.0.0',
      documentation: '/docs',
      health: '/health',
      demoConsole: '/app',
    });
  });

  // ---- 9. Terminators -----------------------------------------------------
  // Must be last: the 404 handler catches anything unmatched, and the error
  // handler must see errors from every layer above it.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();

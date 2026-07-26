import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment parsing and validation.
 *
 * The process refuses to start on invalid configuration. Failing at boot with
 * a precise message is strictly better than failing at 3am on the first
 * request that happens to read a mis-typed variable.
 */

/** Coerce a decimal string into a positive integer. */
const intFromEnv = (fallback?: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int());

const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    })
    .pipe(z.boolean());

const csvFromEnv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ''
        ? fallback
        : value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
    );

/** e.g. `15m`, `30d`, `900s`. Consumed directly by jsonwebtoken. */
const durationString = z.string().regex(/^\d+[smhdw]$/, 'expected a duration like "15m" or "30d"');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intFromEnv(3000),
    SHUTDOWN_TIMEOUT_MS: intFromEnv(15_000),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: durationString.default('15m'),
    JWT_REFRESH_TTL: durationString.default('30d'),
    JWT_ISSUER: z.string().default('clinzo.health'),
    JWT_AUDIENCE: z.string().default('clinzo.api'),

    BCRYPT_ROUNDS: intFromEnv(12).pipe(z.number().min(4).max(15)),
    CORS_ORIGINS: csvFromEnv(['http://localhost:3000']),

    RATE_LIMIT_WINDOW_MS: intFromEnv(60_000),
    RATE_LIMIT_MAX: intFromEnv(300),
    AUTH_RATE_LIMIT_MAX: intFromEnv(10),
    BOOKING_RATE_LIMIT_MAX: intFromEnv(30),

    DEFAULT_SLOT_DURATION_MINUTES: intFromEnv(15).pipe(z.number().min(1).max(1440)),
    DEFAULT_BUFFER_MINUTES: intFromEnv(0).pipe(z.number().min(0).max(1440)),
    RESERVATION_HOLD_TTL_SECONDS: intFromEnv(120).pipe(z.number().min(10).max(3600)),
    SLOT_GENERATION_HORIZON_DAYS: intFromEnv(60).pipe(z.number().min(1).max(365)),
    MAX_SLOTS_PER_GENERATION: intFromEnv(5000).pipe(z.number().min(1).max(200_000)),
    MIN_BOOKING_LEAD_MINUTES: intFromEnv(0).pipe(z.number().min(0)),

    LOCK_TTL_MS: intFromEnv(5000).pipe(z.number().min(100)),
    LOCK_ACQUIRE_TIMEOUT_MS: intFromEnv(3000).pipe(z.number().min(0)),
    LOCK_RETRY_DELAY_MS: intFromEnv(40).pipe(z.number().min(1)),

    SLOT_CACHE_TTL_SECONDS: intFromEnv(15).pipe(z.number().min(0).max(3600)),

    BULLMQ_PREFIX: z.string().default('clinzo'),
    OUTBOX_POLL_INTERVAL_MS: intFromEnv(2000).pipe(z.number().min(100)),
    OUTBOX_BATCH_SIZE: intFromEnv(100).pipe(z.number().min(1).max(1000)),
    WORKER_CONCURRENCY: intFromEnv(10).pipe(z.number().min(1).max(200)),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: boolFromEnv(false),

    METRICS_ENABLED: boolFromEnv(true),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET, otherwise an access token can be replayed as a refresh token',
      });
    }
    if (value.NODE_ENV === 'production' && value.JWT_ACCESS_SECRET.startsWith('change-me')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'refusing to boot in production with the placeholder JWT secret from .env.example',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Intentionally not routed through the logger: the logger itself depends
    // on this config, so it may not exist yet. (`console.error` is permitted
    // by the lint config; `console.log` would not be.)
    console.error(`Invalid environment configuration:\n${details}`);
    throw new Error('Invalid environment configuration');
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

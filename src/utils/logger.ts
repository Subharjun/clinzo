import pino, { type Logger, type LoggerOptions } from 'pino';
import { env, isProduction } from '../config/env';

/**
 * Structured logging.
 *
 * Two hard rules encoded here:
 *  1. Secrets never reach a log sink — redaction is centralised in `redact`
 *     rather than left to each call site to remember.
 *  2. Logs are JSON in every environment except local development, so they
 *     stay machine-parseable by whatever ships them.
 */

/**
 * Paths scrubbed from every log record. `censor` replaces the value, so the
 * *presence* of the field is still visible for debugging — only its content
 * disappears.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  'body.password',
  'body.refreshToken',
];

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACTED_PATHS,
    censor: '[REDACTED]',
  },
  base: {
    service: 'clinzo-scheduling',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Emit `level: "info"` rather than `level: 30` — most log platforms
    // filter on the string form.
    level: (label) => ({ level: label }),
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
};

const prettyTransport =
  env.LOG_PRETTY && !isProduction
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
            singleLine: false,
          },
        },
      }
    : {};

export const logger: Logger = pino({ ...baseOptions, ...prettyTransport });

/**
 * Child logger carrying a fixed set of correlation fields.
 * Preferred over interpolating ids into every message.
 */
export function createLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

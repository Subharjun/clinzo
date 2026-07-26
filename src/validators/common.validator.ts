import { z } from 'zod';
import { isValidTimezone, parseTimeToMinutes } from '../utils/time';

/**
 * Shared schema primitives.
 *
 * Defining these once means "what is a valid timezone" or "what is a sane page
 * size" has exactly one answer across the API, and changing it changes it
 * everywhere.
 */

export const uuidSchema = z.string().uuid('must be a valid UUID');

export const idParamSchema = z.object({
  id: uuidSchema,
});

/** IANA zone, validated against the runtime's own tz database. */
export const timezoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimezone, { message: 'must be a valid IANA timezone, e.g. "Asia/Kolkata"' });

/** `YYYY-MM-DD`, checked for real calendar validity (rejects 2026-02-30). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be formatted YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'must be a real calendar date');

/** Full ISO-8601 instant, coerced to a Date. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: 'must be an ISO-8601 timestamp with a timezone offset' })
  .transform((value) => new Date(value));

/** 24-hour `HH:mm`, transformed into minutes from local midnight. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be a 24-hour time such as "09:30"')
  .transform(parseTimeToMinutes);

export const minuteOfDaySchema = z
  .number()
  .int('must be a whole number of minutes')
  .min(0)
  .max(1440);

/**
 * Page/limit with a hard ceiling. An unbounded `limit` is a denial-of-service
 * vector on any list endpoint, so the cap is enforced by the schema rather
 * than trusted to callers.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const passwordSchema = z
  .string()
  .min(12, 'must be at least 12 characters')
  .max(128, 'must be at most 128 characters')
  // Deliberately not requiring symbol classes: length dominates for entropy,
  // and composition rules push users toward predictable substitutions.
  .refine((value) => !/^\s|\s$/.test(value), 'must not start or end with whitespace');

export const emailSchema = z
  .string()
  .email('must be a valid email address')
  .max(254)
  .transform((value) => value.trim().toLowerCase());

export const appointmentTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9_]+$/, 'must be upper-case letters, digits and underscores');

export const appointmentModeSchema = z.enum(['VIDEO', 'IN_CLINIC']);

export const weekdaySchema = z
  .number()
  .int()
  .min(1, 'must be 1 (Monday) through 7 (Sunday)')
  .max(7, 'must be 1 (Monday) through 7 (Sunday)');

import { z } from 'zod';
import {
  appointmentModeSchema,
  appointmentTypeSchema,
  isoDateSchema,
  timeOfDaySchema,
  timezoneSchema,
  weekdaySchema,
} from './common.validator';

/**
 * Request schemas for `/availability`.
 *
 * Windows are expressed as `"HH:mm"` strings at the API boundary and stored as
 * minutes-from-midnight internally. The transform happens here so no
 * controller or service ever parses a time string.
 */

const baseWindow = {
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
  timezone: timezoneSchema.optional(),
  slotDurationMinutes: z.number().int().min(5).max(480).optional(),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
  mode: appointmentModeSchema.optional(),
  appointmentType: appointmentTypeSchema.optional(),
  horizonDays: z.number().int().min(1).max(365).optional(),
};

/**
 * Discriminated on `kind`, so the "one-off needs a date, recurring needs a
 * weekday" rule is enforced by the type system rather than by a runtime check
 * someone can forget.
 */
export const createAvailabilitySchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('ONE_OFF'),
      date: isoDateSchema,
      ...baseWindow,
    }),
    z.object({
      kind: z.literal('RECURRING'),
      weekday: weekdaySchema,
      effectiveFrom: isoDateSchema.optional(),
      effectiveUntil: isoDateSchema.optional(),
      ...baseWindow,
    }),
  ])
  .refine((value) => value.endTime > value.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  })
  .refine(
    (value) =>
      value.kind === 'ONE_OFF' ||
      !value.effectiveFrom ||
      !value.effectiveUntil ||
      value.effectiveUntil >= value.effectiveFrom,
    { message: 'effectiveUntil must not precede effectiveFrom', path: ['effectiveUntil'] },
  )
  .refine(
    (value) => {
      // A window must be able to hold at least one consultation, or the
      // request silently produces nothing.
      const duration = value.slotDurationMinutes ?? 15;
      return value.endTime - value.startTime >= duration;
    },
    {
      message: 'the window is shorter than a single consultation and would generate no slots',
      path: ['endTime'],
    },
  );

export const updateAvailabilitySchema = z
  .object({
    startTime: timeOfDaySchema.optional(),
    endTime: timeOfDaySchema.optional(),
    slotDurationMinutes: z.number().int().min(5).max(480).optional(),
    bufferMinutes: z.number().int().min(0).max(240).optional(),
    mode: appointmentModeSchema.optional(),
    appointmentType: appointmentTypeSchema.optional(),
    effectiveFrom: isoDateSchema.nullable().optional(),
    effectiveUntil: isoDateSchema.nullable().optional(),
    isActive: z.boolean().optional(),
    /**
     * Required. Optimistic locking is only meaningful if the client cannot opt
     * out of it — an absent version would mean "overwrite whatever is there".
     */
    version: z.number().int().min(0),
  })
  .refine(
    (value) =>
      value.startTime === undefined ||
      value.endTime === undefined ||
      value.endTime > value.startTime,
    { message: 'endTime must be after startTime', path: ['endTime'] },
  )
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'supply at least one field to change',
  });

export const listAvailabilityQuerySchema = z.object({
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type CreateAvailabilityBody = z.infer<typeof createAvailabilitySchema>;
export type UpdateAvailabilityBody = z.infer<typeof updateAvailabilitySchema>;

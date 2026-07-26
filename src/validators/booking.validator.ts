import { z } from 'zod';
import {
  appointmentModeSchema,
  appointmentTypeSchema,
  isoDateTimeSchema,
  paginationSchema,
  timezoneSchema,
  uuidSchema,
} from './common.validator';

/** Request schemas for `/bookings`, `/holds`, `/slots` and `/waitlist`. */

export const createBookingSchema = z.object({
  slotId: uuidSchema,
  reasonForVisit: z.string().max(1000).trim().optional(),
  /** Supply when completing a checkout that began with a reservation hold. */
  holdId: uuidSchema.optional(),
});

export const cancelBookingSchema = z.object({
  reason: z.string().max(500).trim().optional(),
});

export const rescheduleBookingSchema = z.object({
  targetSlotId: uuidSchema,
  reason: z.string().max(500).trim().optional(),
});

export const listBookingsQuerySchema = paginationSchema.extend({
  window: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  status: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((entry) => entry.trim().toUpperCase())
            .filter(Boolean)
        : undefined,
    )
    .pipe(
      z.array(z.enum(['CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW'])).optional(),
    ),
});

/**
 * Slot listing query.
 *
 * `from`/`to` are full ISO instants rather than dates: a patient in one
 * timezone querying a doctor in another needs to say precisely which window
 * they mean, and "2026-03-02" is ambiguous between them.
 */
export const listSlotsQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    appointmentType: appointmentTypeSchema.optional(),
    mode: appointmentModeSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .refine((value) => value.to > value.from, {
    message: 'to must be after from',
    path: ['to'],
  });

export const doctorSlotParamsSchema = z.object({
  id: uuidSchema,
});

export const createHoldSchema = z.object({
  slotId: uuidSchema,
  /** Correlates the hold with the payment attempt that owns it. */
  checkoutReference: z.string().max(128).optional(),
});

export const joinWaitlistSchema = z
  .object({
    doctorId: uuidSchema,
    windowStart: isoDateTimeSchema,
    windowEnd: isoDateTimeSchema,
    appointmentType: appointmentTypeSchema.optional(),
  })
  .refine((value) => value.windowEnd > value.windowStart, {
    message: 'windowEnd must be after windowStart',
    path: ['windowEnd'],
  });

export const listDoctorsQuerySchema = paginationSchema.extend({
  specialization: z.string().max(120).optional(),
  search: z.string().max(120).optional(),
  acceptingPatientsOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type CreateBookingBody = z.infer<typeof createBookingSchema>;
export type RescheduleBookingBody = z.infer<typeof rescheduleBookingSchema>;
export type ListSlotsQuery = z.infer<typeof listSlotsQuerySchema>;

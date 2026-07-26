import { Router } from 'express';
import { Role } from '@prisma/client';
import { authRouter } from './auth.routes';
import { availabilityController } from '../controllers/availability.controller';
import { bookingController } from '../controllers/booking.controller';
import { slotController } from '../controllers/slot.controller';
import { holdController } from '../controllers/hold.controller';
import {
  doctorController,
  patientController,
  waitlistController,
} from '../controllers/user.controller';
import { validate } from '../middlewares/validate.middleware';
import { authenticate, authorize, requireProfile } from '../middlewares/auth.middleware';
import { bookingLimiter } from '../middlewares/rate-limit.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import { asyncHandler } from '../utils/http';
import { idParamSchema, isoDateTimeSchema } from '../validators/common.validator';
import {
  createAvailabilitySchema,
  updateAvailabilitySchema,
} from '../validators/availability.validator';
import {
  cancelBookingSchema,
  createBookingSchema,
  createHoldSchema,
  joinWaitlistSchema,
  listBookingsQuerySchema,
  listDoctorsQuerySchema,
  listSlotsQuerySchema,
  rescheduleBookingSchema,
} from '../validators/booking.validator';
import { z } from 'zod';

/**
 * API router.
 *
 * Middleware order on every protected route is: authenticate -> authorize ->
 * validate -> handler. Authorising before validating means an unauthorised
 * caller learns nothing about the expected request shape.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);

// ---------------------------------------------------------------------------
// Doctors — public directory plus the doctor's own profile.
// ---------------------------------------------------------------------------

apiRouter.get(
  '/doctors',
  validate({ query: listDoctorsQuerySchema }),
  asyncHandler(doctorController.list),
);

apiRouter.get(
  '/doctors/me',
  authenticate,
  authorize(Role.DOCTOR),
  asyncHandler(doctorController.getMe),
);

apiRouter.get(
  '/doctors/:id',
  validate({ params: idParamSchema }),
  asyncHandler(doctorController.getById),
);

/**
 * Public slot discovery. Unauthenticated by design — patients compare
 * availability before creating an account, and free/busy times are not
 * confidential. Only AVAILABLE slots are exposed; who booked the rest is not.
 */
apiRouter.get(
  '/doctors/:id/slots',
  validate({ params: idParamSchema, query: listSlotsQuerySchema }),
  asyncHandler(slotController.listForDoctor),
);

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

apiRouter.get(
  '/patients/me',
  authenticate,
  authorize(Role.PATIENT),
  asyncHandler(patientController.getMe),
);

// ---------------------------------------------------------------------------
// Availability — doctor-owned.
// ---------------------------------------------------------------------------

apiRouter.post(
  '/availability',
  authenticate,
  authorize(Role.DOCTOR),
  requireProfile(),
  validate({ body: createAvailabilitySchema }),
  asyncHandler(availabilityController.create),
);

apiRouter.get(
  '/availability',
  authenticate,
  authorize(Role.DOCTOR),
  requireProfile(),
  asyncHandler(availabilityController.listMine),
);

apiRouter.put(
  '/availability/:id',
  authenticate,
  authorize(Role.DOCTOR),
  requireProfile(),
  validate({ params: idParamSchema, body: updateAvailabilitySchema }),
  asyncHandler(availabilityController.update),
);

apiRouter.delete(
  '/availability/:id',
  authenticate,
  authorize(Role.DOCTOR),
  requireProfile(),
  validate({ params: idParamSchema }),
  asyncHandler(availabilityController.remove),
);

/** The doctor's own calendar, including HELD and BLOCKED slots. */
apiRouter.get(
  '/availability/slots',
  authenticate,
  authorize(Role.DOCTOR),
  requireProfile(),
  validate({
    query: z.object({
      from: isoDateTimeSchema,
      to: isoDateTimeSchema,
      status: z.enum(['AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED']).optional(),
    }),
  }),
  asyncHandler(slotController.listMine),
);

// ---------------------------------------------------------------------------
// Reservation holds — the checkout window.
// ---------------------------------------------------------------------------

apiRouter.post(
  '/holds',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  bookingLimiter,
  validate({ body: createHoldSchema }),
  asyncHandler(holdController.create),
);

apiRouter.get(
  '/holds/me',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  asyncHandler(holdController.listMine),
);

apiRouter.delete(
  '/holds/:id',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  validate({ params: idParamSchema }),
  asyncHandler(holdController.release),
);

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

apiRouter.post(
  '/bookings',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  bookingLimiter,
  // Optional rather than required: clients that send an Idempotency-Key get
  // safe retries, clients that do not are unaffected.
  idempotency(),
  validate({ body: createBookingSchema }),
  asyncHandler(bookingController.create),
);

apiRouter.get(
  '/bookings/me',
  authenticate,
  authorize(Role.PATIENT, Role.DOCTOR),
  requireProfile(),
  validate({ query: listBookingsQuerySchema }),
  asyncHandler(bookingController.listMine),
);

apiRouter.get(
  '/bookings/:id',
  authenticate,
  authorize(Role.PATIENT, Role.DOCTOR, Role.ADMIN),
  validate({ params: idParamSchema }),
  asyncHandler(bookingController.getById),
);

apiRouter.delete(
  '/bookings/:id',
  authenticate,
  authorize(Role.PATIENT, Role.DOCTOR, Role.ADMIN),
  validate({ params: idParamSchema, body: cancelBookingSchema }),
  asyncHandler(bookingController.cancel),
);

apiRouter.put(
  '/bookings/:id/reschedule',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  bookingLimiter,
  idempotency(),
  validate({ params: idParamSchema, body: rescheduleBookingSchema }),
  asyncHandler(bookingController.reschedule),
);

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

apiRouter.post(
  '/waitlist',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  validate({ body: joinWaitlistSchema }),
  asyncHandler(waitlistController.join),
);

apiRouter.get(
  '/waitlist/me',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  asyncHandler(waitlistController.listMine),
);

apiRouter.delete(
  '/waitlist/:id',
  authenticate,
  authorize(Role.PATIENT),
  requireProfile(),
  validate({ params: idParamSchema }),
  asyncHandler(waitlistController.cancel),
);

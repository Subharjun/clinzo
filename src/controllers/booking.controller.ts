import type { Request, Response } from 'express';
import { CancelledBy, Role } from '@prisma/client';
import { bookingService } from '../services/booking.service';
import { clientIp, sendCreated, sendSuccess } from '../utils/http';
import { toZonedDate, toZonedIso, toZonedTime } from '../utils/time';
import type { SessionContext } from '../services/auth.service';
import type { BookingWithRelations } from '../repositories/booking.repository';

/** `/bookings` controllers. */

function sessionContext(req: Request): SessionContext {
  return {
    userId: req.user?.id ?? null,
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}

/**
 * Serialise a booking.
 *
 * Times are returned three ways — the UTC instant, the viewer's local
 * rendering, and the counterparty's — because a video consultation between two
 * timezones is exactly where clients get this wrong.
 */
function toView(booking: BookingWithRelations, viewerTimezone: string) {
  return {
    id: booking.id,
    confirmationCode: booking.confirmationCode,
    status: booking.status,
    slotId: booking.slotId,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    mode: booking.mode,
    appointmentType: booking.appointmentType,
    reasonForVisit: booking.reasonForVisit,
    local: {
      timezone: viewerTimezone,
      date: toZonedDate(booking.startsAt, viewerTimezone),
      startTime: toZonedTime(booking.startsAt, viewerTimezone),
      endTime: toZonedTime(booking.endsAt, viewerTimezone),
      startsAt: toZonedIso(booking.startsAt, viewerTimezone),
    },
    doctor: {
      id: booking.doctorId,
      fullName: booking.doctor.user.fullName,
      specialization: booking.doctor.specialization,
      timezone: booking.doctor.timezone,
      localStartTime: toZonedTime(booking.startsAt, booking.doctor.timezone),
    },
    patient: {
      id: booking.patientId,
      fullName: booking.patient.user.fullName,
      timezone: booking.patient.timezone,
    },
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    cancelledBy: booking.cancelledBy,
    cancellationReason: booking.cancellationReason,
    rescheduledFromId: booking.rescheduledFromId,
    createdAt: booking.createdAt.toISOString(),
  };
}

/** Whose clock to render in: the caller's own party to the appointment. */
function viewerTimezoneFor(req: Request, booking: BookingWithRelations): string {
  if (req.user?.role === Role.DOCTOR) return booking.doctor.timezone;
  return booking.patient.timezone;
}

export const bookingController = {
  async create(req: Request, res: Response): Promise<void> {
    const booking = await bookingService.create(
      {
        slotId: req.body.slotId,
        patientId: req.user!.profileId as string,
        reasonForVisit: req.body.reasonForVisit,
        holdId: req.body.holdId,
      },
      sessionContext(req),
    );

    sendCreated(res, toView(booking, viewerTimezoneFor(req, booking)));
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const role = req.user!.role;

    const booking = await bookingService.cancel(
      {
        bookingId: req.params['id'] as string,
        // Who is recorded as cancelling follows the caller's role, so the
        // audit trail distinguishes a patient dropping out from a clinic
        // cancelling a clinic.
        cancelledBy:
          role === Role.DOCTOR
            ? CancelledBy.DOCTOR
            : role === Role.ADMIN
              ? CancelledBy.ADMIN
              : CancelledBy.PATIENT,
        actorRole: role,
        actorPatientId: role === Role.PATIENT ? req.user!.profileId : null,
        actorDoctorId: role === Role.DOCTOR ? req.user!.profileId : null,
        reason: req.body?.reason,
      },
      sessionContext(req),
    );

    sendSuccess(res, toView(booking, viewerTimezoneFor(req, booking)));
  },

  async reschedule(req: Request, res: Response): Promise<void> {
    const booking = await bookingService.reschedule(
      {
        bookingId: req.params['id'] as string,
        targetSlotId: req.body.targetSlotId,
        patientId: req.user!.profileId as string,
        reason: req.body.reason,
      },
      sessionContext(req),
    );

    sendSuccess(res, toView(booking, viewerTimezoneFor(req, booking)));
  },

  async listMine(req: Request, res: Response): Promise<void> {
    const { page, limit, window, status } = req.query as unknown as {
      page: number;
      limit: number;
      window: 'upcoming' | 'past' | 'all';
      status?: Array<BookingWithRelations['status']>;
    };

    const result =
      req.user!.role === Role.DOCTOR
        ? await bookingService.listForDoctor(
            req.user!.profileId as string,
            { window, status },
            { page, limit },
          )
        : await bookingService.listForPatient(
            req.user!.profileId as string,
            { window, status },
            { page, limit },
          );

    sendSuccess(
      res,
      result.data.map((booking) => toView(booking, viewerTimezoneFor(req, booking))),
      200,
      { pagination: result.pagination },
    );
  },

  async getById(req: Request, res: Response): Promise<void> {
    const booking = await bookingService.getById(req.params['id'] as string, {
      role: req.user!.role,
      profileId: req.user!.profileId,
    });

    sendSuccess(res, toView(booking, viewerTimezoneFor(req, booking)));
  },
};

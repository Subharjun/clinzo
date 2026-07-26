import type { Request, Response } from 'express';
import { AvailabilityKind } from '@prisma/client';
import { availabilityService } from '../services/availability.service';
import { formatMinutesToTime } from '../utils/time';
import { clientIp, sendCreated, sendSuccess } from '../utils/http';
import type { SessionContext } from '../services/auth.service';
import type { Availability } from '@prisma/client';

/** `/availability` controllers. */

function sessionContext(req: Request): SessionContext {
  return {
    userId: req.user?.id ?? null,
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}

/**
 * Render an availability for the API.
 *
 * Minutes-from-midnight is the right *storage* representation and the wrong
 * *wire* representation — clients want `"10:00"`. The conversion lives here so
 * the internal form never leaks.
 */
function toView(availability: Availability) {
  return {
    id: availability.id,
    doctorId: availability.doctorId,
    kind: availability.kind,
    date: availability.date ? availability.date.toISOString().slice(0, 10) : null,
    weekday: availability.weekday,
    startTime: formatMinutesToTime(availability.startMinuteOfDay),
    endTime: formatMinutesToTime(availability.endMinuteOfDay),
    timezone: availability.timezone,
    slotDurationMinutes: availability.slotDurationMinutes,
    bufferMinutes: availability.bufferMinutes,
    mode: availability.mode,
    appointmentType: availability.appointmentType,
    effectiveFrom: availability.effectiveFrom
      ? availability.effectiveFrom.toISOString().slice(0, 10)
      : null,
    effectiveUntil: availability.effectiveUntil
      ? availability.effectiveUntil.toISOString().slice(0, 10)
      : null,
    isActive: availability.isActive,
    /** Echoed so the client can send it back on the next update. */
    version: availability.version,
    createdAt: availability.createdAt.toISOString(),
    updatedAt: availability.updatedAt.toISOString(),
  };
}

export const availabilityController = {
  async create(req: Request, res: Response): Promise<void> {
    const body = req.body;

    const result = await availabilityService.create(
      req.user!.profileId as string,
      {
        kind: body.kind as AvailabilityKind,
        date: body.kind === AvailabilityKind.ONE_OFF ? body.date : null,
        weekday: body.kind === AvailabilityKind.RECURRING ? body.weekday : null,
        // The validator already converted "HH:mm" into minutes.
        startMinuteOfDay: body.startTime,
        endMinuteOfDay: body.endTime,
        timezone: body.timezone,
        slotDurationMinutes: body.slotDurationMinutes,
        bufferMinutes: body.bufferMinutes,
        mode: body.mode,
        appointmentType: body.appointmentType,
        effectiveFrom: body.effectiveFrom ?? null,
        effectiveUntil: body.effectiveUntil ?? null,
        horizonDays: body.horizonDays,
      },
      sessionContext(req),
    );

    sendCreated(res, {
      availability: toView(result.availability),
      slotsGenerated: result.slotsGenerated,
      skippedForDaylightSavingGap: result.skippedForDstGap,
    });
  },

  async update(req: Request, res: Response): Promise<void> {
    const body = req.body;

    const result = await availabilityService.update(
      req.params['id'] as string,
      req.user!.profileId as string,
      {
        startMinuteOfDay: body.startTime,
        endMinuteOfDay: body.endTime,
        slotDurationMinutes: body.slotDurationMinutes,
        bufferMinutes: body.bufferMinutes,
        mode: body.mode,
        appointmentType: body.appointmentType,
        effectiveFrom: body.effectiveFrom,
        effectiveUntil: body.effectiveUntil,
        isActive: body.isActive,
        version: body.version,
      },
      sessionContext(req),
    );

    sendSuccess(res, {
      availability: toView(result.availability),
      slotsGenerated: result.slotsGenerated,
      slotsBlocked: result.slotsBlocked,
      // The headline of this response: what the doctor must now resolve by
      // hand. Never empty silently — an empty array is an explicit "nothing
      // was disturbed".
      orphanedBookings: result.orphanedBookings.map((entry) => ({
        bookingId: entry.bookingId,
        slotId: entry.slotId,
        startsAt: entry.startsAt.toISOString(),
      })),
      skippedForDaylightSavingGap: result.skippedForDstGap,
    });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const result = await availabilityService.remove(
      req.params['id'] as string,
      req.user!.profileId as string,
      sessionContext(req),
    );

    sendSuccess(res, {
      deleted: true,
      slotsBlocked: result.slotsBlocked,
      orphanedBookings: result.orphanedBookings.map((entry) => ({
        bookingId: entry.bookingId,
        slotId: entry.slotId,
        startsAt: entry.startsAt.toISOString(),
      })),
    });
  },

  async listMine(req: Request, res: Response): Promise<void> {
    const rows = await availabilityService.listForDoctor(req.user!.profileId as string);
    sendSuccess(res, rows.map(toView));
  },
};

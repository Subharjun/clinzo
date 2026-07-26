import type { Request, Response } from 'express';
import type { SlotStatus } from '@prisma/client';
import { slotService } from '../services/slot.service';
import { sendSuccess } from '../utils/http';
import { toZonedDate, toZonedTime } from '../utils/time';

/** `/doctors/:id/slots` and the doctor's own diary view. */

export const slotController = {
  /**
   * Public slot discovery. Deliberately unauthenticated: a patient comparing
   * doctors before signing up is the normal funnel, and free/busy times are
   * not confidential.
   */
  async listForDoctor(req: Request, res: Response): Promise<void> {
    const { from, to, appointmentType, mode, timezone } = req.query as unknown as {
      from: Date;
      to: Date;
      appointmentType?: string;
      mode?: 'VIDEO' | 'IN_CLINIC';
      timezone?: string;
    };

    const listing = await slotService.listAvailable({
      doctorId: req.params['id'] as string,
      from,
      to,
      appointmentType,
      mode,
      viewerTimezone: timezone,
    });

    sendSuccess(res, listing);
  },

  /** The authenticated doctor's own calendar, including non-bookable slots. */
  async listMine(req: Request, res: Response): Promise<void> {
    const { from, to, status } = req.query as unknown as {
      from: Date;
      to: Date;
      status?: SlotStatus;
    };

    const result = await slotService.listForDoctor(req.user!.profileId as string, from, to, status);

    sendSuccess(
      res,
      result.slots.map((slot) => ({
        id: slot.id,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        status: slot.status,
        durationMinutes: slot.durationMinutes,
        appointmentType: slot.appointmentType,
        mode: slot.mode,
        heldUntil: slot.heldUntil?.toISOString() ?? null,
        blockedReason: slot.blockedReason,
        availabilityId: slot.availabilityId,
        // Rendered in the doctor's own zone, matching the public listing's
        // `local` block. Without this a doctor reads their own diary in UTC.
        local: {
          timezone: result.timezone,
          date: toZonedDate(slot.startsAt, result.timezone),
          startTime: toZonedTime(slot.startsAt, result.timezone),
          endTime: toZonedTime(slot.endsAt, result.timezone),
        },
      })),
      200,
      { counts: result.counts, timezone: result.timezone },
    );
  },
};

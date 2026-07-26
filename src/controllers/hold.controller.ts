import type { Request, Response } from 'express';
import { holdService } from '../services/hold.service';
import { clientIp, sendCreated, sendSuccess } from '../utils/http';
import type { SessionContext } from '../services/auth.service';

/** `/holds` controllers — the checkout reservation window. */

function sessionContext(req: Request): SessionContext {
  return {
    userId: req.user?.id ?? null,
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}

export const holdController = {
  async create(req: Request, res: Response): Promise<void> {
    const hold = await holdService.create(
      {
        slotId: req.body.slotId,
        patientId: req.user!.profileId as string,
        checkoutReference: req.body.checkoutReference,
      },
      sessionContext(req),
    );

    sendCreated(res, {
      id: hold.id,
      slotId: hold.slotId,
      status: hold.status,
      expiresAt: hold.expiresAt.toISOString(),
      // The client renders a countdown from this rather than computing a
      // difference against its own clock, which may be skewed.
      ttlSeconds: hold.ttlSeconds,
    });
  },

  async release(req: Request, res: Response): Promise<void> {
    await holdService.release(
      req.params['id'] as string,
      req.user!.profileId as string,
      sessionContext(req),
    );
    sendSuccess(res, { released: true });
  },

  async listMine(req: Request, res: Response): Promise<void> {
    const holds = await holdService.findActiveForPatient(req.user!.profileId as string);

    sendSuccess(
      res,
      holds.map((hold) => ({
        id: hold.id,
        slotId: hold.slotId,
        status: hold.status,
        expiresAt: hold.expiresAt.toISOString(),
        ttlSeconds: hold.ttlSeconds,
      })),
    );
  },
};

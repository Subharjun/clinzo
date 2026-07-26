import type { Request, Response } from 'express';
import { authService, type SessionContext } from '../services/auth.service';
import { sendCreated, sendSuccess, clientIp } from '../utils/http';

/**
 * `/auth` controllers.
 *
 * Controllers do exactly three things: translate HTTP into service arguments,
 * call one service method, and translate the result back into HTTP. No
 * branching on domain state, no database access, no orchestration.
 */

/** Assemble the audit/session metadata every auth call needs. */
function sessionContext(req: Request): SessionContext {
  return {
    userId: req.user?.id ?? null,
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}

export const authController = {
  async registerPatient(req: Request, res: Response): Promise<void> {
    const result = await authService.registerPatient(req.body, sessionContext(req));
    sendCreated(res, result);
  },

  async registerDoctor(req: Request, res: Response): Promise<void> {
    const result = await authService.registerDoctor(req.body, sessionContext(req));
    sendCreated(res, result);
  },

  async login(req: Request, res: Response): Promise<void> {
    const { email, password } = req.body;
    const result = await authService.login(email, password, sessionContext(req));
    sendSuccess(res, result);
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const result = await authService.refresh(req.body.refreshToken, sessionContext(req));
    sendSuccess(res, result);
  },

  async logout(req: Request, res: Response): Promise<void> {
    await authService.logout(req.body.refreshToken, sessionContext(req));
    // 200 with an explicit body rather than 204: clients commonly branch on a
    // JSON envelope, and an empty body forces a special case.
    sendSuccess(res, { loggedOut: true });
  },

  async logoutAll(req: Request, res: Response): Promise<void> {
    const revoked = await authService.logoutAll(req.user!.id);
    sendSuccess(res, { revokedSessions: revoked });
  },
};

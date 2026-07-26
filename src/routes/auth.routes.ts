import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { authLimiter } from '../middlewares/rate-limit.middleware';
import { asyncHandler } from '../utils/http';
import {
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerDoctorSchema,
  registerPatientSchema,
} from '../validators/auth.validator';

/**
 * `/auth` routes.
 *
 * Every credential-accepting endpoint sits behind `authLimiter`. Registration
 * is included: without it, the endpoint is a free way to enumerate which email
 * addresses already exist via the 409 response.
 */
export const authRouter = Router();

authRouter.post(
  '/register/patient',
  authLimiter,
  validate({ body: registerPatientSchema }),
  asyncHandler(authController.registerPatient),
);

authRouter.post(
  '/register/doctor',
  authLimiter,
  validate({ body: registerDoctorSchema }),
  asyncHandler(authController.registerDoctor),
);

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(authController.login),
);

authRouter.post(
  '/refresh',
  authLimiter,
  validate({ body: refreshSchema }),
  asyncHandler(authController.refresh),
);

authRouter.post('/logout', validate({ body: logoutSchema }), asyncHandler(authController.logout));

authRouter.post('/logout-all', authenticate, asyncHandler(authController.logoutAll));

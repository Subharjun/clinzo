import type { Request, Response } from 'express';
import { doctorRepository } from '../repositories/doctor.repository';
import { patientRepository } from '../repositories/patient.repository';
import { waitlistService } from '../services/waitlist.service';
import { NotFoundError } from '../utils/errors';
import { clientIp, paginate, sendCreated, sendSuccess } from '../utils/http';
import type { SessionContext } from '../services/auth.service';

/** `/doctors`, `/patients` and `/waitlist` controllers. */

function sessionContext(req: Request): SessionContext {
  return {
    userId: req.user?.id ?? null,
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}

export const doctorController = {
  /** Public directory. */
  async list(req: Request, res: Response): Promise<void> {
    const { page, limit, specialization, search, acceptingPatientsOnly } = req.query as unknown as {
      page: number;
      limit: number;
      specialization?: string;
      search?: string;
      acceptingPatientsOnly?: boolean;
    };

    const { rows, total } = await doctorRepository.list(
      { specialization, search, acceptingPatientsOnly },
      { page, limit },
    );

    const result = paginate(
      rows.map((doctor) => ({
        id: doctor.id,
        fullName: doctor.user.fullName,
        specialization: doctor.specialization,
        bio: doctor.bio,
        timezone: doctor.timezone,
        consultationFeeCents: doctor.consultationFeeCents,
        currency: doctor.currency,
        isAcceptingPatients: doctor.isAcceptingPatients,
        defaultSlotDurationMinutes: doctor.defaultSlotDurationMinutes,
      })),
      total,
      { page, limit },
    );

    sendSuccess(res, result.data, 200, { pagination: result.pagination });
  },

  async getById(req: Request, res: Response): Promise<void> {
    const doctor = await doctorRepository.findById(req.params['id'] as string);
    if (!doctor) throw new NotFoundError('Doctor');

    sendSuccess(res, {
      id: doctor.id,
      fullName: doctor.user.fullName,
      specialization: doctor.specialization,
      bio: doctor.bio,
      timezone: doctor.timezone,
      consultationFeeCents: doctor.consultationFeeCents,
      currency: doctor.currency,
      isAcceptingPatients: doctor.isAcceptingPatients,
      defaultSlotDurationMinutes: doctor.defaultSlotDurationMinutes,
      defaultBufferMinutes: doctor.defaultBufferMinutes,
    });
  },

  /** The authenticated doctor's own profile — includes contact details. */
  async getMe(req: Request, res: Response): Promise<void> {
    const doctor = await doctorRepository.findByUserId(req.user!.id);
    if (!doctor) throw new NotFoundError('Doctor profile');

    sendSuccess(res, {
      id: doctor.id,
      userId: doctor.userId,
      fullName: doctor.user.fullName,
      email: doctor.user.email,
      phone: doctor.user.phone,
      specialization: doctor.specialization,
      registrationNo: doctor.registrationNo,
      bio: doctor.bio,
      timezone: doctor.timezone,
      consultationFeeCents: doctor.consultationFeeCents,
      currency: doctor.currency,
      isAcceptingPatients: doctor.isAcceptingPatients,
      defaultSlotDurationMinutes: doctor.defaultSlotDurationMinutes,
      defaultBufferMinutes: doctor.defaultBufferMinutes,
    });
  },
};

export const patientController = {
  async getMe(req: Request, res: Response): Promise<void> {
    const patient = await patientRepository.findByUserId(req.user!.id);
    if (!patient) throw new NotFoundError('Patient profile');

    sendSuccess(res, {
      id: patient.id,
      userId: patient.userId,
      fullName: patient.user.fullName,
      email: patient.user.email,
      phone: patient.user.phone,
      timezone: patient.timezone,
      dateOfBirth: patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: patient.gender,
    });
  },
};

export const waitlistController = {
  async join(req: Request, res: Response): Promise<void> {
    const entry = await waitlistService.join(
      {
        doctorId: req.body.doctorId,
        patientId: req.user!.profileId as string,
        windowStart: req.body.windowStart,
        windowEnd: req.body.windowEnd,
        appointmentType: req.body.appointmentType,
      },
      sessionContext(req),
    );

    sendCreated(res, {
      id: entry.id,
      doctorId: entry.doctorId,
      windowStart: entry.windowStart.toISOString(),
      windowEnd: entry.windowEnd.toISOString(),
      appointmentType: entry.appointmentType,
      status: entry.status,
    });
  },

  async listMine(req: Request, res: Response): Promise<void> {
    const entries = await waitlistService.listForPatient(req.user!.profileId as string);

    sendSuccess(
      res,
      entries.map((entry) => ({
        id: entry.id,
        doctorId: entry.doctorId,
        windowStart: entry.windowStart.toISOString(),
        windowEnd: entry.windowEnd.toISOString(),
        appointmentType: entry.appointmentType,
        status: entry.status,
        notifiedAt: entry.notifiedAt?.toISOString() ?? null,
      })),
    );
  },

  async cancel(req: Request, res: Response): Promise<void> {
    await waitlistService.cancel(
      req.params['id'] as string,
      req.user!.profileId as string,
      sessionContext(req),
    );
    sendSuccess(res, { cancelled: true });
  },
};

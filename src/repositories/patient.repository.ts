import { Prisma, type Patient, type User } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';

/** Persistence for patients. */

export type PatientWithUser = Patient & {
  user: Pick<User, 'id' | 'fullName' | 'email' | 'timezone' | 'phone'>;
};

const withUser = {
  user: { select: { id: true, fullName: true, email: true, timezone: true, phone: true } },
} satisfies Prisma.PatientInclude;

export class PatientRepository {
  async findById(id: string, executor: PrismaExecutor = prisma): Promise<PatientWithUser | null> {
    return executor.patient.findFirst({
      where: { id, deletedAt: null },
      include: withUser,
    }) as Promise<PatientWithUser | null>;
  }

  async findByUserId(
    userId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<PatientWithUser | null> {
    return executor.patient.findFirst({
      where: { userId, deletedAt: null },
      include: withUser,
    }) as Promise<PatientWithUser | null>;
  }

  async update(
    id: string,
    data: Prisma.PatientUpdateInput,
    executor: PrismaExecutor = prisma,
  ): Promise<Patient> {
    return executor.patient.update({ where: { id }, data });
  }
}

export const patientRepository = new PatientRepository();

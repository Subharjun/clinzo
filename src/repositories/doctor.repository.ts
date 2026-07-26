import { Prisma, type Doctor, type User } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';
import type { PaginationParams } from '../types';

/**
 * Persistence for doctors.
 *
 * The public directory (`GET /doctors`) is a read-heavy, unauthenticated
 * endpoint, so it selects an explicit column list rather than the whole row —
 * this both keeps the payload small and makes it structurally impossible to
 * leak a field added to the model later.
 */

export type DoctorWithUser = Doctor & {
  user: Pick<User, 'id' | 'fullName' | 'email' | 'timezone' | 'phone'>;
};

const withUser = {
  user: { select: { id: true, fullName: true, email: true, timezone: true, phone: true } },
} satisfies Prisma.DoctorInclude;

export interface DoctorSearchFilters {
  specialization?: string;
  acceptingPatientsOnly?: boolean;
  search?: string;
}

export class DoctorRepository {
  async findById(id: string, executor: PrismaExecutor = prisma): Promise<DoctorWithUser | null> {
    return executor.doctor.findFirst({
      where: { id, deletedAt: null },
      include: withUser,
    }) as Promise<DoctorWithUser | null>;
  }

  async findByUserId(
    userId: string,
    executor: PrismaExecutor = prisma,
  ): Promise<DoctorWithUser | null> {
    return executor.doctor.findFirst({
      where: { userId, deletedAt: null },
      include: withUser,
    }) as Promise<DoctorWithUser | null>;
  }

  async list(
    filters: DoctorSearchFilters,
    pagination: PaginationParams,
    executor: PrismaExecutor = prisma,
  ): Promise<{ rows: DoctorWithUser[]; total: number }> {
    const where: Prisma.DoctorWhereInput = {
      deletedAt: null,
      ...(filters.specialization
        ? { specialization: { equals: filters.specialization, mode: 'insensitive' } }
        : {}),
      ...(filters.acceptingPatientsOnly ? { isAcceptingPatients: true } : {}),
      ...(filters.search
        ? {
            OR: [
              { specialization: { contains: filters.search, mode: 'insensitive' } },
              { user: { fullName: { contains: filters.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      executor.doctor.findMany({
        where,
        include: withUser,
        orderBy: { createdAt: 'desc' },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      executor.doctor.count({ where }),
    ]);

    return { rows: rows as DoctorWithUser[], total };
  }

  async update(
    id: string,
    data: Prisma.DoctorUpdateInput,
    executor: PrismaExecutor = prisma,
  ): Promise<Doctor> {
    return executor.doctor.update({ where: { id }, data });
  }
}

export const doctorRepository = new DoctorRepository();

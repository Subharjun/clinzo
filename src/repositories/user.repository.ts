import type { Doctor, Patient, Prisma, Role, User } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';

/**
 * Persistence for identity.
 *
 * Every repository method takes an optional executor so the same code runs
 * inside or outside a transaction. This is what lets a service compose several
 * repository calls atomically without repositories knowing about transactions.
 *
 * Soft-deleted users are invisible here — filtering lives in the repository so
 * no caller can forget it.
 */

export type UserWithProfiles = User & {
  doctor: Doctor | null;
  patient: Patient | null;
};

const withProfiles = {
  doctor: true,
  patient: true,
} satisfies Prisma.UserInclude;

export class UserRepository {
  /** Email is stored lower-cased; normalise on the way in so lookups match. */
  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async findByEmail(
    email: string,
    executor: PrismaExecutor = prisma,
  ): Promise<UserWithProfiles | null> {
    return executor.user.findFirst({
      where: { email: UserRepository.normaliseEmail(email), deletedAt: null },
      include: withProfiles,
    });
  }

  async findById(id: string, executor: PrismaExecutor = prisma): Promise<UserWithProfiles | null> {
    return executor.user.findFirst({
      where: { id, deletedAt: null },
      include: withProfiles,
    });
  }

  async existsByEmail(email: string, executor: PrismaExecutor = prisma): Promise<boolean> {
    const found = await executor.user.findFirst({
      where: { email: UserRepository.normaliseEmail(email), deletedAt: null },
      select: { id: true },
    });
    return found !== null;
  }

  async create(
    data: {
      email: string;
      passwordHash: string;
      role: Role;
      fullName: string;
      phone?: string | null;
      timezone?: string;
    },
    executor: PrismaExecutor = prisma,
  ): Promise<User> {
    return executor.user.create({
      data: {
        ...data,
        email: UserRepository.normaliseEmail(data.email),
      },
    });
  }

  async recordLogin(id: string, executor: PrismaExecutor = prisma): Promise<void> {
    await executor.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  async updatePassword(
    id: string,
    passwordHash: string,
    executor: PrismaExecutor = prisma,
  ): Promise<void> {
    await executor.user.update({ where: { id }, data: { passwordHash } });
  }

  /** Soft delete — preserves the audit trail and any historical bookings. */
  async softDelete(id: string, executor: PrismaExecutor = prisma): Promise<void> {
    await executor.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}

export const userRepository = new UserRepository();

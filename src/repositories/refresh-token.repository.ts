import type { RefreshToken } from '@prisma/client';
import { prisma, type PrismaExecutor } from '../config/prisma';

/**
 * Persistence for refresh tokens.
 *
 * Only the SHA-256 hash is stored. A database dump therefore yields nothing an
 * attacker can present to `/auth/refresh` — the same reasoning that applies to
 * password storage applies to long-lived bearer credentials.
 */
export class RefreshTokenRepository {
  async create(
    data: {
      userId: string;
      tokenHash: string;
      familyId: string;
      expiresAt: Date;
      userAgent?: string | null;
      ipAddress?: string | null;
    },
    executor: PrismaExecutor = prisma,
  ): Promise<RefreshToken> {
    return executor.refreshToken.create({ data });
  }

  async findByHash(
    tokenHash: string,
    executor: PrismaExecutor = prisma,
  ): Promise<RefreshToken | null> {
    return executor.refreshToken.findUnique({ where: { tokenHash } });
  }

  /**
   * Mark a token as rotated out, pointing at its successor.
   * The `revokedAt IS NULL` guard makes rotation idempotent-safe: a second
   * concurrent refresh with the same token updates zero rows, which the
   * service reads as replay.
   */
  async rotate(
    tokenHash: string,
    replacedById: string,
    executor: PrismaExecutor = prisma,
  ): Promise<number> {
    const result = await executor.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), replacedById },
    });
    return result.count;
  }

  async revoke(tokenHash: string, executor: PrismaExecutor = prisma): Promise<number> {
    const result = await executor.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Revoke an entire rotation family.
   *
   * Called when an already-rotated token is presented again — the signature
   * of a stolen token being replayed. Since we cannot tell the thief from the
   * legitimate user, both are logged out and forced to re-authenticate.
   */
  async revokeFamily(familyId: string, executor: PrismaExecutor = prisma): Promise<number> {
    const result = await executor.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Log out every session for a user. */
  async revokeAllForUser(userId: string, executor: PrismaExecutor = prisma): Promise<number> {
    const result = await executor.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Delete expired rows. Revoked-but-unexpired rows are retained: they are
   * what makes reuse detection possible until the token would have expired
   * anyway.
   */
  async deleteExpired(
    before: Date = new Date(),
    executor: PrismaExecutor = prisma,
  ): Promise<number> {
    const result = await executor.refreshToken.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return result.count;
  }
}

export const refreshTokenRepository = new RefreshTokenRepository();

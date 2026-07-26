import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Role, type User } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { hashPassword, hashToken, verifyPassword } from '../utils/crypto';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../utils/errors';
import { assertValidTimezone } from '../utils/time';
import { logger } from '../utils/logger';
import { userRepository, type UserWithProfiles } from '../repositories/user.repository';
import { refreshTokenRepository } from '../repositories/refresh-token.repository';
import { AuditAction, auditLogRepository } from '../repositories/audit-log.repository';
import { tokenService, type TokenPair } from './token.service';

/**
 * Authentication, registration and session lifecycle.
 *
 * The security-relevant decisions concentrated here:
 *
 *  - Login failures are indistinguishable between "no such user" and "wrong
 *    password", including in timing: a dummy hash comparison runs on the
 *    unknown-user path so the response time does not enumerate accounts.
 *
 *  - Refresh tokens rotate on every use. Presenting an already-rotated token
 *    is treated as theft and revokes the whole family.
 *
 *  - Registration creates the User and its role profile in one transaction, so
 *    a crash cannot leave a doctor account with no doctor record.
 */

export interface RegisterPatientInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  timezone?: string;
  dateOfBirth?: string;
  gender?: string;
}

export interface RegisterDoctorInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  timezone: string;
  specialization: string;
  registrationNo: string;
  bio?: string;
  consultationFeeCents?: number;
  defaultSlotDurationMinutes?: number;
  defaultBufferMinutes?: number;
}

/**
 * Ambient request metadata threaded into services for audit purposes.
 * Passed explicitly rather than read from async-local storage so that every
 * service signature states its dependency on request context.
 */
export interface SessionContext {
  /** Acting user id, when the call is made on behalf of an authenticated user. */
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuthResult {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: Role;
    timezone: string;
    profileId: string | null;
  };
  tokens: TokenPair;
}

/**
 * A genuine bcrypt hash of an unguessable random string, compared against on
 * the unknown-account path so that path costs the same as a real verification.
 *
 * Generated at module load rather than hardcoded: a literal could be copied
 * from a tutorial with the wrong cost factor, which would make the decoy
 * comparison measurably faster than the real one and reintroduce exactly the
 * timing oracle it exists to close.
 */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), env.BCRYPT_ROUNDS);

export class AuthService {
  async registerPatient(input: RegisterPatientInput, context: SessionContext): Promise<AuthResult> {
    const timezone = input.timezone ?? 'UTC';
    assertValidTimezone(timezone);

    if (await userRepository.existsByEmail(input.email)) {
      throw new ConflictError('An account with this email already exists', { field: 'email' });
    }

    const passwordHash = await hashPassword(input.password);

    const { user, patientId } = await prisma.$transaction(async (tx) => {
      const created = await userRepository.create(
        {
          email: input.email,
          passwordHash,
          role: Role.PATIENT,
          fullName: input.fullName,
          phone: input.phone ?? null,
          timezone,
        },
        tx,
      );

      const patient = await tx.patient.create({
        data: {
          userId: created.id,
          timezone,
          dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
          gender: input.gender ?? null,
        },
      });

      await auditLogRepository.record(
        {
          actorId: created.id,
          actorRole: Role.PATIENT,
          action: AuditAction.USER_REGISTERED,
          entityType: 'User',
          entityId: created.id,
          metadata: { role: Role.PATIENT },
          requestId: context.requestId ?? null,
          ipAddress: context.ipAddress ?? null,
        },
        tx,
      );

      return { user: created, patientId: patient.id };
    });

    return this.issueSession(user, patientId, context);
  }

  async registerDoctor(input: RegisterDoctorInput, context: SessionContext): Promise<AuthResult> {
    assertValidTimezone(input.timezone);

    if (await userRepository.existsByEmail(input.email)) {
      throw new ConflictError('An account with this email already exists', { field: 'email' });
    }

    const passwordHash = await hashPassword(input.password);

    const { user, doctorId } = await prisma.$transaction(async (tx) => {
      const created = await userRepository.create(
        {
          email: input.email,
          passwordHash,
          role: Role.DOCTOR,
          fullName: input.fullName,
          phone: input.phone ?? null,
          timezone: input.timezone,
        },
        tx,
      );

      const doctor = await tx.doctor.create({
        data: {
          userId: created.id,
          specialization: input.specialization,
          registrationNo: input.registrationNo,
          bio: input.bio ?? null,
          timezone: input.timezone,
          consultationFeeCents: input.consultationFeeCents ?? 0,
          defaultSlotDurationMinutes: input.defaultSlotDurationMinutes ?? 15,
          defaultBufferMinutes: input.defaultBufferMinutes ?? 0,
        },
      });

      await auditLogRepository.record(
        {
          actorId: created.id,
          actorRole: Role.DOCTOR,
          action: AuditAction.USER_REGISTERED,
          entityType: 'User',
          entityId: created.id,
          metadata: { role: Role.DOCTOR, specialization: input.specialization },
          requestId: context.requestId ?? null,
          ipAddress: context.ipAddress ?? null,
        },
        tx,
      );

      return { user: created, doctorId: doctor.id };
    });

    return this.issueSession(user, doctorId, context);
  }

  async login(email: string, password: string, context: SessionContext): Promise<AuthResult> {
    const user = await userRepository.findByEmail(email);

    // Always run a comparison, even with no user, so response timing does not
    // reveal whether the address is registered.
    const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !passwordMatches) {
      auditLogRepository.recordDetached({
        action: AuditAction.USER_LOGIN_FAILED,
        entityType: 'User',
        entityId: user?.id ?? null,
        metadata: {
          email: normaliseEmailForAudit(email),
          reason: user ? 'bad_password' : 'no_account',
        },
        requestId: context.requestId ?? null,
        ipAddress: context.ipAddress ?? null,
      });
      throw new UnauthorizedError('Invalid email or password');
    }

    if (!user.isActive) {
      throw new ForbiddenError('This account has been deactivated');
    }

    await userRepository.recordLogin(user.id);

    auditLogRepository.recordDetached({
      actorId: user.id,
      actorRole: user.role,
      action: AuditAction.USER_LOGIN_SUCCEEDED,
      entityType: 'User',
      entityId: user.id,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    return this.issueSession(user, profileIdOf(user), context);
  }

  /**
   * Rotate a refresh token.
   *
   * The reuse-detection branch is the important one: a token that verifies
   * cryptographically but is already revoked means either a replay attack or a
   * stolen token. We cannot distinguish the attacker from the victim, so the
   * only safe action is to invalidate every token in the family.
   */
  async refresh(refreshToken: string, context: SessionContext): Promise<AuthResult> {
    const payload = tokenService.verifyRefreshToken(refreshToken);
    const tokenHash = hashToken(refreshToken);

    const stored = await refreshTokenRepository.findByHash(tokenHash);

    if (!stored) {
      // Signature valid but no record: the token was already pruned, or the
      // database was restored from a backup. Either way, re-authenticate.
      throw new UnauthorizedError('Refresh token is no longer valid', { reason: 'unknown_token' });
    }

    // The signed subject and the stored owner must agree. A mismatch would
    // mean a token signed by us for one user is indexed against another —
    // impossible without a bug, and worth failing closed on.
    if (stored.userId !== payload.sub) {
      await refreshTokenRepository.revokeFamily(stored.familyId);
      throw new UnauthorizedError('Refresh token subject mismatch', { reason: 'subject_mismatch' });
    }

    if (stored.revokedAt) {
      await refreshTokenRepository.revokeFamily(stored.familyId);

      auditLogRepository.recordDetached({
        actorId: stored.userId,
        action: AuditAction.TOKEN_REUSE_DETECTED,
        entityType: 'RefreshToken',
        entityId: stored.id,
        metadata: { familyId: stored.familyId },
        requestId: context.requestId ?? null,
        ipAddress: context.ipAddress ?? null,
      });
      logger.warn(
        { userId: stored.userId, familyId: stored.familyId },
        'refresh token reuse detected; family revoked',
      );

      throw new UnauthorizedError('Refresh token has been revoked; please sign in again', {
        reason: 'token_reuse_detected',
      });
    }

    if (stored.expiresAt <= new Date()) {
      throw new UnauthorizedError('Refresh token has expired', { reason: 'token_expired' });
    }

    const user = await userRepository.findById(stored.userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedError('Account is no longer active');
    }

    // Issue the successor first so the rotation record can point at it.
    const issued = tokenService.signRefreshToken({
      userId: user.id,
      familyId: stored.familyId,
    });
    const newHash = hashToken(issued.token);

    const rotated = await prisma.$transaction(async (tx) => {
      const created = await refreshTokenRepository.create(
        {
          userId: user.id,
          tokenHash: newHash,
          familyId: issued.familyId,
          expiresAt: issued.expiresAt,
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
        },
        tx,
      );

      // Guarded by `revokedAt IS NULL`: if a concurrent refresh already
      // rotated this token, zero rows change and we abort rather than hand out
      // two live successors for one predecessor.
      const count = await refreshTokenRepository.rotate(tokenHash, created.id, tx);
      if (count === 0) {
        throw new UnauthorizedError('Refresh token was rotated concurrently', {
          reason: 'concurrent_rotation',
        });
      }

      return created;
    });

    auditLogRepository.recordDetached({
      actorId: user.id,
      actorRole: user.role,
      action: AuditAction.TOKEN_REFRESHED,
      entityType: 'RefreshToken',
      entityId: rotated.id,
      requestId: context.requestId ?? null,
    });

    const accessToken = tokenService.signAccessToken({
      userId: user.id,
      role: user.role,
      profileId: profileIdOf(user),
    });

    return {
      user: toPublicUser(user, profileIdOf(user)),
      tokens: {
        accessToken,
        refreshToken: issued.token,
        expiresIn: tokenService.accessTokenTtlSeconds,
        tokenType: 'Bearer',
      },
    };
  }

  /** Revoke a single session. Idempotent: an unknown token is a no-op. */
  async logout(refreshToken: string, context: SessionContext): Promise<void> {
    let userId: string | null = null;

    try {
      const payload = tokenService.verifyRefreshToken(refreshToken);
      userId = payload.sub;
    } catch {
      // An expired or malformed token is already unusable — logging out is
      // still a success from the client's point of view.
      return;
    }

    await refreshTokenRepository.revoke(hashToken(refreshToken));

    auditLogRepository.recordDetached({
      actorId: userId,
      action: AuditAction.USER_LOGGED_OUT,
      entityType: 'User',
      entityId: userId,
      requestId: context.requestId ?? null,
    });
  }

  /** Revoke every session for a user (password change, "sign out everywhere"). */
  async logoutAll(userId: string): Promise<number> {
    return refreshTokenRepository.revokeAllForUser(userId);
  }

  private async issueSession(
    user: User,
    profileId: string | null,
    context: SessionContext,
  ): Promise<AuthResult> {
    const accessToken = tokenService.signAccessToken({
      userId: user.id,
      role: user.role,
      profileId,
    });

    const issued = tokenService.signRefreshToken({ userId: user.id });

    await refreshTokenRepository.create({
      userId: user.id,
      tokenHash: hashToken(issued.token),
      familyId: issued.familyId,
      expiresAt: issued.expiresAt,
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
    });

    return {
      user: toPublicUser(user, profileId),
      tokens: {
        accessToken,
        refreshToken: issued.token,
        expiresIn: tokenService.accessTokenTtlSeconds,
        tokenType: 'Bearer',
      },
    };
  }
}

/** The role-specific profile id embedded in the access token. */
function profileIdOf(user: UserWithProfiles | User): string | null {
  const withProfiles = user as UserWithProfiles;
  if (withProfiles.doctor) return withProfiles.doctor.id;
  if (withProfiles.patient) return withProfiles.patient.id;
  return null;
}

function toPublicUser(user: User, profileId: string | null): AuthResult['user'] {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    timezone: user.timezone,
    profileId,
  };
}

/** Lower-cased email for audit metadata, matching how it is stored. */
function normaliseEmailForAudit(email: string): string {
  return email.trim().toLowerCase();
}

export const authService = new AuthService();

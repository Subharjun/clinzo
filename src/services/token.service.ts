import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errors';
import { generateUuid } from '../utils/crypto';
import type { AccessTokenPayload, RefreshTokenPayload } from '../types';

/**
 * JWT issuance and verification.
 *
 * Access and refresh tokens are signed with *different* secrets and carry a
 * `typ` discriminator. Either mechanism alone would prevent cross-use; both
 * are present because token confusion is a high-consequence, low-cost class of
 * bug to eliminate.
 *
 * Access tokens are short-lived (15m) and stateless — no database read on the
 * hot path. Refresh tokens are long-lived and *stateful*: a hash of each one
 * lives in `refresh_tokens`, which is what makes revocation possible at all.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires — clients pre-emptively refresh. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface IssuedRefreshToken {
  token: string;
  jti: string;
  familyId: string;
  expiresAt: Date;
}

/** Convert `"15m"` / `"30d"` into seconds. */
export function durationToSeconds(duration: string): number {
  const match = /^(\d+)([smhdw])$/.exec(duration);
  if (!match) throw new Error(`Invalid duration string: ${duration}`);

  const amount = Number(match[1]);
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
  return amount * (unitSeconds[match[2] as string] as number);
}

export class TokenService {
  private readonly accessTtlSeconds = durationToSeconds(env.JWT_ACCESS_TTL);
  private readonly refreshTtlSeconds = durationToSeconds(env.JWT_REFRESH_TTL);

  signAccessToken(input: { userId: string; role: Role; profileId: string | null }): string {
    const payload: Omit<AccessTokenPayload, 'iat' | 'exp' | 'iss' | 'aud'> = {
      sub: input.userId,
      role: input.role,
      profileId: input.profileId,
      typ: 'access',
    };

    const options: SignOptions = {
      expiresIn: this.accessTtlSeconds,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithm: 'HS256',
    };

    return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
  }

  /**
   * Issue a refresh token. `familyId` threads through a rotation chain: on
   * every refresh a new token joins the same family, so detecting reuse of an
   * already-rotated token lets us revoke the entire family at once.
   */
  signRefreshToken(input: { userId: string; familyId?: string }): IssuedRefreshToken {
    const jti = generateUuid();
    const familyId = input.familyId ?? generateUuid();

    const payload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
      sub: input.userId,
      fid: familyId,
      jti,
      typ: 'refresh',
    };

    const token = jwt.sign(payload, env.JWT_REFRESH_SECRET, {
      expiresIn: this.refreshTtlSeconds,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithm: 'HS256',
    });

    return {
      token,
      jti,
      familyId,
      expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
    };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    const decoded = this.verify<AccessTokenPayload>(token, env.JWT_ACCESS_SECRET);

    if (decoded.typ !== 'access') {
      throw new UnauthorizedError('Expected an access token', { reason: 'wrong_token_type' });
    }
    return decoded;
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    const decoded = this.verify<RefreshTokenPayload>(token, env.JWT_REFRESH_SECRET);

    if (decoded.typ !== 'refresh') {
      throw new UnauthorizedError('Expected a refresh token', { reason: 'wrong_token_type' });
    }
    return decoded;
  }

  get accessTokenTtlSeconds(): number {
    return this.accessTtlSeconds;
  }

  get refreshTokenTtlSeconds(): number {
    return this.refreshTtlSeconds;
  }

  /**
   * Verify a signature and the registered claims.
   *
   * `algorithms` is pinned explicitly: without it, a token declaring
   * `alg: none` (or HS256 signed with a public key) would be accepted — the
   * classic JWT algorithm-confusion attack.
   */
  private verify<T>(token: string, secret: string): T {
    return jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as T;
  }
}

export const tokenService = new TokenService();

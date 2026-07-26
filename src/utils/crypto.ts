import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';

/**
 * Cryptographic primitives.
 *
 * Password hashing uses bcryptjs (pure JS) rather than the native `bcrypt`
 * binding. The algorithm and cost factor are identical; the pure-JS build
 * removes a node-gyp toolchain from every Docker image and CI runner, which
 * in practice is the difference between a reproducible build and a flaky one.
 * If throughput ever makes the ~2x slower JS implementation a bottleneck, the
 * swap is a one-line change confined to this file.
 */

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, env.BCRYPT_ROUNDS);
}

/**
 * Verify a password. bcrypt's own comparison is already constant-time with
 * respect to the hash, so no additional equalisation is needed here.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Hash a refresh token for storage.
 *
 * SHA-256 rather than bcrypt is correct here: the input is 256 bits of
 * cryptographic randomness, not a low-entropy human secret, so there is
 * nothing for a slow KDF to protect against — and refresh happens on the hot
 * path where a 100ms bcrypt round would be a real cost.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** URL-safe, 256-bit opaque token. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generateUuid(): string {
  return randomUUID();
}

/** Canonical hash of a request body, for idempotency-key payload matching. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so that
 * `{a:1,b:2}` and `{b:2,a:1}` hash identically. Without this, a client that
 * reorders its JSON fields would be told its idempotent retry is a conflict.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

/** Constant-time string comparison for secret material. */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on length mismatch, which would itself leak
  // length; compare digests of equal size instead.
  const digestA = createHash('sha256').update(bufferA).digest();
  const digestB = createHash('sha256').update(bufferB).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Human-facing booking reference, e.g. `CLZ-7Q4M2X`.
 * Excludes I, O, 0 and 1 — the characters people misread when reading a code
 * back over the phone to a clinic.
 */
const CONFIRMATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONFIRMATION_LENGTH = 6;

export function generateConfirmationCode(): string {
  const bytes = randomBytes(CONFIRMATION_LENGTH);
  let code = '';
  for (let i = 0; i < CONFIRMATION_LENGTH; i += 1) {
    // `bytes[i]` is defined for i < length; the assertion satisfies
    // noUncheckedIndexedAccess without a runtime branch.
    const byte = bytes[i] as number;
    code += CONFIRMATION_ALPHABET[byte % CONFIRMATION_ALPHABET.length];
  }
  return `CLZ-${code}`;
}

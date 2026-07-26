import {
  generateConfirmationCode,
  hashPassword,
  hashRequestBody,
  hashToken,
  safeCompare,
  stableStringify,
  verifyPassword,
} from '../../src/utils/crypto';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('never stores the plaintext', async () => {
    const password = 'a-very-distinctive-password';
    const hash = await hashPassword(password);

    expect(hash).not.toContain(password);
    expect(hash.startsWith('$2')).toBe(true);
  });

  it('salts, so identical passwords produce different hashes', async () => {
    // Without a per-password salt, a leaked database reveals which accounts
    // share a password.
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);

    await expect(verifyPassword('same-password', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });
});

describe('hashToken', () => {
  it('is deterministic and hides the input', () => {
    const token = 'an-opaque-refresh-token';
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('separates tokens that differ by one character', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });
});

describe('stableStringify', () => {
  it('is insensitive to key order', () => {
    // The property idempotency depends on: a client reordering its JSON must
    // not be told its retry is a conflict.
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('sorts nested objects too', () => {
    expect(stableStringify({ outer: { x: 1, y: 2 }, first: true })).toBe(
      stableStringify({ first: true, outer: { y: 2, x: 1 } }),
    );
  });

  it('preserves array order, which is semantic', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('ignores undefined values, matching JSON semantics', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
  });
});

describe('hashRequestBody', () => {
  it('matches for equivalent bodies and differs for changed ones', () => {
    const body = { slotId: 'abc', reasonForVisit: 'check-up' };

    expect(hashRequestBody(body)).toBe(
      hashRequestBody({ reasonForVisit: 'check-up', slotId: 'abc' }),
    );
    expect(hashRequestBody(body)).not.toBe(hashRequestBody({ ...body, slotId: 'def' }));
  });
});

describe('safeCompare', () => {
  it('compares by value', () => {
    expect(safeCompare('secret', 'secret')).toBe(true);
    expect(safeCompare('secret', 'secreT')).toBe(false);
    // Different lengths must not throw — that would itself leak length.
    expect(safeCompare('short', 'considerably-longer')).toBe(false);
  });
});

describe('generateConfirmationCode', () => {
  it('is prefixed and fixed-length', () => {
    const code = generateConfirmationCode();
    expect(code).toMatch(/^CLZ-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('omits characters people misread over the phone', () => {
    // I/O/0/1 are excluded by design; 2000 samples makes an accidental
    // inclusion overwhelmingly likely to be caught.
    const codes = Array.from({ length: 2000 }, () => generateConfirmationCode());

    for (const code of codes) {
      expect(code.slice(4)).not.toMatch(/[IO01]/);
    }
  });

  it('does not obviously collide', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateConfirmationCode()));
    // 32^6 ≈ 1.07e9 possibilities; a handful of collisions in 2000 draws would
    // indicate a broken generator, not bad luck.
    expect(codes.size).toBeGreaterThan(1995);
  });
});

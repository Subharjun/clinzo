import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import { hashToken } from '../../src/utils/crypto';
import { TEST_PASSWORD, createPatient, resetAll, teardown } from '../helpers/database';

/**
 * Authentication behaviour.
 *
 * The security-relevant assertions here are the ones about what the API
 * *refuses* to reveal, and about refresh-token rotation — the two places where
 * a plausible-looking implementation is usually subtly wrong.
 */

let app: Application;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await teardown();
});

describe('POST /auth/register/patient', () => {
  it('creates a user and its patient profile atomically, and issues tokens', async () => {
    const response = await request(app).post('/api/v1/auth/register/patient').send({
      email: 'New.Patient@Example.com',
      password: 'a-sufficiently-long-password',
      fullName: 'New Patient',
      timezone: 'Asia/Kolkata',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.user.role).toBe('PATIENT');
    expect(response.body.data.tokens.accessToken).toBeTruthy();
    expect(response.body.data.tokens.refreshToken).toBeTruthy();

    // Email is normalised to lower case, which is what makes the plain unique
    // index behave case-insensitively.
    expect(response.body.data.user.email).toBe('new.patient@example.com');

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'new.patient@example.com' },
      include: { patient: true },
    });
    expect(user.patient).not.toBeNull();

    // The profile id in the token is what authorises patient-scoped routes.
    expect(response.body.data.user.profileId).toBe(user.patient!.id);
  });

  it('never returns the password hash', async () => {
    const response = await request(app).post('/api/v1/auth/register/patient').send({
      email: 'leak-check@example.com',
      password: 'a-sufficiently-long-password',
      fullName: 'Leak Check',
    });

    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain('$2a$');
  });

  it('rejects a weak password with a field-level error', async () => {
    const response = await request(app).post('/api/v1/auth/register/patient').send({
      email: 'weak@example.com',
      password: 'short',
      fullName: 'Weak Password',
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'password' })]),
    );
  });

  it('rejects an unknown timezone', async () => {
    const response = await request(app).post('/api/v1/auth/register/patient').send({
      email: 'tz@example.com',
      password: 'a-sufficiently-long-password',
      fullName: 'Bad Timezone',
      timezone: 'Mars/Olympus_Mons',
    });

    expect(response.status).toBe(422);
  });

  it('rejects a duplicate email regardless of casing', async () => {
    await request(app).post('/api/v1/auth/register/patient').send({
      email: 'dup@example.com',
      password: 'a-sufficiently-long-password',
      fullName: 'First',
    });

    const response = await request(app).post('/api/v1/auth/register/patient').send({
      email: 'DUP@EXAMPLE.COM',
      password: 'a-sufficiently-long-password',
      fullName: 'Second',
    });

    expect(response.status).toBe(409);
  });

  it('strips unknown fields rather than trusting them', async () => {
    // Mass-assignment guard: a client must not be able to grant itself ADMIN
    // by adding a field the schema does not declare.
    const response = await request(app).post('/api/v1/auth/register/patient').send({
      email: 'escalate@example.com',
      password: 'a-sufficiently-long-password',
      fullName: 'Escalation Attempt',
      role: 'ADMIN',
      isActive: true,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.user.role).toBe('PATIENT');

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'escalate@example.com' },
    });
    expect(user.role).toBe('PATIENT');
  });
});

describe('POST /auth/login', () => {
  it('authenticates a valid patient', async () => {
    const patient = await createPatient({ email: 'login@example.com' });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'login@example.com', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.user.id).toBe(patient.userId);
    expect(response.body.data.tokens.tokenType).toBe('Bearer');
  });

  it('gives an identical response for a wrong password and an unknown account', async () => {
    // Account enumeration guard. If these differed, an attacker could harvest
    // valid addresses without ever guessing a password.
    await createPatient({ email: 'known@example.com' });

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'known@example.com', password: 'definitely-not-the-password' });

    const unknownAccount = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'definitely-not-the-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownAccount.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
  });

  it('refuses a deactivated account', async () => {
    const patient = await createPatient({ email: 'deactivated@example.com' });
    await prisma.user.update({ where: { id: patient.userId }, data: { isActive: false } });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'deactivated@example.com', password: TEST_PASSWORD });

    expect(response.status).toBe(403);
  });
});

describe('POST /auth/refresh', () => {
  async function loginFixture() {
    const patient = await createPatient({ email: `refresh-${crypto.randomUUID()}@example.com` });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: patient.email, password: TEST_PASSWORD });

    return {
      patient,
      tokens: login.body.data.tokens as { accessToken: string; refreshToken: string },
    };
  }

  it('rotates the refresh token and issues a fresh access token', async () => {
    const { tokens } = await loginFixture();

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    expect(response.status).toBe(200);
    // The old token must not be reissued — that would defeat rotation.
    expect(response.body.data.tokens.refreshToken).not.toBe(tokens.refreshToken);

    const old = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(tokens.refreshToken) },
    });
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedById).not.toBeNull();
  });

  it('revokes the entire family when a rotated token is replayed', async () => {
    // The theft-detection path. We cannot distinguish the thief from the
    // victim, so every session in the family is invalidated.
    const { tokens } = await loginFixture();

    const first = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    expect(replay.status).toBe(401);
    expect(replay.body.error.details.reason).toBe('token_reuse_detected');

    // The successor issued by the legitimate refresh is now dead too.
    const successor = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.data.tokens.refreshToken });
    expect(successor.status).toBe(401);
  });

  it('refuses an access token presented as a refresh token', async () => {
    const { tokens } = await loginFixture();

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.accessToken });

    expect(response.status).toBe(401);
  });

  it('logs out by revoking the presented token', async () => {
    const { tokens } = await loginFixture();

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: tokens.refreshToken });
    expect(logout.status).toBe(200);

    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });
    expect(refresh.status).toBe(401);
  });
});

describe('authorisation', () => {
  it('rejects a request with no token', async () => {
    const response = await request(app).get('/api/v1/bookings/me');
    expect(response.status).toBe(401);
    expect(response.body.error.details.reason).toBe('missing_token');
  });

  it('rejects a malformed token', async () => {
    const response = await request(app)
      .get('/api/v1/bookings/me')
      .set('authorization', 'Bearer not-a-real-jwt');

    expect(response.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    // Guards against accepting a token forged by anyone who knows the payload
    // shape — the failure mode when signature verification is skipped.
    const jwt = await import('jsonwebtoken');
    const forged = jwt.default.sign(
      { sub: crypto.randomUUID(), role: 'ADMIN', profileId: null, typ: 'access' },
      'an-attacker-chosen-secret-of-sufficient-length',
      { issuer: 'clinzo.health', audience: 'clinzo.api', expiresIn: 900 },
    );

    const response = await request(app)
      .get('/api/v1/bookings/me')
      .set('authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
  });

  it('forbids a patient from creating availability', async () => {
    const patient = await createPatient();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: patient.email, password: TEST_PASSWORD });

    const response = await request(app)
      .post('/api/v1/availability')
      .set('authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .send({ kind: 'RECURRING', weekday: 1, startTime: '10:00', endTime: '18:00' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

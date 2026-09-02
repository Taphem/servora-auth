import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveOrCreateUserForGoogleIdentity } from '../../src/auth/googleIdentityService.js';
import { buildTestApp, flushRedis, resetDatabase, type TestApp } from '../helpers/buildTestApp.js';
import { getCookieValue, isInfraAvailable } from './helpers.js';

describe.skipIf(!isInfraAvailable())('register + login + logout + session', () => {
  let testApp: TestApp;

  beforeAll(() => {
    testApp = buildTestApp();
  });

  afterEach(async () => {
    await resetDatabase(testApp.ctx);
    await flushRedis(testApp.ctx);
    testApp.notifications.clear();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('registers a new user, creates a session cookie, and requests email verification', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'alice@example.com', password: 'correct-horse-battery' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.email).toBe('alice@example.com');
    expect(body.emailVerified).toBe(false);
    expect(body.phoneVerified).toBe(false);

    const sessionCookie = getCookieValue(response, testApp.ctx.env.SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeTruthy();

    expect(testApp.notifications.events).toHaveLength(1);
    const event = testApp.notifications.events[0];
    expect(event).toMatchObject({
      type: 'EmailVerificationRequested',
      userId: body.userId,
      email: 'alice@example.com',
    });
    expect(typeof (event as { verificationToken?: unknown }).verificationToken).toBe('string');
    // Matches servora-notification's documented request body exactly — no expiresAt field.
    expect(event).not.toHaveProperty('expiresAt');
  });

  it('registration without a phone stores no phone number on the account (NULL, not a placeholder)', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'no-phone-db-check@example.com', password: 'correct-horse-battery' },
    });
    expect(response.statusCode).toBe(201);

    const row = await testApp.ctx.pool.query('SELECT phone FROM users WHERE id = $1', [response.json().userId]);
    expect(row.rows[0].phone).toBeNull();
  });

  it('accepts an optional phone at registration, stores it, and does not mark it verified', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'with-phone@example.com', password: 'correct-horse-battery', phone: '+917042616288' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    // Response shape is identical to the no-phone case — no phone field leaked back.
    expect(body).toEqual({
      userId: body.userId,
      email: 'with-phone@example.com',
      role: 'CUSTOMER',
      emailVerified: false,
      phoneVerified: false,
    });

    const row = await testApp.ctx.pool.query('SELECT phone, phone_verified_at FROM users WHERE id = $1', [body.userId]);
    expect(row.rows[0].phone).toBe('+917042616288');
    expect(row.rows[0].phone_verified_at).toBeNull();
  });

  it('rejects registration with a malformed phone number rather than storing it as-is', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'bad-phone@example.com', password: 'correct-horse-battery', phone: 'not-a-real-phone' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');

    const row = await testApp.ctx.pool.query('SELECT id FROM users WHERE email = $1', ['bad-phone@example.com']);
    expect(row.rows).toHaveLength(0);
  });

  it('is backwards compatible with a request body containing only email + password', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      // Deliberately no `phone` key at all, not even undefined — proves
      // the field is truly optional, not just nullable.
      payload: { email: 'legacy-client@example.com', password: 'correct-horse-battery' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().phoneVerified).toBe(false);
  });

  it('rejects registration with a password shorter than 10 characters', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'bob@example.com', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a duplicate email registration', async () => {
    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'dup@example.com', password: 'correct-horse-battery' },
    });

    const second = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'dup@example.com', password: 'another-password' },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('never returns a password hash anywhere in the response body', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'noleak@example.com', password: 'correct-horse-battery' },
    });
    expect(JSON.stringify(response.json())).not.toMatch(/passwordHash|argon2/i);
  });

  it('logs in with correct credentials and rejects incorrect ones identically', async () => {
    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'carol@example.com', password: 'correct-horse-battery' },
    });

    const wrongPassword = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'carol@example.com', password: 'wrong-password-here' },
    });
    const nonExistentUser = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody-at-all@example.com', password: 'wrong-password-here' },
    });

    // Same status code and error code whether the account exists or not —
    // no account-enumeration signal in the response shape.
    expect(wrongPassword.statusCode).toBe(401);
    expect(nonExistentUser.statusCode).toBe(401);
    expect(wrongPassword.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(nonExistentUser.json().error.code).toBe('INVALID_CREDENTIALS');

    const correct = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'carol@example.com', password: 'correct-horse-battery' },
    });
    expect(correct.statusCode).toBe(200);
    expect(getCookieValue(correct, testApp.ctx.env.SESSION_COOKIE_NAME)).toBeTruthy();
  });

  it('reports session state via GET /api/v1/auth/session', async () => {
    const registerResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'dave@example.com', password: 'correct-horse-battery' },
    });
    const cookie = getCookieValue(registerResponse, testApp.ctx.env.SESSION_COOKIE_NAME)!;

    const authenticated = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie },
    });
    expect(authenticated.json()).toMatchObject({ authenticated: true, email: 'dave@example.com' });

    const anonymous = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(anonymous.json()).toEqual({ authenticated: false });
  });

  it('logs out and invalidates the session', async () => {
    const registerResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'erin@example.com', password: 'correct-horse-battery' },
    });
    const cookie = getCookieValue(registerResponse, testApp.ctx.env.SESSION_COOKIE_NAME)!;

    const logoutResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie },
    });
    expect(logoutResponse.statusCode).toBe(204);

    const sessionAfterLogout = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie },
    });
    expect(sessionAfterLogout.json()).toEqual({ authenticated: false });
  });

  it('creates a Google-authenticated account with no phone number (account creation is not phone-dependent)', async () => {
    // Exercises the real account-creation logic directly with a fake
    // verified Google identity — no network call to Google needed (the
    // OIDC exchange itself isn't what this test is about; see
    // oauth/googleClient.ts for that). Confirms this task's optional-phone
    // change didn't accidentally make phone.optional() only apply to the
    // password registration path.
    const user = await resolveOrCreateUserForGoogleIdentity(testApp.ctx.pool, {
      subject: 'google-subject-no-phone-test',
      email: 'google-user-no-phone@example.com',
      emailVerified: true,
    });

    expect(user.phone).toBeNull();
    expect(user.phoneVerifiedAt).toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();

    const row = await testApp.ctx.pool.query('SELECT phone FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].phone).toBeNull();
  });
});

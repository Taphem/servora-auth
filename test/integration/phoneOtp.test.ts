import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../../src/config/rateLimits.js';
import type { PhoneOtpRequestedEvent } from '../../src/notifications/events.js';
import { otpChallengeKey } from '../../src/redis/otpChallenge.js';
import { buildTestApp, flushRedis, resetDatabase, type TestApp } from '../helpers/buildTestApp.js';
import { getCookieValue, isInfraAvailable } from './helpers.js';

describe.skipIf(!isInfraAvailable())('phone OTP verification', () => {
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

  /** Phone (if given) is supplied at registration — the OTP request contract no longer accepts one. */
  async function registerAndGetCookie(email: string, phone?: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: phone ? { email, password: 'correct-horse-battery', phone } : { email, password: 'correct-horse-battery' },
    });
    testApp.notifications.clear();
    return getCookieValue(response, testApp.ctx.env.SESSION_COOKIE_NAME)!;
  }

  it('requires an authenticated session to request an OTP', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a request whose body tries to supply a phone number — the account phone is always used instead', async () => {
    const cookie = await registerAndGetCookie('otp-no-client-phone@example.com', '+14155551234');
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie },
      // An attacker-controlled body trying to redirect the OTP to a phone
      // number they don't own. The schema's .strict() must reject this
      // outright rather than silently ignoring the extra field.
      payload: { phone: '+19995550000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    // And no challenge/notification was created for the attacker-supplied number.
    expect(testApp.notifications.events).toHaveLength(0);
  });

  it('returns PHONE_NOT_SET when the account has no phone number at all', async () => {
    const cookie = await registerAndGetCookie('otp-no-phone-on-account@example.com');
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PHONE_NOT_SET');
    expect(testApp.notifications.events).toHaveLength(0);
  });

  it('requests and verifies an OTP for the phone supplied at registration, marking it verified', async () => {
    const cookie = await registerAndGetCookie('phone-user@example.com', '+14155551234');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    const requestResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    expect(requestResponse.statusCode).toBe(200);

    const event = testApp.notifications.events[0] as PhoneOtpRequestedEvent;
    expect(event.type).toBe('PhoneOtpRequested');
    expect(event.phone).toBe('+14155551234');
    expect(event.otp).toMatch(/^\d{6}$/);
    // Matches servora-notification's documented phone-otp request body: expiresInSeconds, not expiresAt.
    expect(event.expiresInSeconds).toBe(testApp.ctx.env.OTP_TTL_SECONDS);
    expect(event).not.toHaveProperty('expiresAt');

    const verifyResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      cookies: cookieHeader,
      payload: { otp: event.otp },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toEqual({ verified: true });

    const session = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: cookieHeader,
    });
    expect(session.json().phoneVerified).toBe(true);
  });

  it('rejects an incorrect OTP and enforces the attempt limit', async () => {
    const cookie = await registerAndGetCookie('otp-attempts@example.com', '+14155559999');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });

    const maxAttempts = testApp.ctx.env.OTP_MAX_ATTEMPTS;
    let lastResponse;
    for (let i = 0; i < maxAttempts; i++) {
      lastResponse = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/phone/otp/verify',
        cookies: cookieHeader,
        payload: { otp: '000000' },
      });
    }

    expect(lastResponse?.statusCode).toBe(429);
    expect(lastResponse?.json().error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('rejects registering a phone number already claimed by another account', async () => {
    // This is now the actual enforcement point for phone ownership: since
    // phone is written to `users` (unverified) at registration itself and
    // `users_phone_unique` is a hard database constraint, two accounts can
    // never simultaneously hold the same phone value — verified or not.
    // The defensive ownership re-check inside phoneOtpRequest.ts/
    // phoneOtpVerify.ts (findUserByPhone / the users_phone_unique catch)
    // is accordingly unreachable through any real flow today; it's kept
    // as defense-in-depth per the task's explicit "preserve the existing
    // uniqueness/security behavior" requirement, in case that registration-
    // time guarantee is ever relaxed by a future change.
    await registerAndGetCookie('dup-phone-first@example.com', '+14155550099');
    const secondResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'dup-phone-second@example.com', password: 'correct-horse-battery', phone: '+14155550099' },
    });
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json().error.code).toBe('PHONE_ALREADY_REGISTERED');
  });

  it('stores the OTP challenge in Redis with a hashed OTP, a TTL, and never the raw OTP', async () => {
    const cookie = await registerAndGetCookie('otp-storage-check@example.com', '+14155552222');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    const requestResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    expect(requestResponse.statusCode).toBe(200);

    const session = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/session', cookies: cookieHeader });
    const resolvedUserId: string = session.json().userId;

    const rawRedisValue = await testApp.ctx.redis.get(otpChallengeKey(resolvedUserId));
    expect(rawRedisValue).toBeTruthy();

    const event = testApp.notifications.events[0] as PhoneOtpRequestedEvent;
    expect(rawRedisValue).not.toContain(event.otp);

    const parsed = JSON.parse(rawRedisValue!);
    expect(parsed).toMatchObject({ phone: '+14155552222', attempts: 0, maxAttempts: testApp.ctx.env.OTP_MAX_ATTEMPTS });
    expect(typeof parsed.otpHash).toBe('string');
    expect(parsed.otpHash).not.toBe(event.otp);

    const ttl = await testApp.ctx.redis.ttl(otpChallengeKey(resolvedUserId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(testApp.ctx.env.OTP_TTL_SECONDS);
  });

  it('rejects verification when no OTP was ever requested', async () => {
    const cookie = await registerAndGetCookie('otp-none-requested@example.com', '+14155553001');
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie },
      payload: { otp: '123456' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('OTP_NOT_REQUESTED');
  });

  it('rejects an expired OTP the same way as one that was never requested', async () => {
    const cookie = await registerAndGetCookie('otp-expired@example.com', '+14155553333');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    const requestResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    expect(requestResponse.statusCode).toBe(200);
    const event = testApp.notifications.events[0] as PhoneOtpRequestedEvent;

    const session = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/session', cookies: cookieHeader });
    const userId: string = session.json().userId;

    // Simulate expiry via Redis TTL rather than waiting out OTP_TTL_SECONDS.
    await testApp.ctx.redis.expire(otpChallengeKey(userId), 0);

    const verifyResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      cookies: cookieHeader,
      payload: { otp: event.otp },
    });
    expect(verifyResponse.statusCode).toBe(400);
    expect(verifyResponse.json().error.code).toBe('OTP_NOT_REQUESTED');
  });

  it('cannot reuse a successfully-verified OTP a second time', async () => {
    const cookie = await registerAndGetCookie('otp-no-reuse@example.com', '+14155554444');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    const event = testApp.notifications.events[0] as PhoneOtpRequestedEvent;

    const first = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      cookies: cookieHeader,
      payload: { otp: event.otp },
    });
    expect(first.statusCode).toBe(200);

    const second = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      cookies: cookieHeader,
      payload: { otp: event.otp },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('OTP_NOT_REQUESTED');
  });

  it('invalidates the challenge once attempts are exhausted — even the correct OTP fails afterward', async () => {
    const cookie = await registerAndGetCookie('otp-exhausted-then-correct@example.com', '+14155555555');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    const event = testApp.notifications.events[0] as PhoneOtpRequestedEvent;

    const maxAttempts = testApp.ctx.env.OTP_MAX_ATTEMPTS;
    for (let i = 0; i < maxAttempts; i++) {
      await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/phone/otp/verify',
        cookies: cookieHeader,
        payload: { otp: '000000' },
      });
    }

    // The challenge is gone now — even the real OTP no longer works.
    const finalAttempt = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      cookies: cookieHeader,
      payload: { otp: event.otp },
    });
    expect(finalAttempt.statusCode).toBe(400);
    expect(finalAttempt.json().error.code).toBe('OTP_NOT_REQUESTED');
  });

  it('enforces the resend cooldown, then allows a resend once it has passed', async () => {
    const cookie = await registerAndGetCookie('otp-cooldown@example.com', '+14155556666');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    const first = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(testApp.notifications.events).toHaveLength(1);

    const immediateResend = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    expect(immediateResend.statusCode).toBe(429);
    expect(testApp.notifications.events).toHaveLength(1);

    // Simulate the cooldown having elapsed rather than sleeping in the test.
    const session = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/session', cookies: cookieHeader });
    const userId: string = session.json().userId;
    await testApp.ctx.redis.del(`cooldown:otp-request:${userId}`);

    const afterCooldown = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    expect(afterCooldown.statusCode).toBe(200);
    expect(testApp.notifications.events).toHaveLength(2);
  });

  it('rate-limits excessive OTP verification attempts by IP', async () => {
    const cookie = await registerAndGetCookie('otp-verify-ratelimit@example.com', '+14155558001');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };
    const limit = RATE_LIMITS.otpVerifyByIp.limit;

    const responses = [];
    for (let i = 0; i < limit + 2; i++) {
      responses.push(
        await testApp.app.inject({
          method: 'POST',
          url: '/api/v1/auth/phone/otp/verify',
          cookies: cookieHeader,
          payload: { otp: '000000' },
        }),
      );
    }

    const rateLimited = responses.filter((r) => r.statusCode === 429 && r.json().error.code === 'RATE_LIMITED');
    expect(rateLimited.length).toBeGreaterThan(0);
  });

  it('does not allow two concurrent requests to both consume the same correct OTP (race safety)', async () => {
    const cookie = await registerAndGetCookie('otp-concurrency@example.com', '+14155557777');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: {},
    });
    const event = testApp.notifications.events[0] as PhoneOtpRequestedEvent;

    const [responseA, responseB] = await Promise.all([
      testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/phone/otp/verify',
        cookies: cookieHeader,
        payload: { otp: event.otp },
      }),
      testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/phone/otp/verify',
        cookies: cookieHeader,
        payload: { otp: event.otp },
      }),
    ]);

    const statusCodes = [responseA.statusCode, responseB.statusCode].sort();
    // Exactly one of the two concurrent submissions succeeds; the other
    // finds the challenge already consumed (OTP_NOT_REQUESTED), never a
    // second 200 — the atomic Lua script in redis/otpChallenge.ts is what
    // guarantees this under real concurrency, not application-level luck.
    expect(statusCodes).toEqual([200, 400]);

    const failed = [responseA, responseB].find((r) => r.statusCode === 400)!;
    expect(failed.json().error.code).toBe('OTP_NOT_REQUESTED');
  });
});

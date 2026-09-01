import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PhoneOtpRequestedEvent } from '../../src/notifications/events.js';
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

  async function registerAndGetCookie(email: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery' },
    });
    testApp.notifications.clear();
    return getCookieValue(response, testApp.ctx.env.SESSION_COOKIE_NAME)!;
  }

  it('requires an authenticated session to request an OTP', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: { phone: '+14155551234' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('requests and verifies an OTP, marking the phone verified', async () => {
    const cookie = await registerAndGetCookie('phone-user@example.com');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    const requestResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: { phone: '+14155551234' },
    });
    expect(requestResponse.statusCode).toBe(200);

    const event = testApp.notifications.events[0] as PhoneOtpRequestedEvent;
    expect(event.type).toBe('PhoneOtpRequested');
    expect(event.otp).toMatch(/^\d{6}$/);

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
    const cookie = await registerAndGetCookie('otp-attempts@example.com');
    const cookieHeader = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookie };

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: cookieHeader,
      payload: { phone: '+14155559999' },
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

  it('rejects claiming a phone number already verified on another account', async () => {
    const cookieA = await registerAndGetCookie('owner-a@example.com');
    const headerA = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookieA };
    await testApp.app.inject({ method: 'POST', url: '/api/v1/auth/phone/otp/request', cookies: headerA, payload: { phone: '+14155550001' } });
    const eventA = testApp.notifications.events.at(-1) as PhoneOtpRequestedEvent;
    await testApp.app.inject({ method: 'POST', url: '/api/v1/auth/phone/otp/verify', cookies: headerA, payload: { otp: eventA.otp } });

    const cookieB = await registerAndGetCookie('owner-b@example.com');
    const headerB = { [testApp.ctx.env.SESSION_COOKIE_NAME]: cookieB };
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      cookies: headerB,
      payload: { phone: '+14155550001' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PHONE_ALREADY_REGISTERED');
  });
});

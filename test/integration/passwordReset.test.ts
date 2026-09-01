import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PasswordResetRequestedEvent } from '../../src/notifications/events.js';
import { buildTestApp, flushRedis, resetDatabase, type TestApp } from '../helpers/buildTestApp.js';
import { getCookieValue, isInfraAvailable } from './helpers.js';

describe.skipIf(!isInfraAvailable())('password reset', () => {
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

  it('gives an identical generic response whether or not the account exists', async () => {
    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'resetme@example.com', password: 'correct-horse-battery' },
    });

    const forExisting = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      payload: { email: 'resetme@example.com' },
    });
    const forMissing = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      payload: { email: 'no-such-account@example.com' },
    });

    expect(forExisting.statusCode).toBe(200);
    expect(forExisting.json()).toEqual(forMissing.json());
  });

  it('resets the password, revokes existing sessions, and accepts the new password on next login', async () => {
    const registerResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'fullflow@example.com', password: 'original-password-1' },
    });
    const oldCookie = getCookieValue(registerResponse, testApp.ctx.env.SESSION_COOKIE_NAME)!;

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      payload: { email: 'fullflow@example.com' },
    });
    const event = testApp.notifications.events.find((e) => e.type === 'PasswordResetRequested') as PasswordResetRequestedEvent;

    const confirmResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/confirm',
      payload: { token: event.resetToken, newPassword: 'brand-new-password-2' },
    });
    expect(confirmResponse.statusCode).toBe(200);

    // Old session must be revoked as part of the reset.
    const oldSessionCheck = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: oldCookie },
    });
    expect(oldSessionCheck.json()).toEqual({ authenticated: false });

    const oldPasswordLogin = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'fullflow@example.com', password: 'original-password-1' },
    });
    expect(oldPasswordLogin.statusCode).toBe(401);

    const newPasswordLogin = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'fullflow@example.com', password: 'brand-new-password-2' },
    });
    expect(newPasswordLogin.statusCode).toBe(200);
  });

  it('rejects reusing a consumed or unknown reset token', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/confirm',
      payload: { token: 'not-a-real-token', newPassword: 'whatever-new-password' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('TOKEN_INVALID');
  });
});

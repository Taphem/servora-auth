import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EmailVerificationRequestedEvent } from '../../src/notifications/events.js';
import { buildTestApp, flushRedis, resetDatabase, type TestApp } from '../helpers/buildTestApp.js';
import { isInfraAvailable } from './helpers.js';

describe.skipIf(!isInfraAvailable())('email verification', () => {
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

  async function register(email: string) {
    return testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery' },
    });
  }

  it('verifies email with the token from the published event and rejects reuse', async () => {
    await register('verify-me@example.com');
    const event = testApp.notifications.events[0] as EmailVerificationRequestedEvent;

    const first = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: event.verificationToken },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ verified: true });

    const login = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'verify-me@example.com', password: 'correct-horse-battery' },
    });
    expect(login.json().emailVerified).toBe(true);

    // Single-use: the same token cannot be replayed.
    const second = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: event.verificationToken },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an unknown or malformed token without leaking details', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: 'not-a-real-token' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'TOKEN_INVALID', message: expect.any(String), requestId: expect.any(String) },
    });
  });

  it('resend gives the same generic response for existing and non-existing accounts', async () => {
    await register('has-account@example.com');

    const forExisting = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/resend',
      payload: { email: 'has-account@example.com' },
    });
    const forMissing = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/resend',
      payload: { email: 'no-such-account@example.com' },
    });

    expect(forExisting.statusCode).toBe(200);
    expect(forMissing.statusCode).toBe(200);
    expect(forExisting.json()).toEqual(forMissing.json());
  });

  it('enforces a resend cooldown', async () => {
    await register('cooldown@example.com');
    testApp.notifications.clear();

    await testApp.app.inject({ method: 'POST', url: '/api/v1/auth/email/resend', payload: { email: 'cooldown@example.com' } });
    expect(testApp.notifications.events).toHaveLength(1);

    await testApp.app.inject({ method: 'POST', url: '/api/v1/auth/email/resend', payload: { email: 'cooldown@example.com' } });
    // Second call within the cooldown window must not publish a second event.
    expect(testApp.notifications.events).toHaveLength(1);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { INTERNAL_SERVICE_KEY_HEADER } from '../../src/plugins/internalAuth.js';
import { buildTestApp, flushRedis, resetDatabase, TEST_INTERNAL_SERVICE_KEY, type TestApp } from '../helpers/buildTestApp.js';
import { getCookieValue, isInfraAvailable } from './helpers.js';

describe.skipIf(!isInfraAvailable())('POST /internal/v1/sessions/verify', () => {
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

  it('rejects a request with no internal service key', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/internal/v1/sessions/verify',
      payload: { sessionToken: 'anything' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INTERNAL_AUTH_FAILED');
  });

  it('rejects a request with the wrong internal service key', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/internal/v1/sessions/verify',
      headers: { [INTERNAL_SERVICE_KEY_HEADER]: 'wrong-key-value-that-is-long-enough' },
      payload: { sessionToken: 'anything' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns valid:false for an unknown session token even with a correct internal key', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/internal/v1/sessions/verify',
      headers: { [INTERNAL_SERVICE_KEY_HEADER]: TEST_INTERNAL_SERVICE_KEY },
      payload: { sessionToken: 'not-a-real-session-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: false });
  });

  it('resolves a real session to userId/role/sessionId, matching the gateway client contract', async () => {
    const registerResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'internal-verify@example.com', password: 'correct-horse-battery' },
    });
    const rawSessionToken = getCookieValue(registerResponse, testApp.ctx.env.SESSION_COOKIE_NAME)!;
    const userId = registerResponse.json().userId;

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/internal/v1/sessions/verify',
      headers: { [INTERNAL_SERVICE_KEY_HEADER]: TEST_INTERNAL_SERVICE_KEY },
      payload: { sessionToken: rawSessionToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ valid: true, userId, role: 'CUSTOMER' });
    expect(typeof body.sessionId).toBe('string');
  });

  it('is not reachable under the public /api/v1 prefix', async () => {
    const response = await testApp.app.inject({ method: 'POST', url: '/api/v1/internal/v1/sessions/verify' });
    expect(response.statusCode).toBe(404);
  });

  it('reflects revocation: a logged-out session is no longer valid', async () => {
    const registerResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'internal-revoke@example.com', password: 'correct-horse-battery' },
    });
    const rawSessionToken = getCookieValue(registerResponse, testApp.ctx.env.SESSION_COOKIE_NAME)!;

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [testApp.ctx.env.SESSION_COOKIE_NAME]: rawSessionToken },
    });

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/internal/v1/sessions/verify',
      headers: { [INTERNAL_SERVICE_KEY_HEADER]: TEST_INTERNAL_SERVICE_KEY },
      payload: { sessionToken: rawSessionToken },
    });
    expect(response.json()).toEqual({ valid: false });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../../src/config/rateLimits.js';
import { buildTestApp, flushRedis, resetDatabase, type TestApp } from '../helpers/buildTestApp.js';
import { isInfraAvailable } from './helpers.js';

describe.skipIf(!isInfraAvailable())('health, readiness, errors, and Google OAuth degrade', () => {
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

  it('GET /health always returns 200', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready returns 503 until explicitly marked ready (server.ts marks it after DB check)', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('returns the standard error envelope for a 404', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/no-such-route' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String), requestId: expect.any(String) },
    });
  });

  it('echoes a well-formed client-supplied request ID', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'client-supplied-id-123' },
    });
    expect(response.headers['x-request-id']).toBe('client-supplied-id-123');
  });

  it('generates a request ID when none is supplied', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('Google OAuth routes degrade honestly to 503 when unconfigured (no credentials in test env)', async () => {
    expect(testApp.ctx.env.googleOAuthConfigured).toBe(false);

    const start = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/google/start' });
    expect(start.statusCode).toBe(503);
    expect(start.json().error.code).toBe('GOOGLE_OAUTH_NOT_CONFIGURED');

    const callback = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=x&state=y' });
    expect(callback.statusCode).toBe(503);
  });

  it('enforces rate limiting on registration', async () => {
    const limit = RATE_LIMITS.registerByIp.limit;
    const responses = [];
    for (let i = 0; i < limit + 2; i++) {
      responses.push(
        await testApp.app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `flood-${i}@example.com`, password: 'correct-horse-battery' },
        }),
      );
    }
    const rateLimited = responses.filter((r) => r.statusCode === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(rateLimited[0]?.json().error.code).toBe('RATE_LIMITED');
  });

  it('never logs or returns raw secrets in a validation error for a bad body', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.json())).not.toContain('not-an-email');
  });
});

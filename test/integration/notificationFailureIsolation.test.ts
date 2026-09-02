import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { HttpNotificationPublisher } from '../../src/notifications/HttpNotificationPublisher.js';
import { createLogger } from '../../src/observability/logger.js';
import { buildTestAppWithPublisher, resetDatabase, flushRedis, type CustomPublisherTestApp } from '../helpers/buildTestApp.js';
import { isInfraAvailable } from './helpers.js';

/**
 * Proves failure isolation at the actual HTTP-endpoint level (register,
 * login) using a *real* HttpNotificationPublisher pointed at a
 * deliberately broken target — not just the publisher-level unit tests in
 * test/unit/httpNotificationPublisher.test.ts, which cover the same
 * non-throwing contract in isolation from any route. Google's routes
 * (googleAuthenticate.ts, googleCallback.ts) call
 * ctx.notificationPublisher.publish(...) the identical way, with no
 * try/catch of their own — the isolation guarantee comes entirely from
 * HttpNotificationPublisher itself never throwing, proven here once and
 * relied on everywhere it's called.
 */

function startServer(behavior: 'hang' | 'error500'): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      if (behavior === 'hang') {
        return; // never responds — exercises the publisher's own timeout
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'simulated notification outage', requestId: 'x' } }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

describe.skipIf(!isInfraAvailable())('authentication succeeds despite notification failures', () => {
  it('registration still succeeds (201, session cookie set) when the notification service is completely unreachable', async () => {
    // Port 1 is (per IANA) a reserved, never-listened-on TCP port — a
    // reliable "connection refused" target without starting anything.
    const publisher = new HttpNotificationPublisher({
      baseUrl: 'http://127.0.0.1:1',
      internalServiceKey: 'irrelevant-for-this-test',
      timeoutMs: 1000,
      logger,
    });
    const testApp: CustomPublisherTestApp = buildTestAppWithPublisher(publisher);
    try {
      await resetDatabase(testApp.ctx);
      await flushRedis(testApp.ctx);

      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'unreachable-notify@example.com', password: 'correct-horse-battery' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.cookies.some((c) => c.name === testApp.ctx.env.SESSION_COOKIE_NAME)).toBe(true);
    } finally {
      await testApp.close();
    }
  });

  it('registration still succeeds when the notification service times out', async () => {
    const server = await startServer('hang');
    const publisher = new HttpNotificationPublisher({
      baseUrl: server.baseUrl,
      internalServiceKey: 'irrelevant-for-this-test',
      timeoutMs: 200, // short on purpose — the request must not block on this
      logger,
    });
    const testApp: CustomPublisherTestApp = buildTestAppWithPublisher(publisher);
    try {
      await resetDatabase(testApp.ctx);
      await flushRedis(testApp.ctx);

      const start = Date.now();
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'timeout-notify@example.com', password: 'correct-horse-battery' },
      });
      const elapsedMs = Date.now() - start;

      expect(response.statusCode).toBe(201);
      // Two notification calls happen for registration (verification +
      // account-created), each capped at 200ms — well under a runaway hang.
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      await testApp.close();
      await server.close();
    }
  });

  it('login still succeeds when the notification service returns 500', async () => {
    const server = await startServer('error500');
    const publisher = new HttpNotificationPublisher({
      baseUrl: server.baseUrl,
      internalServiceKey: 'irrelevant-for-this-test',
      timeoutMs: 2000,
      logger,
    });
    const testApp: CustomPublisherTestApp = buildTestAppWithPublisher(publisher);
    try {
      await resetDatabase(testApp.ctx);
      await flushRedis(testApp.ctx);

      const register = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'notify-500@example.com', password: 'correct-horse-battery' },
      });
      expect(register.statusCode).toBe(201);

      const login = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'notify-500@example.com', password: 'correct-horse-battery' },
      });

      expect(login.statusCode).toBe(200);
      expect(login.cookies.some((c) => c.name === testApp.ctx.env.SESSION_COOKIE_NAME)).toBe(true);
    } finally {
      await testApp.close();
      await server.close();
    }
  });
});

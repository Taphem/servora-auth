import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpNotificationPublisher } from '../../src/notifications/HttpNotificationPublisher.js';
import { INTERNAL_SERVICE_KEY_HEADER } from '../../src/plugins/internalAuth.js';
import type { EmailVerificationRequestedEvent, PhoneOtpRequestedEvent } from '../../src/notifications/events.js';
import { createFakeLogger } from './fakeLogger.js';

const BASE_URL = 'https://servora-notification.onrender.com';
const INTERNAL_KEY = 'test-internal-service-key-at-least-32-chars-long';

const emailEvent: EmailVerificationRequestedEvent = {
  type: 'EmailVerificationRequested',
  requestId: 'req-abc',
  userId: 'user-1',
  email: 'alice@example.com',
  verificationToken: 'super-secret-raw-token',
};

const otpEvent: PhoneOtpRequestedEvent = {
  type: 'PhoneOtpRequested',
  requestId: 'req-def',
  userId: 'user-2',
  phone: '+14155551234',
  otp: '654321',
  expiresInSeconds: 300,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HttpNotificationPublisher', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the correct notification URL for the event type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { accepted: true }));
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await publisher.publish(emailEvent);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://servora-notification.onrender.com/internal/v1/notifications/email-verification');
  });

  it('sends the internal service key header and content-type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { accepted: true }));
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await publisher.publish(emailEvent);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[INTERNAL_SERVICE_KEY_HEADER]).toBe(INTERNAL_KEY);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-request-id']).toBe('req-abc');
  });

  it('sends exactly the documented request payload, nothing more', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { accepted: true }));
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await publisher.publish(otpEvent);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ userId: 'user-2', phone: '+14155551234', otp: '654321', expiresInSeconds: 300 });
  });

  it('logs a warning and does not throw when the notification service rejects the request', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 'INTERNAL_AUTH_FAILED', message: 'nope', requestId: 'x' } }),
    );
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await expect(publisher.publish(emailEvent)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [logArg] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logArg).toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_FAILED', eventType: 'EmailVerificationRequested' });
  });

  it('logs a warning and does not throw when the notification service is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await expect(publisher.publish(emailEvent)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [logArg] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logArg).toMatchObject({ eventType: 'EmailVerificationRequested', requestId: 'req-abc' });
  });

  it('logs a warning (without throwing) on a malformed/unexpected 2xx response body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { somethingElse: true }));
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await expect(publisher.publish(emailEvent)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [logArg, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/unexpected response shape/);
    expect(logArg).toMatchObject({ eventType: 'EmailVerificationRequested' });
  });

  it('logs a warning (without throwing) when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 202 }));
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await expect(publisher.publish(emailEvent)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('never logs the internal service key, the raw token/OTP, or the request body in any call', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const logger = createFakeLogger();
    const publisher = new HttpNotificationPublisher({ baseUrl: BASE_URL, internalServiceKey: INTERNAL_KEY, timeoutMs: 5000, logger });

    await publisher.publish(emailEvent);
    await publisher.publish(otpEvent);

    const allLoggedArgs = [...logger.warn.mock.calls, ...logger.info.mock.calls, ...logger.error.mock.calls]
      .map((call) => JSON.stringify(call))
      .join('\n');

    expect(allLoggedArgs).not.toContain(INTERNAL_KEY);
    expect(allLoggedArgs).not.toContain(emailEvent.verificationToken);
    expect(allLoggedArgs).not.toContain(otpEvent.otp);
  });
});

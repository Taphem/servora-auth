import { INTERNAL_SERVICE_KEY_HEADER } from '../plugins/internalAuth.js';
import type { Logger } from '../observability/logger.js';
import type { NotificationEvent } from './events.js';
import { toNotificationHttpRequest } from './notificationRequest.js';
import type { NotificationPublisher } from './NotificationPublisher.js';

export interface HttpNotificationPublisherOptions {
  baseUrl: string;
  internalServiceKey: string;
  timeoutMs: number;
  logger: Logger;
}

function isAcceptedResponse(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { accepted?: unknown }).accepted === true;
}

/**
 * Calls the CONFIRMED servora-notification internal HTTP contract (see
 * servora-notification/docs/api.md): one of three resource-oriented
 * endpoints under `/internal/v1/notifications/*`, authenticated with
 * `x-servora-internal-key`. This is a real, working integration — Auth
 * generates and persists the hashed token/OTP itself and hands the raw
 * value to this call exactly once; servora-notification does not store,
 * hash, or validate it.
 *
 * Best-effort/fire-and-forget by design: a notification failure never
 * blocks or fails the calling auth flow, because the token/OTP is already
 * durably persisted before this is called (see each call site) — the
 * verification/reset challenge still exists and can still be resent, even
 * if delivery failed. Failures are logged (status/code/event type/request
 * ID only) and swallowed, never thrown.
 */
export class HttpNotificationPublisher implements NotificationPublisher {
  constructor(private readonly options: HttpNotificationPublisherOptions) {}

  async publish(event: NotificationEvent): Promise<void> {
    const { path, body } = toNotificationHttpRequest(event);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_KEY_HEADER]: this.options.internalServiceKey,
          'x-request-id': event.requestId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const responseBody: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const code = typeof responseBody === 'object' && responseBody !== null ? (responseBody as { error?: { code?: unknown } }).error?.code : undefined;
        this.options.logger.warn(
          { statusCode: response.status, code, eventType: event.type, requestId: event.requestId },
          'notification service rejected the request',
        );
        return;
      }

      if (!isAcceptedResponse(responseBody)) {
        this.options.logger.warn(
          { statusCode: response.status, eventType: event.type, requestId: event.requestId },
          'notification service returned an unexpected response shape',
        );
      }
    } catch (error) {
      this.options.logger.warn(
        { err: error, eventType: event.type, requestId: event.requestId },
        'notification service unreachable; event was not delivered',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

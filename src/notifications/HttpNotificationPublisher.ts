import type { Logger } from '../observability/logger.js';
import type { NotificationEvent } from './events.js';
import type { NotificationPublisher } from './NotificationPublisher.js';

export interface HttpNotificationPublisherOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
}

/**
 * Sends the PROPOSED notification event (see events.ts) as a single HTTP
 * POST to a configured servora-notification base URL. This is a real,
 * working integration boundary — not a mock — but the contract itself is
 * unconfirmed: servora-notification doesn't exist yet to validate the
 * shape against, and the documented long-term mechanism is more likely an
 * async RabbitMQ event (per event-architecture.md) than a synchronous
 * HTTP call. Swapping the transport later means implementing a new
 * NotificationPublisher, not changing any calling code.
 */
export class HttpNotificationPublisher implements NotificationPublisher {
  constructor(private readonly options: HttpNotificationPublisherOptions) {}

  async publish(event: NotificationEvent): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(`${this.options.baseUrl}/internal/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.options.logger.warn(
          { statusCode: response.status, eventType: event.type, requestId: event.requestId },
          'notification service rejected event',
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

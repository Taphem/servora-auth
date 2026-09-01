import type { Logger } from '../observability/logger.js';
import type { NotificationEvent } from './events.js';
import type { NotificationPublisher } from './NotificationPublisher.js';

/**
 * Used when NOTIFICATION_SERVICE_URL is unset. Honest degrade, matching the
 * gateway's DOWNSTREAM_NOT_CONFIGURED pattern: the verification/reset
 * challenge is still created and persisted, it simply isn't delivered
 * anywhere. Never logs event contents (which may include a raw token/OTP).
 */
export class NullNotificationPublisher implements NotificationPublisher {
  constructor(private readonly logger: Logger) {}

  async publish(event: NotificationEvent): Promise<void> {
    this.logger.warn(
      { eventType: event.type, requestId: event.requestId },
      'NOTIFICATION_SERVICE_URL is not configured; notification event was not delivered',
    );
  }
}

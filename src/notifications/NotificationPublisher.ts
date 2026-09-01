import type { NotificationEvent } from './events.js';

export interface NotificationPublisher {
  publish(event: NotificationEvent): Promise<void>;
}

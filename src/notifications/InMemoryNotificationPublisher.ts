import type { NotificationEvent } from './events.js';
import type { NotificationPublisher } from './NotificationPublisher.js';

/** Test double: captures published events in memory instead of sending them anywhere. */
export class InMemoryNotificationPublisher implements NotificationPublisher {
  readonly events: NotificationEvent[] = [];

  async publish(event: NotificationEvent): Promise<void> {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
  }
}

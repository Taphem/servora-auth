import type { Env } from '../config/env.js';
import type { DbPool } from '../db/pool.js';
import type { Logger } from '../observability/logger.js';
import type { NotificationPublisher } from '../notifications/NotificationPublisher.js';
import type { RedisClient } from '../redis/client.js';

export interface AppContext {
  env: Env;
  pool: DbPool;
  redis: RedisClient;
  logger: Logger;
  notificationPublisher: NotificationPublisher;
}

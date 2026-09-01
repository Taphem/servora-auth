import { buildApp } from './app/buildApp.js';
import type { AppContext } from './app/context.js';
import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import { ReadinessState } from './health/readinessState.js';
import { createLogger } from './observability/logger.js';
import { HttpNotificationPublisher } from './notifications/HttpNotificationPublisher.js';
import { NullNotificationPublisher } from './notifications/NullNotificationPublisher.js';
import type { NotificationPublisher } from './notifications/NotificationPublisher.js';
import { createRedisClient } from './redis/client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const readiness = new ReadinessState();

  const pool = createPool(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);

  const notificationPublisher: NotificationPublisher = env.notificationConfigured
    ? new HttpNotificationPublisher({
        baseUrl: env.NOTIFICATION_SERVICE_URL!,
        internalServiceKey: env.INTERNAL_SERVICE_KEY,
        timeoutMs: env.NOTIFICATION_SERVICE_TIMEOUT_MS,
        logger,
      })
    : new NullNotificationPublisher(logger);

  if (!env.notificationConfigured) {
    logger.warn('NOTIFICATION_SERVICE_URL is not set; verification/reset events will not be delivered anywhere.');
  }
  if (!env.googleOAuthConfigured) {
    logger.warn('Google OAuth is not fully configured; /api/v1/auth/google/* will return 503.');
  }

  const ctx: AppContext = { env, pool, redis, logger, notificationPublisher };
  const app = buildApp(ctx, readiness);

  await pool.query('SELECT 1');
  readiness.markReady();

  await app.listen({ host: env.HOST, port: env.PORT });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    readiness.markNotReady();
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

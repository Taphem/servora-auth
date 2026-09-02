import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp.js';
import type { AppContext } from '../../src/app/context.js';
import { loadEnv } from '../../src/config/env.js';
import { createPool } from '../../src/db/pool.js';
import { createLogger } from '../../src/observability/logger.js';
import { InMemoryNotificationPublisher } from '../../src/notifications/InMemoryNotificationPublisher.js';
import { createRedisClient } from '../../src/redis/client.js';

export const TEST_INTERNAL_SERVICE_KEY = 'test-internal-service-key-at-least-32-chars-long';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  notifications: InMemoryNotificationPublisher;
  close: () => Promise<void>;
}

/**
 * Requires TEST_DATABASE_URL / TEST_REDIS_URL — see test/integration/README
 * or vitest skip guards. `envOverrides` lets a test point specific env vars
 * at a fixed value (e.g. a fake GOOGLE_CLIENT_ID for a mocked-verification
 * test, or '' to exercise the "not configured" degrade path) without
 * touching whatever the real environment/.env happens to have set.
 */
export function buildTestApp(envOverrides: Record<string, string> = {}): TestApp {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
    REDIS_URL: process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL'] ?? '',
    INTERNAL_SERVICE_KEY: TEST_INTERNAL_SERVICE_KEY,
    LOG_LEVEL: 'silent',
    ...envOverrides,
  });

  const pool = createPool(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);
  const logger = createLogger(env);
  const notifications = new InMemoryNotificationPublisher();

  const ctx: AppContext = { env, pool, redis, logger, notificationPublisher: notifications };
  const app = buildApp(ctx);

  return {
    app,
    ctx,
    notifications,
    close: async () => {
      await app.close();
      await pool.end();
      redis.disconnect();
    },
  };
}

export async function resetDatabase(ctx: AppContext): Promise<void> {
  // otp_challenges is included even though the application no longer
  // writes to it (phone OTP challenges now live in Redis — see
  // src/redis/otpChallenge.ts) — the table itself was intentionally kept
  // in the schema, unused, rather than dropped.
  await ctx.pool.query(
    'TRUNCATE otp_challenges, password_reset_tokens, email_verification_tokens, sessions, oauth_identities, users RESTART IDENTITY CASCADE',
  );
}

export async function flushRedis(ctx: AppContext): Promise<void> {
  // FLUSHDB is fine here: this is a disposable, test-only Redis instance
  // (TEST_REDIS_URL), never the production/dev instance — see
  // scripts/reset-auth-data.ts for the production-safe, prefix-scoped
  // equivalent used against a real environment.
  await ctx.redis.flushdb();
}

import { Client } from 'pg';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE, PRODUCTION_OVERRIDE_VALUE, runResetAuthData } from '../../scripts/resetAuthDataCore.js';
import { buildTestApp, flushRedis, resetDatabase, type TestApp } from '../helpers/buildTestApp.js';
import { isInfraAvailable } from './helpers.js';

describe.skipIf(!isInfraAvailable())('reset-auth-data (safe cleanup script)', () => {
  let testApp: TestApp;
  let pgClient: Client;
  let redis: Redis;

  beforeAll(async () => {
    testApp = buildTestApp();
    pgClient = new Client({ connectionString: testApp.ctx.env.DATABASE_URL });
    await pgClient.connect();
    redis = new Redis(testApp.ctx.env.REDIS_URL);
  });

  afterEach(async () => {
    await resetDatabase(testApp.ctx);
    await flushRedis(testApp.ctx);
  });

  afterAll(async () => {
    await pgClient.end();
    redis.disconnect();
    await testApp.close();
  });

  async function seedOneAccount(email: string): Promise<void> {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery' },
    });
    expect(response.statusCode).toBe(201);
  }

  it('dry run reports counts but deletes nothing', async () => {
    await seedOneAccount('reset-dryrun@example.com');
    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      payload: { email: 'reset-dryrun@example.com' },
    });

    const report = await runResetAuthData(pgClient, redis, {
      execute: false,
      confirm: undefined,
      isProduction: false,
      productionOverride: undefined,
    });

    expect(report.outcome).toBe('dry-run');
    expect(report.tableCountsBefore.users).toBe(1);
    expect(report.tableCountsBefore.password_reset_tokens).toBeGreaterThanOrEqual(1);
    expect(report.tableRowsDeleted).toBeUndefined();

    // Nothing was actually deleted.
    const usersAfter = await pgClient.query('SELECT COUNT(*) FROM users');
    expect(Number(usersAfter.rows[0].count)).toBe(1);
  });

  it('refuses to execute without --confirm, even with --execute', async () => {
    await seedOneAccount('reset-noconfirm@example.com');

    const report = await runResetAuthData(pgClient, redis, {
      execute: true,
      confirm: undefined,
      isProduction: false,
      productionOverride: undefined,
    });

    expect(report.outcome).toBe('refused-not-confirmed');

    const usersAfter = await pgClient.query('SELECT COUNT(*) FROM users');
    expect(Number(usersAfter.rows[0].count)).toBe(1);
  });

  it('refuses to run against production without the explicit override', async () => {
    await seedOneAccount('reset-prod-guard@example.com');

    const report = await runResetAuthData(pgClient, redis, {
      execute: true,
      confirm: CONFIRM_PHRASE,
      isProduction: true,
      productionOverride: undefined,
    });

    expect(report.outcome).toBe('refused-production');

    const usersAfter = await pgClient.query('SELECT COUNT(*) FROM users');
    expect(Number(usersAfter.rows[0].count)).toBe(1);
  });

  it('a wrong production override value is also refused (must match exactly)', async () => {
    const report = await runResetAuthData(pgClient, redis, {
      execute: true,
      confirm: CONFIRM_PHRASE,
      isProduction: true,
      productionOverride: 'yes-please',
    });

    expect(report.outcome).toBe('refused-production');
  });

  it('proceeds against production only with the exact override value', async () => {
    await seedOneAccount('reset-prod-override@example.com');

    const report = await runResetAuthData(pgClient, redis, {
      execute: true,
      confirm: CONFIRM_PHRASE,
      isProduction: true,
      productionOverride: PRODUCTION_OVERRIDE_VALUE,
    });

    expect(report.outcome).toBe('executed');
    expect(report.verifiedClean).toBe(true);
  });

  it('deletes all rows from every auth table (users, sessions, tokens) in an FK-safe order', async () => {
    await seedOneAccount('reset-full@example.com');
    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      payload: { email: 'reset-full@example.com' },
    });

    const beforeUsers = await pgClient.query('SELECT COUNT(*) FROM users');
    expect(Number(beforeUsers.rows[0].count)).toBe(1);

    const report = await runResetAuthData(pgClient, redis, {
      execute: true,
      confirm: CONFIRM_PHRASE,
      isProduction: false,
      productionOverride: undefined,
    });

    expect(report.outcome).toBe('executed');
    expect(report.tableRowsDeleted?.users).toBe(1);
    expect(report.verifiedClean).toBe(true);

    const afterUsers = await pgClient.query('SELECT COUNT(*) FROM users');
    const afterSessions = await pgClient.query('SELECT COUNT(*) FROM sessions');
    const afterTokens = await pgClient.query('SELECT COUNT(*) FROM password_reset_tokens');
    expect(Number(afterUsers.rows[0].count)).toBe(0);
    expect(Number(afterSessions.rows[0].count)).toBe(0);
    expect(Number(afterTokens.rows[0].count)).toBe(0);
  });

  it('deletes only known auth-owned Redis key namespaces, leaving unrelated keys untouched', async () => {
    await redis.set('ratelimit:login:ip:1.2.3.4', '3', 'EX', 60);
    await redis.set('cooldown:otp-request:some-user-id', '1', 'EX', 60);
    await redis.set('oauth:google:state:abc123', JSON.stringify({ codeVerifier: 'x', nonce: 'y' }), 'EX', 60);
    await redis.set('otp:phone:challenge:some-user-id', JSON.stringify({ otpHash: 'h', phone: '+1', attempts: 0, maxAttempts: 5 }), 'EX', 60);
    // Not an auth key namespace this script recognizes — must survive.
    await redis.set('unrelated:some-other-service:key', 'do-not-touch', 'EX', 300);

    const report = await runResetAuthData(pgClient, redis, {
      execute: true,
      confirm: CONFIRM_PHRASE,
      isProduction: false,
      productionOverride: undefined,
    });

    expect(report.outcome).toBe('executed');
    expect(report.redisKeysDeleted).toBe(4);

    expect(await redis.get('ratelimit:login:ip:1.2.3.4')).toBeNull();
    expect(await redis.get('cooldown:otp-request:some-user-id')).toBeNull();
    expect(await redis.get('oauth:google:state:abc123')).toBeNull();
    expect(await redis.get('otp:phone:challenge:some-user-id')).toBeNull();
    expect(await redis.get('unrelated:some-other-service:key')).toBe('do-not-touch');

    await redis.del('unrelated:some-other-service:key');
  });

  it('does not modify the schema — the same tables exist before and after', async () => {
    const before = await pgClient.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );

    await runResetAuthData(pgClient, redis, {
      execute: true,
      confirm: CONFIRM_PHRASE,
      isProduction: false,
      productionOverride: undefined,
    });

    const after = await pgClient.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );

    expect(after.rows).toEqual(before.rows);
    // otp_challenges must still exist — it was intentionally kept, unused, not dropped.
    expect(after.rows.map((r: { table_name: string }) => r.table_name)).toContain('otp_challenges');
  });
});

import { describe, expect, it } from 'vitest';
import { consumeRateLimit } from '../../src/redis/rateLimiter.js';
import { tryAcquireCooldown } from '../../src/redis/cooldown.js';
import { createFakeRedis } from './fakeRedis.js';

describe('consumeRateLimit', () => {
  it('allows requests up to the limit and blocks beyond it', async () => {
    const redis = createFakeRedis();
    const key = 'test:limit';

    for (let i = 0; i < 3; i++) {
      const result = await consumeRateLimit(redis, key, 3, 60);
      expect(result.allowed).toBe(true);
    }

    const blocked = await consumeRateLimit(redis, key, 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks independent keys separately', async () => {
    const redis = createFakeRedis();
    await consumeRateLimit(redis, 'a', 1, 60);
    const resultB = await consumeRateLimit(redis, 'b', 1, 60);
    expect(resultB.allowed).toBe(true);
  });
});

describe('tryAcquireCooldown', () => {
  it('acquires once and denies a second immediate attempt', async () => {
    const redis = createFakeRedis();
    const key = 'test:cooldown';

    expect(await tryAcquireCooldown(redis, key, 60)).toBe(true);
    expect(await tryAcquireCooldown(redis, key, 60)).toBe(false);
  });
});

import type { RedisClient } from './client.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter (INCR + EXPIRE). Not perfectly atomic across the two
 * commands, but rate limiting here is defense-in-depth abuse mitigation,
 * not a correctness-critical security boundary — an occasional missed
 * expiry self-heals on the next window. Redis is never the sole guarantee
 * of any authentication invariant (see ADR-003 / database-architecture.md).
 */
export async function consumeRateLimit(
  redis: RedisClient,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }

  if (count > limit) {
    const ttl = await redis.ttl(key);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

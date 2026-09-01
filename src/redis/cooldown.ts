import type { RedisClient } from './client.js';

/** Atomically claims a cooldown key; returns false if still within a prior cooldown. */
export async function tryAcquireCooldown(redis: RedisClient, key: string, cooldownSeconds: number): Promise<boolean> {
  const result = await redis.set(key, '1', 'EX', cooldownSeconds, 'NX');
  return result === 'OK';
}

export async function getCooldownRemaining(redis: RedisClient, key: string): Promise<number> {
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : 0;
}

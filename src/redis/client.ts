import { Redis } from 'ioredis';

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
}

export type RedisClient = Redis;

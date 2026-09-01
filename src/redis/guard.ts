import type { RedisClient } from './client.js';
import { consumeRateLimit } from './rateLimiter.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

/** Throws a 429 AppError if the given key has exceeded its limit for the window. */
export async function enforceRateLimit(
  redis: RedisClient,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await consumeRateLimit(redis, key, limit, windowSeconds);
  if (!result.allowed) {
    throw new AppError({
      statusCode: 429,
      code: ErrorCode.RATE_LIMITED,
      message: 'Too many requests. Please try again later.',
    });
  }
}

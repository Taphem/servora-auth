import type { RedisClient } from '../redis/client.js';

interface StoredOAuthState {
  codeVerifier: string;
  nonce: string;
}

const STATE_TTL_SECONDS = 10 * 60;

function stateKey(state: string): string {
  return `oauth:google:state:${state}`;
}

export async function storeOAuthState(redis: RedisClient, state: string, data: StoredOAuthState): Promise<void> {
  await redis.set(stateKey(state), JSON.stringify(data), 'EX', STATE_TTL_SECONDS);
}

/** Consumes (single-use) the stored state; returns undefined if missing/expired/already used. */
export async function consumeOAuthState(redis: RedisClient, state: string): Promise<StoredOAuthState | undefined> {
  const key = stateKey(state);
  const raw = await redis.get(key);
  if (!raw) {
    return undefined;
  }
  await redis.del(key);
  return JSON.parse(raw) as StoredOAuthState;
}

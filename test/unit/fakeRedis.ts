import type { RedisClient } from '../../src/redis/client.js';

/** Minimal in-memory stand-in for the handful of Redis commands this service uses. */
export class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | undefined }>();

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return true;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async incr(key: string): Promise<number> {
    const current = this.isExpired(key) ? 0 : Number(this.store.get(key)?.value ?? '0');
    const next = current + 1;
    const existing = this.store.get(key);
    this.store.set(key, { value: String(next), expiresAt: this.isExpired(key) ? undefined : existing?.expiresAt });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    if (this.isExpired(key)) return -2;
    const entry = this.store.get(key);
    if (!entry?.expiresAt) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    const nx = args.includes('NX');
    if (nx && !this.isExpired(key)) {
      return null;
    }
    const exIndex = args.indexOf('EX');
    const ttlSeconds = exIndex >= 0 ? Number(args[exIndex + 1]) : undefined;
    this.store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.isExpired(key) ? null : (this.store.get(key)?.value ?? null);
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

export function createFakeRedis(): RedisClient {
  return new FakeRedis() as unknown as RedisClient;
}

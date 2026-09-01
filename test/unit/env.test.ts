import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgresql://localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_SERVICE_KEY: 'a'.repeat(40),
};

describe('loadEnv', () => {
  it('throws when required variables are missing', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('applies documented defaults', () => {
    const env = loadEnv(BASE);
    expect(env.PORT).toBe(4001);
    expect(env.SESSION_COOKIE_NAME).toBe('servora_session');
    expect(env.SESSION_TTL_SECONDS).toBe(60 * 60 * 24 * 7);
    expect(env.NODE_ENV).toBe('development');
  });

  it('treats empty-string optional variables as unset, not invalid (common .env shape: KEY=)', () => {
    const env = loadEnv({
      ...BASE,
      GOOGLE_REDIRECT_URI: '',
      OAUTH_POST_LOGIN_REDIRECT_URL: '',
      NOTIFICATION_SERVICE_URL: '',
      SESSION_COOKIE_DOMAIN: '',
      SESSION_COOKIE_SECURE: '',
    });
    expect(env.GOOGLE_REDIRECT_URI).toBeUndefined();
    expect(env.NOTIFICATION_SERVICE_URL).toBeUndefined();
    expect(env.notificationConfigured).toBe(false);
    expect(env.sessionCookieSecure).toBe(false); // falls back to NODE_ENV=development default
  });

  it('does not require Google OAuth to be configured', () => {
    const env = loadEnv(BASE);
    expect(env.googleOAuthConfigured).toBe(false);
  });

  it('marks Google OAuth configured only when all three variables are present', () => {
    const env = loadEnv({
      ...BASE,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://example.com/callback',
    });
    expect(env.googleOAuthConfigured).toBe(true);
  });

  it('refuses to start in production with an insecure cookie', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' })).toThrow(
      /insecure configuration/,
    );
  });

  it('refuses to start in production with a short internal service key', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production', INTERNAL_SERVICE_KEY: 'too-short' })).toThrow(
      /INTERNAL_SERVICE_KEY/,
    );
  });

  it('allows production with a secure cookie and strong key', () => {
    const env = loadEnv({ ...BASE, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'true' });
    expect(env.isProduction).toBe(true);
    expect(env.sessionCookieSecure).toBe(true);
  });
});

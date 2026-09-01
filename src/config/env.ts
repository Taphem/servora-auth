import { z } from 'zod';

const booleanFromString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .union([z.boolean(), z.string()])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'))
    .optional(),
);

/**
 * A .env file commonly spells "unset" as `KEY=` (empty string), but zod's
 * `.optional()` only treats `undefined` as absent — an empty string would
 * otherwise fail `.url()` validation instead of being treated as not
 * configured. This normalizes empty string to undefined before the rest of
 * the schema runs.
 */
const optionalString = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  SESSION_COOKIE_NAME: z.string().min(1).default('servora_session'),
  SESSION_COOKIE_DOMAIN: optionalString,
  SESSION_COOKIE_PATH: z.string().default('/'),
  SESSION_COOKIE_SECURE: booleanFromString,
  SESSION_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),

  INTERNAL_SERVICE_KEY: z.string().min(1, 'INTERNAL_SERVICE_KEY is required'),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalUrl,
  OAUTH_POST_LOGIN_REDIRECT_URL: optionalUrl,

  NOTIFICATION_SERVICE_URL: optionalUrl,
  NOTIFICATION_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  EMAIL_VERIFICATION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60),
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 60),
  PASSWORD_RESET_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(5 * 60),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),

  REQUEST_ID_HEADER: z.string().default('x-request-id'),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
});

export type Env = ReturnType<typeof loadEnv>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  const sessionCookieSecure = env.SESSION_COOKIE_SECURE ?? isProduction;

  if (isProduction) {
    const productionIssues: string[] = [];

    if (!sessionCookieSecure) {
      productionIssues.push('SESSION_COOKIE_SECURE must not be false in production');
    }
    if (env.INTERNAL_SERVICE_KEY.length < 32) {
      productionIssues.push('INTERNAL_SERVICE_KEY must be at least 32 characters in production');
    }
    if (env.SESSION_COOKIE_SAME_SITE === 'none' && !sessionCookieSecure) {
      productionIssues.push('SESSION_COOKIE_SAME_SITE=none requires SESSION_COOKIE_SECURE=true');
    }

    if (productionIssues.length > 0) {
      throw new Error(`Refusing to start in production with insecure configuration: ${productionIssues.join('; ')}`);
    }
  }

  return {
    ...env,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    sessionCookieSecure,
    googleOAuthConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI),
    notificationConfigured: Boolean(env.NOTIFICATION_SERVICE_URL),
  };
}

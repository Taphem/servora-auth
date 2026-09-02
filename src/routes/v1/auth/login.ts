import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { createSession } from '../../../auth/sessionService.js';
import { setSessionCookie } from '../../../auth/sessionCookie.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { findUserByEmail } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { loginBodySchema } from '../../../schemas/auth.js';
import { verifyAgainstDummyHash, verifyPassword } from '../../../security/password.js';

const INVALID_CREDENTIALS_ERROR = new AppError({
  statusCode: 401,
  code: ErrorCode.INVALID_CREDENTIALS,
  message: 'Invalid email or password.',
});

export function registerLoginRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = loginBodySchema.parse(request.body);

    await enforceRateLimit(ctx.redis, `ratelimit:login:ip:${request.ip}`, RATE_LIMITS.loginByIp.limit, RATE_LIMITS.loginByIp.windowSeconds);
    await enforceRateLimit(
      ctx.redis,
      `ratelimit:login:email:${body.email}`,
      RATE_LIMITS.loginByEmail.limit,
      RATE_LIMITS.loginByEmail.windowSeconds,
    );

    const user = await findUserByEmail(ctx.pool, body.email);

    // Constant-shape response whether the account doesn't exist or has no
    // password (Google-only account): run an equivalent-cost dummy verify
    // so response timing doesn't distinguish the two from a login attempt
    // against a real password account (see security/password.ts).
    if (!user || !user.passwordHash) {
      await verifyAgainstDummyHash();
      throw INVALID_CREDENTIALS_ERROR;
    }

    const passwordMatches = await verifyPassword(user.passwordHash, body.password);
    if (!passwordMatches) {
      throw INVALID_CREDENTIALS_ERROR;
    }

    if (user.status === 'LOCKED') {
      throw new AppError({ statusCode: 423, code: ErrorCode.ACCOUNT_LOCKED, message: 'This account is locked.' });
    }
    if (user.status === 'DISABLED') {
      throw new AppError({ statusCode: 403, code: ErrorCode.ACCOUNT_DISABLED, message: 'This account is disabled.' });
    }

    const { rawToken } = await createSession(ctx.pool, {
      userId: user.id,
      ttlSeconds: ctx.env.SESSION_TTL_SECONDS,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });

    // Only reached after session creation actually succeeded — i.e. only
    // for a genuinely completed login, never a failed attempt (both
    // credential checks above throw and return early on failure) and
    // never for GET /api/v1/auth/session, which never touches
    // notificationPublisher at all. See notifications/events.ts AuthLoginEvent.
    await ctx.notificationPublisher.publish({
      type: 'AuthLogin',
      requestId: request.id,
      userId: user.id,
      email: user.email,
      authenticationMethod: 'password',
    });

    setSessionCookie(reply, ctx.env, rawToken);

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
    };
  });
}

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { createSession } from '../../../auth/sessionService.js';
import { setSessionCookie } from '../../../auth/sessionCookie.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { insertEmailVerificationToken } from '../../../db/queries/emailVerificationTokens.js';
import { insertUser } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { registerBodySchema } from '../../../schemas/auth.js';
import { hashPassword } from '../../../security/password.js';
import { generateSecureToken, hashToken } from '../../../security/tokens.js';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

function isUniqueViolation(error: unknown): error is PgUniqueViolation {
  return typeof error === 'object' && error !== null && (error as PgUniqueViolation).code === '23505';
}

export function registerRegisterRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = registerBodySchema.parse(request.body);

    await enforceRateLimit(ctx.redis, `ratelimit:register:ip:${request.ip}`, RATE_LIMITS.registerByIp.limit, RATE_LIMITS.registerByIp.windowSeconds);
    await enforceRateLimit(
      ctx.redis,
      `ratelimit:register:email:${body.email}`,
      RATE_LIMITS.registerByEmail.limit,
      RATE_LIMITS.registerByEmail.windowSeconds,
    );

    const passwordHash = await hashPassword(body.password);

    const user = await insertUser(ctx.pool, {
      email: body.email,
      phone: null,
      passwordHash,
      role: 'CUSTOMER',
      emailVerifiedAt: null,
    }).catch((error: unknown) => {
      if (isUniqueViolation(error) && error.constraint === 'users_email_unique') {
        throw new AppError({
          statusCode: 409,
          code: ErrorCode.EMAIL_ALREADY_REGISTERED,
          message: 'An account with this email already exists.',
        });
      }
      throw error;
    });

    const rawToken = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + ctx.env.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS * 1000);
    await insertEmailVerificationToken(ctx.pool, { userId: user.id, tokenHash: hashToken(rawToken), expiresAt });

    await ctx.notificationPublisher.publish({
      type: 'EmailVerificationRequested',
      requestId: request.id,
      userId: user.id,
      email: user.email,
      verificationToken: rawToken,
    });

    const { rawToken: sessionToken } = await createSession(ctx.pool, {
      userId: user.id,
      ttlSeconds: ctx.env.SESSION_TTL_SECONDS,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });
    setSessionCookie(reply, ctx.env, sessionToken);

    reply.status(201);
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: false,
      phoneVerified: false,
    };
  });
}

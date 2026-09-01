import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { insertEmailVerificationToken } from '../../../db/queries/emailVerificationTokens.js';
import { findUserByEmail } from '../../../db/queries/users.js';
import { tryAcquireCooldown } from '../../../redis/cooldown.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { emailResendBodySchema } from '../../../schemas/auth.js';
import { generateSecureToken, hashToken } from '../../../security/tokens.js';

const GENERIC_RESPONSE = {
  message: 'If an account with this email exists and is not yet verified, a new verification email has been sent.',
};

export function registerEmailResendRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/email/resend', async (request) => {
    const body = emailResendBodySchema.parse(request.body);

    await enforceRateLimit(
      ctx.redis,
      `ratelimit:email-resend:ip:${request.ip}`,
      RATE_LIMITS.emailResendByIp.limit,
      RATE_LIMITS.emailResendByIp.windowSeconds,
    );
    await enforceRateLimit(
      ctx.redis,
      `ratelimit:email-resend:email:${body.email}`,
      RATE_LIMITS.emailResendByEmail.limit,
      RATE_LIMITS.emailResendByEmail.windowSeconds,
    );

    const user = await findUserByEmail(ctx.pool, body.email);
    if (!user || user.emailVerifiedAt) {
      return GENERIC_RESPONSE;
    }

    const cooldownAcquired = await tryAcquireCooldown(
      ctx.redis,
      `cooldown:email-resend:${user.id}`,
      ctx.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
    );
    if (!cooldownAcquired) {
      return GENERIC_RESPONSE;
    }

    const rawToken = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + ctx.env.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS * 1000);
    await insertEmailVerificationToken(ctx.pool, { userId: user.id, tokenHash: hashToken(rawToken), expiresAt });

    await ctx.notificationPublisher.publish({
      type: 'EmailVerificationRequested',
      requestId: request.id,
      userId: user.id,
      email: user.email,
      verificationToken: rawToken,
      expiresAt: expiresAt.toISOString(),
    });

    return GENERIC_RESPONSE;
  });
}

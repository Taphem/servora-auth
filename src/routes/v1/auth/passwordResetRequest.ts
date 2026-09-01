import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { insertPasswordResetToken } from '../../../db/queries/passwordResetTokens.js';
import { findUserByEmail } from '../../../db/queries/users.js';
import { tryAcquireCooldown } from '../../../redis/cooldown.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { passwordResetRequestBodySchema } from '../../../schemas/auth.js';
import { generateSecureToken, hashToken } from '../../../security/tokens.js';

const GENERIC_RESPONSE = {
  message: 'If an account with this email exists, a password reset link has been sent.',
};

export function registerPasswordResetRequestRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/password/reset/request', async (request) => {
    const body = passwordResetRequestBodySchema.parse(request.body);

    await enforceRateLimit(
      ctx.redis,
      `ratelimit:password-reset-request:ip:${request.ip}`,
      RATE_LIMITS.passwordResetRequestByIp.limit,
      RATE_LIMITS.passwordResetRequestByIp.windowSeconds,
    );
    await enforceRateLimit(
      ctx.redis,
      `ratelimit:password-reset-request:email:${body.email}`,
      RATE_LIMITS.passwordResetRequestByEmail.limit,
      RATE_LIMITS.passwordResetRequestByEmail.windowSeconds,
    );

    // Never reveal whether the account exists — same response either way.
    const user = await findUserByEmail(ctx.pool, body.email);
    if (!user) {
      return GENERIC_RESPONSE;
    }

    const cooldownAcquired = await tryAcquireCooldown(
      ctx.redis,
      `cooldown:password-reset-request:${user.id}`,
      ctx.env.PASSWORD_RESET_COOLDOWN_SECONDS,
    );
    if (!cooldownAcquired) {
      return GENERIC_RESPONSE;
    }

    const rawToken = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + ctx.env.PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000);
    await insertPasswordResetToken(ctx.pool, { userId: user.id, tokenHash: hashToken(rawToken), expiresAt });

    await ctx.notificationPublisher.publish({
      type: 'PasswordResetRequested',
      requestId: request.id,
      userId: user.id,
      email: user.email,
      resetToken: rawToken,
    });

    return GENERIC_RESPONSE;
  });
}

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { revokeAllSessionsForUser } from '../../../db/queries/sessions.js';
import { consumePasswordResetToken, findValidPasswordResetTokenByHash } from '../../../db/queries/passwordResetTokens.js';
import { updatePasswordHash } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { passwordResetConfirmBodySchema } from '../../../schemas/auth.js';
import { hashPassword } from '../../../security/password.js';
import { hashToken } from '../../../security/tokens.js';

export function registerPasswordResetConfirmRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/password/reset/confirm', async (request) => {
    const body = passwordResetConfirmBodySchema.parse(request.body);

    await enforceRateLimit(
      ctx.redis,
      `ratelimit:password-reset-confirm:ip:${request.ip}`,
      RATE_LIMITS.passwordResetConfirmByIp.limit,
      RATE_LIMITS.passwordResetConfirmByIp.windowSeconds,
    );

    const token = await findValidPasswordResetTokenByHash(ctx.pool, hashToken(body.token));
    if (!token) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCode.TOKEN_INVALID,
        message: 'This reset link is invalid or has expired.',
      });
    }

    const passwordHash = await hashPassword(body.newPassword);

    await consumePasswordResetToken(ctx.pool, token.id);
    await updatePasswordHash(ctx.pool, token.userId, passwordHash);

    // Session security after password reset: revoke every existing session
    // so a credential compromise doesn't survive the password change. The
    // user must log in again with the new password (no auto-login here).
    await revokeAllSessionsForUser(ctx.pool, token.userId);

    return { reset: true };
  });
}

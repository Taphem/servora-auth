import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import {
  consumeEmailVerificationToken,
  findValidEmailVerificationTokenByHash,
} from '../../../db/queries/emailVerificationTokens.js';
import { markEmailVerified } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { emailVerifyBodySchema } from '../../../schemas/auth.js';
import { hashToken } from '../../../security/tokens.js';

export function registerEmailVerifyRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/email/verify', async (request) => {
    const body = emailVerifyBodySchema.parse(request.body);

    const token = await findValidEmailVerificationTokenByHash(ctx.pool, hashToken(body.token));
    if (!token) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCode.TOKEN_INVALID,
        message: 'This verification link is invalid or has expired.',
      });
    }

    await consumeEmailVerificationToken(ctx.pool, token.id);
    await markEmailVerified(ctx.pool, token.userId);

    return { verified: true };
  });
}

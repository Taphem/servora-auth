import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { buildGoogleAuthorizationUrl } from '../../../oauth/googleClient.js';

export function registerGoogleStartRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/auth/google/start', async (_request, reply) => {
    if (!ctx.env.googleOAuthConfigured) {
      throw new AppError({
        statusCode: 503,
        code: ErrorCode.GOOGLE_OAUTH_NOT_CONFIGURED,
        message: 'Google sign-in is not configured on this deployment.',
      });
    }

    const url = await buildGoogleAuthorizationUrl(
      {
        clientId: ctx.env.GOOGLE_CLIENT_ID!,
        clientSecret: ctx.env.GOOGLE_CLIENT_SECRET!,
        redirectUri: ctx.env.GOOGLE_REDIRECT_URI!,
      },
      ctx.redis,
    );

    reply.code(302).redirect(url);
  });
}

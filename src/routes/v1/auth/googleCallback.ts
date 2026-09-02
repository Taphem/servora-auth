import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { resolveOrCreateUserForGoogleIdentity } from '../../../auth/googleIdentityService.js';
import { setSessionCookie } from '../../../auth/sessionCookie.js';
import { createSession } from '../../../auth/sessionService.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { completeGoogleLogin } from '../../../oauth/googleClient.js';

export function registerGoogleCallbackRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/auth/google/callback', async (request, reply) => {
    if (!ctx.env.googleOAuthConfigured) {
      throw new AppError({
        statusCode: 503,
        code: ErrorCode.GOOGLE_OAUTH_NOT_CONFIGURED,
        message: 'Google sign-in is not configured on this deployment.',
      });
    }
    if (!ctx.env.OAUTH_POST_LOGIN_REDIRECT_URL) {
      throw new AppError({
        statusCode: 503,
        code: ErrorCode.GOOGLE_OAUTH_NOT_CONFIGURED,
        message: 'OAUTH_POST_LOGIN_REDIRECT_URL is not configured on this deployment.',
      });
    }

    const callbackUrl = new URL(request.url, ctx.env.GOOGLE_REDIRECT_URI);

    const identity = await completeGoogleLogin(
      {
        clientId: ctx.env.GOOGLE_CLIENT_ID!,
        clientSecret: ctx.env.GOOGLE_CLIENT_SECRET!,
        redirectUri: ctx.env.GOOGLE_REDIRECT_URI!,
      },
      ctx.redis,
      callbackUrl,
    );

    const { user, isNewAccount } = await resolveOrCreateUserForGoogleIdentity(ctx.pool, identity);

    const { rawToken } = await createSession(ctx.pool, {
      userId: user.id,
      ttlSeconds: ctx.env.SESSION_TTL_SECONDS,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });

    // Same rule as the ID-token endpoint (googleAuthenticate.ts): exactly
    // one of AccountCreated/AuthLogin, decided purely by identity
    // resolution, fired only after session creation has succeeded.
    if (isNewAccount) {
      await ctx.notificationPublisher.publish({
        type: 'AccountCreated',
        requestId: request.id,
        userId: user.id,
        email: user.email,
        authenticationMethod: 'google',
        emailVerified: user.emailVerifiedAt !== null,
      });
    } else {
      await ctx.notificationPublisher.publish({
        type: 'AuthLogin',
        requestId: request.id,
        userId: user.id,
        email: user.email,
        authenticationMethod: 'google',
      });
    }

    setSessionCookie(reply, ctx.env, rawToken);

    reply.code(302).redirect(ctx.env.OAUTH_POST_LOGIN_REDIRECT_URL);
  });
}

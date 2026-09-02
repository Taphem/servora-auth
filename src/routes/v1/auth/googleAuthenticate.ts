import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { resolveOrCreateUserForGoogleIdentity } from '../../../auth/googleIdentityService.js';
import { setSessionCookie } from '../../../auth/sessionCookie.js';
import { createSession } from '../../../auth/sessionService.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { verifyGoogleIdToken } from '../../../oauth/googleIdTokenVerifier.js';
import { googleAuthenticateBodySchema } from '../../../schemas/auth.js';

/**
 * "Continue with Google" for a frontend that obtains a Google ID token
 * directly (Google Identity Services button/One Tap) rather than going
 * through the authorization-code redirect (google/start + google/callback,
 * unchanged, still available for a redirect-based integration).
 *
 * This endpoint is deliberately mode-less: it means "authenticate me with
 * this Google identity," never "sign up only" or "log in only." Whether
 * the browser is showing a Login or Signup page is irrelevant here and is
 * never part of the request — resolveOrCreateUserForGoogleIdentity (shared
 * with the redirect flow) already finds-or-creates-or-links purely from
 * the verified Google identity, with no signup/login distinction to break.
 */
export function registerGoogleAuthenticateRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/google', async (request, reply) => {
    if (!ctx.env.googleIdTokenVerificationConfigured) {
      throw new AppError({
        statusCode: 503,
        code: ErrorCode.GOOGLE_OAUTH_NOT_CONFIGURED,
        message: 'Google sign-in is not configured on this deployment.',
      });
    }

    const body = googleAuthenticateBodySchema.parse(request.body);

    const identity = await verifyGoogleIdToken(ctx.env.GOOGLE_CLIENT_ID!, body.credential);

    const user = await resolveOrCreateUserForGoogleIdentity(ctx.pool, identity);

    const { rawToken } = await createSession(ctx.pool, {
      userId: user.id,
      ttlSeconds: ctx.env.SESSION_TTL_SECONDS,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
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

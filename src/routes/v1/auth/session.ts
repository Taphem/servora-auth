import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { readSessionCookie } from '../../../auth/sessionCookie.js';
import { verifySessionToken } from '../../../auth/sessionService.js';

export function registerSessionRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/auth/session', async (request) => {
    const rawToken = readSessionCookie(request, ctx.env);
    if (!rawToken) {
      return { authenticated: false };
    }

    const verified = await verifySessionToken(ctx.pool, rawToken);
    if (!verified) {
      return { authenticated: false };
    }

    return {
      authenticated: true,
      userId: verified.user.id,
      email: verified.user.email,
      role: verified.user.role,
      emailVerified: verified.user.emailVerifiedAt !== null,
      phoneVerified: verified.user.phoneVerifiedAt !== null,
    };
  });
}

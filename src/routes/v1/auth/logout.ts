import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { clearSessionCookie, readSessionCookie } from '../../../auth/sessionCookie.js';
import { revokeSession } from '../../../auth/sessionService.js';

export function registerLogoutRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const rawToken = readSessionCookie(request, ctx.env);
    if (rawToken) {
      await revokeSession(ctx.pool, rawToken);
    }
    clearSessionCookie(reply, ctx.env);

    reply.status(204);
    return reply.send();
  });
}

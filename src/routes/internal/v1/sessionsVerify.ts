import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { verifySessionToken } from '../../../auth/sessionService.js';
import { requireInternalServiceKey } from '../../../plugins/internalAuth.js';
import { internalSessionVerifyBodySchema } from '../../../schemas/auth.js';

/**
 * WORKING CONTRACT (PROPOSED — see README.md "Internal session verification").
 * Mirrors the API Gateway's existing provisional client (authClient.ts) so
 * the two services interoperate today, plus service-to-service
 * authentication the gateway's current code does not yet send. This is not
 * a public endpoint: it is never mounted under /api/v1 and always requires
 * x-servora-internal-key.
 */
export function registerInternalSessionsVerifyRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/internal/v1/sessions/verify',
    { preHandler: requireInternalServiceKey(ctx.env.INTERNAL_SERVICE_KEY) },
    async (request) => {
      const body = internalSessionVerifyBodySchema.parse(request.body);

      const verified = await verifySessionToken(ctx.pool, body.sessionToken);
      if (!verified) {
        return { valid: false };
      }

      return {
        valid: true,
        userId: verified.user.id,
        role: verified.user.role,
        sessionId: verified.session.id,
      };
    },
  );
}

import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/**
 * This service is only ever reached through the API Gateway or direct
 * service-to-service calls (never rendering HTML for a browser), so CSP is
 * disabled — the same reasoning the gateway itself uses.
 */
export default fp(async (app: FastifyInstance) => {
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
});

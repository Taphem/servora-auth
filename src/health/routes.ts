import type { FastifyInstance } from 'fastify';
import type { ReadinessState } from './readinessState.js';

export async function registerHealthRoutes(app: FastifyInstance, readiness: ReadinessState): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/ready', async (_request, reply) => {
    if (!readiness.isReady()) {
      reply.status(503);
      return { status: 'not_ready' };
    }
    return { status: 'ready' };
  });
}

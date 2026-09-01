import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './context.js';
import { createRequestIdGenerator } from '../plugins/requestId.js';
import requestIdEchoPlugin from '../plugins/requestId.js';
import errorHandlerPlugin from '../plugins/errorHandler.js';
import securityPlugin from '../plugins/security.js';
import cookiesPlugin from '../plugins/cookies.js';
import { registerHealthRoutes } from '../health/routes.js';
import { ReadinessState } from '../health/readinessState.js';
import { registerRoutes } from '../routes/index.js';

export function buildApp(ctx: AppContext, readiness: ReadinessState = new ReadinessState()): FastifyInstance {
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: ctx.logger,
    trustProxy: true,
    bodyLimit: ctx.env.BODY_LIMIT_BYTES,
    genReqId: createRequestIdGenerator(ctx.env.REQUEST_ID_HEADER),
  });

  app.register(requestIdEchoPlugin, { header: ctx.env.REQUEST_ID_HEADER });
  app.register(errorHandlerPlugin);
  app.register(securityPlugin);
  app.register(cookiesPlugin);

  registerHealthRoutes(app, readiness);
  registerRoutes(app, ctx);

  return app;
}

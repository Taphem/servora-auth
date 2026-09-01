import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

function envelope(request: FastifyRequest, code: string, message: string): ErrorEnvelope {
  return { error: { code, message, requestId: request.id } };
}

export default fp(async (app: FastifyInstance) => {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send(envelope(request, ErrorCode.NOT_FOUND, 'The requested resource was not found.'));
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, 'request failed');
      }
      reply.status(error.statusCode).send(envelope(request, error.code, error.message));
      return;
    }

    if (error instanceof ZodError) {
      reply
        .status(400)
        .send(envelope(request, ErrorCode.VALIDATION_FAILED, 'The request could not be validated.'));
      return;
    }

    const fastifyError = error as { statusCode?: number; code?: string; validation?: unknown };

    if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.status(413).send(envelope(request, ErrorCode.PAYLOAD_TOO_LARGE, 'The request payload is too large.'));
      return;
    }

    if (fastifyError.validation) {
      reply.status(400).send(envelope(request, ErrorCode.VALIDATION_FAILED, 'The request could not be validated.'));
      return;
    }

    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      reply
        .status(fastifyError.statusCode)
        .send(envelope(request, ErrorCode.VALIDATION_FAILED, 'The request could not be processed.'));
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply
      .status(500)
      .send(envelope(request, ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred. Please try again.'));
  });
});

import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Fastify's genReqId hook — used to build the app so request IDs are
 * available from the very first log line, not just after onRequest.
 */
export function createRequestIdGenerator(header: string) {
  return (request: FastifyRequest['raw']) => {
    const incoming = request.headers[header.toLowerCase()];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
  };
}

export interface RequestIdEchoOptions {
  header: string;
}

export default fp<RequestIdEchoOptions>(async (app: FastifyInstance, opts: RequestIdEchoOptions) => {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header(opts.header, request.id);
    return payload;
  });
});

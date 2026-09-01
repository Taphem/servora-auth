import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { secureCompare } from '../security/compare.js';

export const INTERNAL_SERVICE_KEY_HEADER = 'x-servora-internal-key';

/**
 * Guards internal-only routes (currently just /internal/v1/sessions/verify).
 * Requires an exact, constant-time match against INTERNAL_SERVICE_KEY.
 * This header must never be sent by a browser and must never appear in
 * frontend configuration — it is a service-to-service secret shared only
 * between this service and whatever calls it internally (the API Gateway).
 */
export function requireInternalServiceKey(expectedKey: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const provided = request.headers[INTERNAL_SERVICE_KEY_HEADER];
    const candidate = Array.isArray(provided) ? provided[0] : provided;

    if (!candidate || !secureCompare(candidate, expectedKey)) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCode.INTERNAL_AUTH_FAILED,
        message: 'Internal authentication failed.',
      });
    }
  };
}

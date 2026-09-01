import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../app/context.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import type { VerifiedSession } from './sessionService.js';
import { verifySessionToken } from './sessionService.js';
import { readSessionCookie } from './sessionCookie.js';

/** Resolves the current session from the request cookie or throws 401. Used by public endpoints that require login. */
export async function requireSession(request: FastifyRequest, ctx: AppContext): Promise<VerifiedSession> {
  const rawToken = readSessionCookie(request, ctx.env);
  if (!rawToken) {
    throw new AppError({ statusCode: 401, code: ErrorCode.UNAUTHENTICATED, message: 'Authentication is required.' });
  }

  const verified = await verifySessionToken(ctx.pool, rawToken);
  if (!verified) {
    throw new AppError({ statusCode: 401, code: ErrorCode.UNAUTHENTICATED, message: 'Authentication is required.' });
  }

  return verified;
}

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { requireSession } from '../../../auth/requireSession.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { markPhoneVerified } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { verifyOtpChallenge } from '../../../redis/otpChallenge.js';
import { phoneOtpVerifyBodySchema } from '../../../schemas/auth.js';
import { hashOtp } from '../../../security/otp.js';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

function isUniqueViolation(error: unknown): error is PgUniqueViolation {
  return typeof error === 'object' && error !== null && (error as PgUniqueViolation).code === '23505';
}

const NOT_REQUESTED_ERROR = new AppError({
  statusCode: 400,
  code: ErrorCode.OTP_NOT_REQUESTED,
  message: 'No active verification code. Please request a new one.',
});

const ATTEMPTS_EXCEEDED_ERROR = new AppError({
  statusCode: 429,
  code: ErrorCode.OTP_ATTEMPTS_EXCEEDED,
  message: 'Too many incorrect attempts. Please request a new code.',
});

const INVALID_OTP_ERROR = new AppError({ statusCode: 400, code: ErrorCode.OTP_INVALID, message: 'Incorrect code.' });

export function registerPhoneOtpVerifyRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/phone/otp/verify', async (request) => {
    const { user } = await requireSession(request, ctx);
    const body = phoneOtpVerifyBodySchema.parse(request.body);

    await enforceRateLimit(
      ctx.redis,
      `ratelimit:otp-verify:ip:${request.ip}`,
      RATE_LIMITS.otpVerifyByIp.limit,
      RATE_LIMITS.otpVerifyByIp.windowSeconds,
    );

    // Atomic in Redis (see redis/otpChallenge.ts): the check-attempts,
    // compare, and consume-or-increment happen in one Lua script, so two
    // concurrent requests submitting the same correct OTP cannot both
    // succeed — only the first to reach Redis wins; the second observes
    // the challenge already consumed.
    const result = await verifyOtpChallenge(ctx.redis, user.id, hashOtp(body.otp));

    if (result.status === 'not_found') {
      throw NOT_REQUESTED_ERROR;
    }
    if (result.status === 'attempts_exceeded') {
      throw ATTEMPTS_EXCEEDED_ERROR;
    }
    if (result.status === 'invalid') {
      throw INVALID_OTP_ERROR;
    }

    await markPhoneVerified(ctx.pool, user.id, result.phone).catch((error: unknown) => {
      if (isUniqueViolation(error) && error.constraint === 'users_phone_unique') {
        throw new AppError({
          statusCode: 409,
          code: ErrorCode.PHONE_ALREADY_REGISTERED,
          message: 'This phone number is already registered to another account.',
        });
      }
      throw error;
    });

    return { verified: true };
  });
}

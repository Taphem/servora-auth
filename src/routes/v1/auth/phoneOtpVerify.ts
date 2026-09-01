import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { requireSession } from '../../../auth/requireSession.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { consumeOtpChallenge, findLatestActiveOtpChallenge, incrementOtpAttempts } from '../../../db/queries/otpChallenges.js';
import { markPhoneVerified } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { phoneOtpVerifyBodySchema } from '../../../schemas/auth.js';
import { secureCompare } from '../../../security/compare.js';
import { hashOtp } from '../../../security/otp.js';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

function isUniqueViolation(error: unknown): error is PgUniqueViolation {
  return typeof error === 'object' && error !== null && (error as PgUniqueViolation).code === '23505';
}

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

    const challenge = await findLatestActiveOtpChallenge(ctx.pool, user.id);
    if (!challenge) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCode.OTP_NOT_REQUESTED,
        message: 'No active verification code. Please request a new one.',
      });
    }

    if (challenge.attemptCount >= challenge.maxAttempts) {
      throw new AppError({
        statusCode: 429,
        code: ErrorCode.OTP_ATTEMPTS_EXCEEDED,
        message: 'Too many incorrect attempts. Please request a new code.',
      });
    }

    const matches = secureCompare(hashOtp(body.otp), challenge.otpHash);
    if (!matches) {
      await incrementOtpAttempts(ctx.pool, challenge.id);
      const attemptsRemaining = challenge.maxAttempts - (challenge.attemptCount + 1);
      throw attemptsRemaining > 0
        ? new AppError({ statusCode: 400, code: ErrorCode.OTP_INVALID, message: 'Incorrect code.' })
        : new AppError({
            statusCode: 429,
            code: ErrorCode.OTP_ATTEMPTS_EXCEEDED,
            message: 'Too many incorrect attempts. Please request a new code.',
          });
    }

    await consumeOtpChallenge(ctx.pool, challenge.id);

    await markPhoneVerified(ctx.pool, user.id, challenge.phone).catch((error: unknown) => {
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

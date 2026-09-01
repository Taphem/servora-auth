import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { requireSession } from '../../../auth/requireSession.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { insertOtpChallenge } from '../../../db/queries/otpChallenges.js';
import { findUserByPhone } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { tryAcquireCooldown } from '../../../redis/cooldown.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { phoneOtpRequestBodySchema } from '../../../schemas/auth.js';
import { generateOtp, hashOtp } from '../../../security/otp.js';

export function registerPhoneOtpRequestRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/auth/phone/otp/request', async (request) => {
    const { user } = await requireSession(request, ctx);
    const body = phoneOtpRequestBodySchema.parse(request.body);

    if (user.phoneVerifiedAt) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCode.PHONE_ALREADY_VERIFIED,
        message: 'This account already has a verified phone number.',
      });
    }

    const existingOwner = await findUserByPhone(ctx.pool, body.phone);
    if (existingOwner && existingOwner.id !== user.id && existingOwner.phoneVerifiedAt) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCode.PHONE_ALREADY_REGISTERED,
        message: 'This phone number is already registered to another account.',
      });
    }

    await enforceRateLimit(
      ctx.redis,
      `ratelimit:otp-request:ip:${request.ip}`,
      RATE_LIMITS.otpRequestByIp.limit,
      RATE_LIMITS.otpRequestByIp.windowSeconds,
    );
    await enforceRateLimit(
      ctx.redis,
      `ratelimit:otp-request:user:${user.id}`,
      RATE_LIMITS.otpRequestByUser.limit,
      RATE_LIMITS.otpRequestByUser.windowSeconds,
    );

    const cooldownAcquired = await tryAcquireCooldown(
      ctx.redis,
      `cooldown:otp-request:${user.id}`,
      ctx.env.OTP_RESEND_COOLDOWN_SECONDS,
    );
    if (!cooldownAcquired) {
      throw new AppError({
        statusCode: 429,
        code: ErrorCode.RATE_LIMITED,
        message: 'Please wait before requesting another code.',
      });
    }

    const otp = generateOtp(ctx.env.OTP_LENGTH);
    const expiresAt = new Date(Date.now() + ctx.env.OTP_TTL_SECONDS * 1000);
    await insertOtpChallenge(ctx.pool, {
      userId: user.id,
      phone: body.phone,
      otpHash: hashOtp(otp),
      expiresAt,
      maxAttempts: ctx.env.OTP_MAX_ATTEMPTS,
    });

    await ctx.notificationPublisher.publish({
      type: 'PhoneOtpRequested',
      requestId: request.id,
      userId: user.id,
      phone: body.phone,
      otp,
      expiresAt: expiresAt.toISOString(),
    });

    return { requested: true, expiresInSeconds: ctx.env.OTP_TTL_SECONDS };
  });
}

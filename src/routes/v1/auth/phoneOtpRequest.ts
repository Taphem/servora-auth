import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../app/context.js';
import { requireSession } from '../../../auth/requireSession.js';
import { RATE_LIMITS } from '../../../config/rateLimits.js';
import { findUserByPhone } from '../../../db/queries/users.js';
import { AppError } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/errorCodes.js';
import { tryAcquireCooldown } from '../../../redis/cooldown.js';
import { enforceRateLimit } from '../../../redis/guard.js';
import { storeOtpChallenge } from '../../../redis/otpChallenge.js';
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

    // Requesting a new OTP simply overwrites any prior challenge for this
    // user (same Redis key) — the old code becomes unusable immediately,
    // and Redis's own TTL retires the new one automatically; no separate
    // expired-row cleanup is needed (see redis/otpChallenge.ts).
    const otp = generateOtp(ctx.env.OTP_LENGTH);
    await storeOtpChallenge(
      ctx.redis,
      user.id,
      { otpHash: hashOtp(otp), phone: body.phone, maxAttempts: ctx.env.OTP_MAX_ATTEMPTS },
      ctx.env.OTP_TTL_SECONDS,
    );

    await ctx.notificationPublisher.publish({
      type: 'PhoneOtpRequested',
      requestId: request.id,
      userId: user.id,
      phone: body.phone,
      otp,
      expiresInSeconds: ctx.env.OTP_TTL_SECONDS,
    });

    return { requested: true, expiresInSeconds: ctx.env.OTP_TTL_SECONDS };
  });
}

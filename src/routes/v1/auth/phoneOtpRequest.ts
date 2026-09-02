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
    // No phone in the body by design — parsing still runs (and, via
    // .strict(), rejects a body that tries to smuggle one in) even though
    // the result is discarded. The OTP destination is never anything but
    // this account's own stored phone; a session must not be usable to
    // request an OTP to an arbitrary number.
    phoneOtpRequestBodySchema.parse(request.body ?? {});

    if (user.phoneVerifiedAt) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCode.PHONE_ALREADY_VERIFIED,
        message: 'This account already has a verified phone number.',
      });
    }

    if (!user.phone) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCode.PHONE_NOT_SET,
        message: 'No phone number is set on this account.',
      });
    }
    const phone = user.phone;

    // Defense-in-depth: since phone is now written to `users` (unverified)
    // at registration and `users_phone_unique` is a hard DB constraint, no
    // other account can already hold this exact value — this check is
    // unreachable through any current flow, but kept in case that
    // registration-time guarantee is ever relaxed by a future change.
    const existingOwner = await findUserByPhone(ctx.pool, phone);
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
      { otpHash: hashOtp(otp), phone, maxAttempts: ctx.env.OTP_MAX_ATTEMPTS },
      ctx.env.OTP_TTL_SECONDS,
    );

    await ctx.notificationPublisher.publish({
      type: 'PhoneOtpRequested',
      requestId: request.id,
      userId: user.id,
      phone,
      otp,
      expiresInSeconds: ctx.env.OTP_TTL_SECONDS,
    });

    return { requested: true, expiresInSeconds: ctx.env.OTP_TTL_SECONDS };
  });
}

/**
 * Endpoint-specific rate limits. Not environment-configurable individually —
 * these are security defaults, not deployment knobs. Sensitive endpoints
 * per servora-docs/08-security/rate-limiting.md: registration, login,
 * password reset, OTP.
 */
export const RATE_LIMITS = {
  registerByIp: { limit: 10, windowSeconds: 60 * 60 },
  registerByEmail: { limit: 5, windowSeconds: 60 * 60 },

  loginByIp: { limit: 20, windowSeconds: 15 * 60 },
  loginByEmail: { limit: 10, windowSeconds: 15 * 60 },

  emailResendByIp: { limit: 10, windowSeconds: 60 * 60 },
  emailResendByEmail: { limit: 5, windowSeconds: 60 * 60 },

  otpRequestByIp: { limit: 10, windowSeconds: 60 * 60 },
  otpRequestByUser: { limit: 5, windowSeconds: 60 * 60 },
  otpVerifyByIp: { limit: 20, windowSeconds: 15 * 60 },

  passwordResetRequestByIp: { limit: 10, windowSeconds: 60 * 60 },
  passwordResetRequestByEmail: { limit: 5, windowSeconds: 60 * 60 },
  passwordResetConfirmByIp: { limit: 20, windowSeconds: 60 * 60 },
} as const;

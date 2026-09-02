import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../security/password.js';

const email = z.string().trim().toLowerCase().email().max(320);
const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
// E.164-ish: leading +, 8-15 digits. Kept permissive; carrier-level validation is Notification's concern.
const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +14155551234');

export const registerBodySchema = z.object({
  email,
  password,
  // Optional by product decision: an account must be fully usable with only
  // email + password. When supplied, normalized/validated the same as the
  // phone OTP flow's own input. Backward compatible with any existing
  // client that only ever sent { email, password }.
  phone: phone.optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const emailVerifyBodySchema = z.object({
  token: z.string().min(1).max(1024),
});
export type EmailVerifyBody = z.infer<typeof emailVerifyBodySchema>;

export const emailResendBodySchema = z.object({
  email,
});
export type EmailResendBody = z.infer<typeof emailResendBodySchema>;

// Deliberately takes no phone field: the phone number OTP is sent to always
// comes from the authenticated user's own stored account data (see
// routes/v1/auth/phoneOtpRequest.ts), never from the request body — a
// session must not be usable to request an OTP to an arbitrary phone
// number. `.strict()` rejects a body that includes an unexpected `phone`
// key outright (400 VALIDATION_FAILED) rather than silently ignoring it,
// as defense in depth on top of the route never reading it.
export const phoneOtpRequestBodySchema = z.object({}).strict();
export type PhoneOtpRequestBody = z.infer<typeof phoneOtpRequestBodySchema>;

export const phoneOtpVerifyBodySchema = z.object({
  otp: z.string().min(4).max(10),
});
export type PhoneOtpVerifyBody = z.infer<typeof phoneOtpVerifyBodySchema>;

export const passwordResetRequestBodySchema = z.object({
  email,
});
export type PasswordResetRequestBody = z.infer<typeof passwordResetRequestBodySchema>;

export const passwordResetConfirmBodySchema = z.object({
  token: z.string().min(1).max(1024),
  newPassword: password,
});
export type PasswordResetConfirmBody = z.infer<typeof passwordResetConfirmBodySchema>;

export const internalSessionVerifyBodySchema = z.object({
  sessionToken: z.string().min(1).max(1024),
});
export type InternalSessionVerifyBody = z.infer<typeof internalSessionVerifyBodySchema>;

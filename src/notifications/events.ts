/**
 * Notification-delivery contract — CONFIRMED against the deployed
 * servora-notification service (see servora-notification/docs/api.md and
 * docs/integration.md). Three resource-oriented internal endpoints under
 * `/internal/v1/notifications/*`, each requiring `x-servora-internal-key`.
 * `type` here is an internal TypeScript discriminator only — it is never
 * sent in the outbound JSON body (see notificationRequest.ts, which maps
 * each event to the exact path + body servora-notification expects).
 * `requestId` is likewise internal-only, sent as the `x-request-id` header
 * rather than a body field, for tracing continuity with that service's own
 * request-ID-bearing error envelope.
 *
 * Deliberately excluded from every request body: anything not in
 * servora-notification's documented schema. The raw token/OTP is passed
 * once, directly in the body of a single authenticated internal call —
 * never logged (see HttpNotificationPublisher.ts), never placed in a
 * durable/broadcast structure, never persisted by this service beyond the
 * request.
 */

export type NotificationEventType =
  | 'EmailVerificationRequested'
  | 'PhoneOtpRequested'
  | 'PasswordResetRequested';

export interface EmailVerificationRequestedEvent {
  type: 'EmailVerificationRequested';
  requestId: string;
  userId: string;
  email: string;
  verificationToken: string;
}

export interface PhoneOtpRequestedEvent {
  type: 'PhoneOtpRequested';
  requestId: string;
  userId: string;
  phone: string;
  otp: string;
  expiresInSeconds: number;
}

export interface PasswordResetRequestedEvent {
  type: 'PasswordResetRequested';
  requestId: string;
  userId: string;
  email: string;
  resetToken: string;
}

export type NotificationEvent =
  | EmailVerificationRequestedEvent
  | PhoneOtpRequestedEvent
  | PasswordResetRequestedEvent;

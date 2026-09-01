/**
 * PROPOSED notification-delivery contract — NOT defined in servora-docs.
 *
 * service-boundaries.md assigns "Email/SMS/push delivery" to
 * servora-notification, and communication.md classifies email/SMS as
 * asynchronous work. servora-notification does not exist yet, so this
 * shape is a proposal for Auth's outbound side only, not a confirmed
 * cross-service contract. See README.md "Notification integration
 * boundary" for the full rationale and what would need to change once
 * servora-notification actually defines its intake contract (most likely
 * a RabbitMQ event per event-architecture.md, rather than the HTTP POST
 * used here as an honest stand-in).
 *
 * Deliberately excluded from every event payload: the raw token/OTP is
 * never placed in a durable/broadcast structure. It is passed only as a
 * single HTTP request body to a specific configured endpoint, mirroring
 * how the API Gateway treats an unconfigured/unreachable downstream —
 * never logged, never persisted by this service beyond the request.
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
  expiresAt: string;
}

export interface PhoneOtpRequestedEvent {
  type: 'PhoneOtpRequested';
  requestId: string;
  userId: string;
  phone: string;
  otp: string;
  expiresAt: string;
}

export interface PasswordResetRequestedEvent {
  type: 'PasswordResetRequested';
  requestId: string;
  userId: string;
  email: string;
  resetToken: string;
  expiresAt: string;
}

export type NotificationEvent =
  | EmailVerificationRequestedEvent
  | PhoneOtpRequestedEvent
  | PasswordResetRequestedEvent;

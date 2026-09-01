import type { NotificationEvent } from './events.js';

export interface NotificationHttpRequest {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Maps an internal NotificationEvent to the exact path + body
 * servora-notification documents (docs/api.md) for each of its three
 * resource-oriented endpoints. Pure and side-effect-free so the mapping
 * itself is unit-testable without a network call.
 */
export function toNotificationHttpRequest(event: NotificationEvent): NotificationHttpRequest {
  switch (event.type) {
    case 'EmailVerificationRequested':
      return {
        path: '/internal/v1/notifications/email-verification',
        body: { userId: event.userId, email: event.email, verificationToken: event.verificationToken },
      };
    case 'PasswordResetRequested':
      return {
        path: '/internal/v1/notifications/password-reset',
        body: { userId: event.userId, email: event.email, resetToken: event.resetToken },
      };
    case 'PhoneOtpRequested':
      return {
        path: '/internal/v1/notifications/phone-otp',
        body: { userId: event.userId, phone: event.phone, otp: event.otp, expiresInSeconds: event.expiresInSeconds },
      };
  }
}

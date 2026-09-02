import type { NotificationEvent } from './events.js';

export interface NotificationHttpRequest {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Maps an internal NotificationEvent to the exact path + body. Three cases
 * (email-verification, password-reset, phone-otp) match
 * servora-notification's documented, CONFIRMED endpoints (docs/api.md).
 * The other two (account-created, auth-login) are PROPOSED — paths chosen
 * to match that same resource-oriented, kebab-case, type-less-body
 * convention, but servora-notification does not implement them yet (see
 * events.ts and README.md "Auth/account notification events"). Pure and
 * side-effect-free so the mapping itself is unit-testable without a
 * network call.
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
    case 'AccountCreated':
      return {
        path: '/internal/v1/notifications/account-created',
        body: {
          userId: event.userId,
          email: event.email,
          authenticationMethod: event.authenticationMethod,
          emailVerified: event.emailVerified,
        },
      };
    case 'AuthLogin':
      return {
        path: '/internal/v1/notifications/auth-login',
        body: { userId: event.userId, email: event.email, authenticationMethod: event.authenticationMethod },
      };
  }
}

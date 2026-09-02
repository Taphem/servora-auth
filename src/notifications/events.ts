/**
 * Notification-delivery contract. Three of the five event types below
 * (email verification, password reset, phone OTP) are CONFIRMED against
 * the deployed servora-notification service (see
 * servora-notification/docs/api.md and docs/integration.md) — real,
 * resource-oriented internal endpoints under `/internal/v1/notifications/*`,
 * each requiring `x-servora-internal-key`. The other two
 * (AccountCreated, AuthLogin) are PROPOSED: servora-notification does not
 * document or implement `account-created`/`auth-login` endpoints yet, and
 * this repository does not modify that one — see notificationRequest.ts
 * and README.md "Auth/account notification events" for the full
 * rationale, the exact proposed paths/bodies, and what happens today when
 * servora-notification doesn't recognize them (a safely-swallowed 404,
 * same as any other rejected/unreachable notification call — see
 * HttpNotificationPublisher.ts).
 *
 * `type` here is an internal TypeScript discriminator only — it is never
 * sent in the outbound JSON body (see notificationRequest.ts, which maps
 * each event to the exact path + body). `requestId` is likewise
 * internal-only, sent as the `x-request-id` header rather than a body
 * field, for tracing continuity with that service's own request-ID-bearing
 * error envelope.
 *
 * Deliberately excluded from every request body: anything not in
 * servora-notification's documented (or, for the two proposed events,
 * intentionally minimal) schema. The raw token/OTP is passed once,
 * directly in the body of a single authenticated internal call — never
 * logged (see HttpNotificationPublisher.ts), never placed in a durable/
 * broadcast structure, never persisted by this service beyond the request.
 * Passwords, password hashes, Google tokens, and session tokens are never
 * part of any event payload.
 */

export type NotificationEventType =
  | 'EmailVerificationRequested'
  | 'PhoneOtpRequested'
  | 'PasswordResetRequested'
  | 'AccountCreated'
  | 'AuthLogin';

/** How the account/session was authenticated — carried on the two PROPOSED events below. */
export type AuthenticationMethod = 'password' | 'google';

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

/**
 * PROPOSED. Published exactly once per account, immediately after a new
 * Servora account is created (password registration or a brand-new Google
 * identity) — never on a subsequent login. `emailVerified` reflects the
 * account's actual state at creation time (`true` only for Google, whose
 * email is already server-verified; always `false` for a fresh password
 * account) so servora-notification can send an accurate welcome email
 * that never implies a password account's email is verified when it
 * isn't. This is deliberately separate from `EmailVerificationRequested`
 * — registration still sends that one too for a password account; this
 * event is additional, not a replacement.
 */
export interface AccountCreatedEvent {
  type: 'AccountCreated';
  requestId: string;
  userId: string;
  email: string;
  authenticationMethod: AuthenticationMethod;
  emailVerified: boolean;
}

/**
 * PROPOSED. Published only after a genuinely successful authentication
 * (password login, or Google authentication resolving to an *existing*
 * account) — never for a failed attempt, and never for account creation
 * (that gets AccountCreated instead, not both). Critically, never
 * published for `GET /api/v1/auth/session` or any other read of session
 * state — see routes/v1/auth/session.ts, which never touches
 * notificationPublisher at all.
 */
export interface AuthLoginEvent {
  type: 'AuthLogin';
  requestId: string;
  userId: string;
  email: string;
  authenticationMethod: AuthenticationMethod;
}

export type NotificationEvent =
  | EmailVerificationRequestedEvent
  | PhoneOtpRequestedEvent
  | PasswordResetRequestedEvent
  | AccountCreatedEvent
  | AuthLoginEvent;

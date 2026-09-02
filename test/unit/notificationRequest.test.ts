import { describe, expect, it } from 'vitest';
import { toNotificationHttpRequest } from '../../src/notifications/notificationRequest.js';
import type {
  AccountCreatedEvent,
  AuthLoginEvent,
  EmailVerificationRequestedEvent,
  PasswordResetRequestedEvent,
  PhoneOtpRequestedEvent,
} from '../../src/notifications/events.js';

describe('toNotificationHttpRequest', () => {
  it('maps EmailVerificationRequested to the documented path and exact body shape', () => {
    const event: EmailVerificationRequestedEvent = {
      type: 'EmailVerificationRequested',
      requestId: 'req-1',
      userId: 'user-1',
      email: 'alice@example.com',
      verificationToken: 'raw-token-value',
    };

    const { path, body } = toNotificationHttpRequest(event);

    expect(path).toBe('/internal/v1/notifications/email-verification');
    expect(body).toEqual({ userId: 'user-1', email: 'alice@example.com', verificationToken: 'raw-token-value' });
    // Internal-only fields (type, requestId) must never leak into the wire body.
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('requestId');
  });

  it('maps PasswordResetRequested to the documented path and exact body shape', () => {
    const event: PasswordResetRequestedEvent = {
      type: 'PasswordResetRequested',
      requestId: 'req-2',
      userId: 'user-2',
      email: 'bob@example.com',
      resetToken: 'raw-reset-token',
    };

    const { path, body } = toNotificationHttpRequest(event);

    expect(path).toBe('/internal/v1/notifications/password-reset');
    expect(body).toEqual({ userId: 'user-2', email: 'bob@example.com', resetToken: 'raw-reset-token' });
  });

  it('maps PhoneOtpRequested to the documented path and exact body shape, using expiresInSeconds not expiresAt', () => {
    const event: PhoneOtpRequestedEvent = {
      type: 'PhoneOtpRequested',
      requestId: 'req-3',
      userId: 'user-3',
      phone: '+14155551234',
      otp: '123456',
      expiresInSeconds: 300,
    };

    const { path, body } = toNotificationHttpRequest(event);

    expect(path).toBe('/internal/v1/notifications/phone-otp');
    expect(body).toEqual({ userId: 'user-3', phone: '+14155551234', otp: '123456', expiresInSeconds: 300 });
    expect(body).not.toHaveProperty('expiresAt');
  });

  it('maps AccountCreated (PROPOSED) to the expected path and exact body shape', () => {
    const event: AccountCreatedEvent = {
      type: 'AccountCreated',
      requestId: 'req-4',
      userId: 'user-4',
      email: 'dana@example.com',
      authenticationMethod: 'password',
      emailVerified: false,
    };

    const { path, body } = toNotificationHttpRequest(event);

    expect(path).toBe('/internal/v1/notifications/account-created');
    expect(body).toEqual({
      userId: 'user-4',
      email: 'dana@example.com',
      authenticationMethod: 'password',
      emailVerified: false,
    });
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('requestId');
  });

  it('maps a Google AccountCreated event with emailVerified: true', () => {
    const event: AccountCreatedEvent = {
      type: 'AccountCreated',
      requestId: 'req-5',
      userId: 'user-5',
      email: 'erin@example.com',
      authenticationMethod: 'google',
      emailVerified: true,
    };

    const { body } = toNotificationHttpRequest(event);

    expect(body).toEqual({ userId: 'user-5', email: 'erin@example.com', authenticationMethod: 'google', emailVerified: true });
  });

  it('maps AuthLogin (PROPOSED) to the expected path and exact body shape', () => {
    const event: AuthLoginEvent = {
      type: 'AuthLogin',
      requestId: 'req-6',
      userId: 'user-6',
      email: 'frank@example.com',
      authenticationMethod: 'password',
    };

    const { path, body } = toNotificationHttpRequest(event);

    expect(path).toBe('/internal/v1/notifications/auth-login');
    expect(body).toEqual({ userId: 'user-6', email: 'frank@example.com', authenticationMethod: 'password' });
    // No password/credential material of any kind belongs in this event.
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('credential');
  });
});

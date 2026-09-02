import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock factory below (itself hoisted above all imports by
// vitest) can reference it. Only Google's network/crypto verification call
// is mocked — everything downstream (account resolution, session
// creation, cookie) runs for real against the test Postgres/Redis, exactly
// as it would in production.
const { verifyIdTokenMock } = vi.hoisted(() => ({ verifyIdTokenMock: vi.fn() }));

vi.mock('google-auth-library', () => ({
  // Must be a real constructor function, not an arrow function — the
  // application code calls `new OAuth2Client(clientId)`, and an arrow
  // function isn't constructible (throws "is not a constructor").
  OAuth2Client: vi.fn().mockImplementation(function MockOAuth2Client(this: { verifyIdToken: typeof verifyIdTokenMock }) {
    this.verifyIdToken = verifyIdTokenMock;
  }),
}));

import { buildTestApp, flushRedis, resetDatabase, type TestApp } from '../helpers/buildTestApp.js';
import { getCookieValue, isInfraAvailable } from './helpers.js';

const GOOGLE_TEST_CLIENT_ID = 'google-test-client-id.apps.googleusercontent.com';

function mockGooglePayload(payload: { sub?: unknown; email?: unknown; email_verified?: unknown } | null) {
  verifyIdTokenMock.mockResolvedValueOnce({ getPayload: () => payload });
}

function mockGoogleRejection(message: string) {
  verifyIdTokenMock.mockRejectedValueOnce(new Error(message));
}

describe.skipIf(!isInfraAvailable())('POST /api/v1/auth/google (ID-token "Continue with Google")', () => {
  let testApp: TestApp;

  beforeAll(() => {
    testApp = buildTestApp({ GOOGLE_CLIENT_ID: GOOGLE_TEST_CLIENT_ID });
  });

  afterEach(async () => {
    await resetDatabase(testApp.ctx);
    await flushRedis(testApp.ctx);
    testApp.notifications.clear();
    verifyIdTokenMock.mockReset();
  });

  afterAll(async () => {
    await testApp.close();
  });

  async function postGoogle(credential?: string) {
    return testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: credential === undefined ? {} : { credential },
    });
  }

  it('rejects a missing credential', async () => {
    const response = await postGoogle(undefined);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('rejects an empty-string credential', async () => {
    const response = await postGoogle('');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an invalid/malformed Google token', async () => {
    mockGoogleRejection('Wrong number of segments in token');
    const response = await postGoogle('not-a-real-jwt');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('GOOGLE_OAUTH_FAILED');
  });

  it('rejects an expired Google token', async () => {
    mockGoogleRejection('Token used too late');
    const response = await postGoogle('expired.jwt.token');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('GOOGLE_OAUTH_FAILED');
  });

  it('rejects a token whose signature/issuer verification fails', async () => {
    mockGoogleRejection('Invalid token signature');
    const response = await postGoogle('bad-signature.jwt.token');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('GOOGLE_OAUTH_FAILED');
  });

  it('verifies the token against the configured GOOGLE_CLIENT_ID as the audience', async () => {
    mockGooglePayload({ sub: 'google-sub-audience-check', email: 'audience-check@example.com', email_verified: true });
    await postGoogle('some.jwt.token');

    expect(verifyIdTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: 'some.jwt.token', audience: GOOGLE_TEST_CLIENT_ID }),
    );
  });

  it('rejects a verified token with no subject claim', async () => {
    mockGooglePayload({ email: 'no-sub@example.com', email_verified: true });
    const response = await postGoogle('valid-shape.jwt.token');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('GOOGLE_OAUTH_FAILED');
  });

  it('rejects a verified token with no email claim', async () => {
    mockGooglePayload({ sub: 'google-sub-no-email', email_verified: true });
    const response = await postGoogle('valid-shape.jwt.token');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('GOOGLE_OAUTH_FAILED');
  });

  it('rejects a new (unlinked) identity whose email is not verified by Google', async () => {
    mockGooglePayload({ sub: 'google-sub-unverified', email: 'unverified@example.com', email_verified: false });
    const response = await postGoogle('valid-shape.jwt.token');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('GOOGLE_OAUTH_FAILED');

    const row = await testApp.ctx.pool.query('SELECT id FROM users WHERE email = $1', ['unverified@example.com']);
    expect(row.rows).toHaveLength(0);
  });

  it('creates a new CUSTOMER account for a brand-new verified Google identity and logs them in', async () => {
    mockGooglePayload({ sub: 'google-sub-new-user', email: 'new-google-user@example.com', email_verified: true });
    const response = await postGoogle('valid.jwt.token');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      userId: body.userId,
      email: 'new-google-user@example.com',
      role: 'CUSTOMER',
      emailVerified: true,
      phoneVerified: false,
    });

    const sessionCookie = getCookieValue(response, testApp.ctx.env.SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeTruthy();

    const userRow = await testApp.ctx.pool.query(
      'SELECT phone, phone_verified_at, password_hash, email_verified_at FROM users WHERE id = $1',
      [body.userId],
    );
    expect(userRow.rows[0].phone).toBeNull();
    expect(userRow.rows[0].phone_verified_at).toBeNull();
    expect(userRow.rows[0].password_hash).toBeNull();
    expect(userRow.rows[0].email_verified_at).not.toBeNull();

    const identityRow = await testApp.ctx.pool.query(
      'SELECT provider, provider_subject_id FROM oauth_identities WHERE user_id = $1',
      [body.userId],
    );
    expect(identityRow.rows).toEqual([{ provider: 'google', provider_subject_id: 'google-sub-new-user' }]);
  });

  it('does not send a phone OTP or require a phone for a new Google user', async () => {
    mockGooglePayload({ sub: 'google-sub-no-otp', email: 'no-otp-check@example.com', email_verified: true });
    await postGoogle('valid.jwt.token');
    expect(testApp.notifications.events).toHaveLength(0);
  });

  it('authenticates (not duplicates) an already-linked Google identity on a second call', async () => {
    mockGooglePayload({ sub: 'google-sub-repeat', email: 'repeat-login@example.com', email_verified: true });
    const first = await postGoogle('token-1');
    expect(first.statusCode).toBe(200);
    const firstUserId = first.json().userId;

    mockGooglePayload({ sub: 'google-sub-repeat', email: 'repeat-login@example.com', email_verified: true });
    const second = await postGoogle('token-2');
    expect(second.statusCode).toBe(200);
    expect(second.json().userId).toBe(firstUserId);

    const users = await testApp.ctx.pool.query('SELECT id FROM users WHERE email = $1', ['repeat-login@example.com']);
    expect(users.rows).toHaveLength(1);
    const identities = await testApp.ctx.pool.query(
      'SELECT id FROM oauth_identities WHERE provider = $1 AND provider_subject_id = $2',
      ['google', 'google-sub-repeat'],
    );
    expect(identities.rows).toHaveLength(1);
  });

  it('behaves identically regardless of which page the button was conceptually clicked from — same call, same outcome', async () => {
    // The endpoint takes no mode/context field at all (see schemas/auth.ts
    // googleAuthenticateBodySchema: only `credential`), so "from Signup" vs
    // "from Login" cannot be represented in the request — this test simply
    // documents that two calls with a brand-new identity and with an
    // already-linked identity both succeed via the exact same contract.
    mockGooglePayload({ sub: 'google-sub-modeless-new', email: 'modeless-new@example.com', email_verified: true });
    const newIdentity = await postGoogle('token-new');
    expect(newIdentity.statusCode).toBe(200);

    mockGooglePayload({ sub: 'google-sub-modeless-new', email: 'modeless-new@example.com', email_verified: true });
    const existingIdentity = await postGoogle('token-existing');
    expect(existingIdentity.statusCode).toBe(200);
    expect(existingIdentity.json().userId).toBe(newIdentity.json().userId);
  });

  it('safely links a verified Google identity to an existing email/password account instead of duplicating it', async () => {
    const registerResponse = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'password-first@example.com', password: 'correct-horse-battery' },
    });
    expect(registerResponse.statusCode).toBe(201);
    const existingUserId = registerResponse.json().userId;

    mockGooglePayload({ sub: 'google-sub-link-to-password', email: 'password-first@example.com', email_verified: true });
    const googleResponse = await postGoogle('link-token');

    expect(googleResponse.statusCode).toBe(200);
    expect(googleResponse.json().userId).toBe(existingUserId);
    // No signup-style "already exists" error — the existing account is authenticated instead.
    expect(googleResponse.json().error).toBeUndefined();

    const users = await testApp.ctx.pool.query('SELECT id FROM users WHERE email = $1', ['password-first@example.com']);
    expect(users.rows).toHaveLength(1);

    const identityRow = await testApp.ctx.pool.query(
      'SELECT provider_subject_id FROM oauth_identities WHERE user_id = $1',
      [existingUserId],
    );
    expect(identityRow.rows).toEqual([{ provider_subject_id: 'google-sub-link-to-password' }]);

    // Google's verified email establishes Servora email verification too.
    const emailVerifiedRow = await testApp.ctx.pool.query('SELECT email_verified_at FROM users WHERE id = $1', [existingUserId]);
    expect(emailVerifiedRow.rows[0].email_verified_at).not.toBeNull();
  });

  it('sets the session cookie with the same attributes as normal login', async () => {
    mockGooglePayload({ sub: 'google-sub-cookie-check', email: 'cookie-check@example.com', email_verified: true });
    const response = await postGoogle('cookie-token');

    const setCookieHeader = response.headers['set-cookie'];
    const cookieString = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(cookieString).toContain(`${testApp.ctx.env.SESSION_COOKIE_NAME}=`);
    expect(cookieString?.toLowerCase()).toContain('httponly');
    expect(cookieString?.toLowerCase()).toContain('samesite=lax');
    expect(cookieString?.toLowerCase()).toContain('path=/');
  });

  it('manual email/password registration with an email already linked to a Google account still returns the normal duplicate-email error', async () => {
    mockGooglePayload({ sub: 'google-sub-blocks-manual-signup', email: 'google-first@example.com', email_verified: true });
    await postGoogle('google-first-token');

    const manualRegister = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'google-first@example.com', password: 'another-password-1' },
    });

    // Existing registration behavior is unchanged — never silently
    // converted into a Google login just because a Google identity with
    // that email already exists.
    expect(manualRegister.statusCode).toBe(409);
    expect(manualRegister.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('returns 503 when Google is not configured', async () => {
    const unconfiguredApp = buildTestApp({ GOOGLE_CLIENT_ID: '' });
    try {
      const response = await unconfiguredApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/google',
        payload: { credential: 'anything' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('GOOGLE_OAUTH_NOT_CONFIGURED');
    } finally {
      await unconfiguredApp.close();
    }
  });
});

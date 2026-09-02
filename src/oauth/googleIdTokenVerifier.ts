import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import type { GoogleIdentity } from './googleClient.js';

/**
 * Verifies a Google ID token credential obtained *directly* by the
 * frontend (Google Identity Services "Sign in with Google" button / One
 * Tap) — a bare JWT handed to the browser with no authorization-code
 * exchange involved. This is a different credential shape from
 * oauth/googleClient.ts's authorization-code redirect flow
 * (google/start + google/callback), which is unchanged and still used for
 * that flow.
 *
 * google-auth-library (Google's own official library for exactly this
 * credential shape) is used rather than repurposing openid-client here:
 * openid-client's public API models ID-token verification as part of a
 * code exchange (authorizationCodeGrant) or the OAuth2 "implicit" response
 * flow (implicitAuthentication, which expects the token embedded in a URL
 * fragment and mandates nonce handling) — neither fits "verify this bare
 * JWT the frontend already has," so this is a genuinely different
 * credential format needing its own verification call, not a competing
 * mechanism for the same one. Both ultimately verify against the same
 * configured GOOGLE_CLIENT_ID as the audience.
 *
 * verifyIdToken performs real cryptographic verification: signature
 * against Google's published JWKS, issuer, audience, and expiration — not
 * a mock. Any failure (malformed, expired, wrong audience/issuer, bad
 * signature) throws and is mapped to a single generic error here,
 * matching the existing redirect flow's error-handling convention
 * (oauth/googleClient.ts's completeGoogleLogin) of not leaking which
 * specific check failed.
 */
export async function verifyGoogleIdToken(clientId: string, credential: string): Promise<GoogleIdentity> {
  const client = new OAuth2Client(clientId);

  let payload: { sub: string; email?: string; email_verified?: boolean } | undefined;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch (error) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCode.GOOGLE_OAUTH_FAILED,
      message: 'Google credential could not be verified.',
      cause: error,
    });
  }

  if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0 || typeof payload.email !== 'string') {
    throw new AppError({
      statusCode: 401,
      code: ErrorCode.GOOGLE_OAUTH_FAILED,
      message: 'Google did not return a valid identity.',
    });
  }

  return {
    subject: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
  };
}

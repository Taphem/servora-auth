import * as oidc from 'openid-client';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import type { RedisClient } from '../redis/client.js';
import { consumeOAuthState, storeOAuthState } from './googleOAuthState.js';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
}

let configCache: Promise<oidc.Configuration> | undefined;

async function getConfig(options: GoogleOAuthConfig): Promise<oidc.Configuration> {
  configCache ??= oidc.discovery(new URL('https://accounts.google.com'), options.clientId, options.clientSecret);
  return configCache;
}

/** Builds the Google authorization redirect URL and persists PKCE/nonce state in Redis (single-use, short TTL). */
export async function buildGoogleAuthorizationUrl(options: GoogleOAuthConfig, redis: RedisClient): Promise<string> {
  const config = await getConfig(options);

  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  await storeOAuthState(redis, state, { codeVerifier, nonce });

  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: options.redirectUri,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  return url.href;
}

/**
 * Completes the callback: validates state/PKCE/nonce, exchanges the code,
 * and verifies the ID token against Google's discovery document — genuine
 * OpenID Connect, not a mock.
 */
export async function completeGoogleLogin(
  options: GoogleOAuthConfig,
  redis: RedisClient,
  callbackUrl: URL,
): Promise<GoogleIdentity> {
  const state = callbackUrl.searchParams.get('state');
  if (!state) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCode.OAUTH_STATE_INVALID,
      message: 'Missing OAuth state parameter.',
    });
  }

  const stored = await consumeOAuthState(redis, state);
  if (!stored) {
    throw new AppError({
      statusCode: 400,
      code: ErrorCode.OAUTH_STATE_INVALID,
      message: 'OAuth state is invalid, expired, or already used.',
    });
  }

  const config = await getConfig(options);

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: stored.codeVerifier,
      expectedState: state,
      expectedNonce: stored.nonce,
    });
  } catch (error) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCode.GOOGLE_OAUTH_FAILED,
      message: 'Google authentication failed.',
      cause: error,
    });
  }

  const claims = tokens.claims();
  const subject = claims?.['sub'];
  const email = claims?.['email'];

  if (typeof subject !== 'string' || typeof email !== 'string') {
    throw new AppError({
      statusCode: 401,
      code: ErrorCode.GOOGLE_OAUTH_FAILED,
      message: 'Google did not return a valid identity.',
    });
  }

  return {
    subject,
    email,
    emailVerified: claims?.['email_verified'] === true,
  };
}

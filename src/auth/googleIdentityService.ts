import type { DbPool } from '../db/pool.js';
import { findOAuthIdentity, insertOAuthIdentity } from '../db/queries/oauthIdentities.js';
import { findUserByEmail, findUserById, insertUser, markEmailVerified } from '../db/queries/users.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import type { User } from '../types/domain.js';
import type { GoogleIdentity } from '../oauth/googleClient.js';

const GOOGLE_PROVIDER = 'google';

export interface ResolvedGoogleUser {
  user: User;
  /** True only when this call just created the account — callers use this to fire AccountCreated vs. AuthLogin (never both); see notifications/events.ts. */
  isNewAccount: boolean;
}

/**
 * Resolves a verified Google identity to a Servora user: an existing
 * linked account, an existing password account with a matching *verified*
 * Google email (auto-linked — safe because Google's email_verified claim
 * is trustworthy), or a brand-new Google-only account. Per the approved
 * design, a new/linked Google account inherits email verification from
 * Google but still requires separate phone verification before the
 * account is "ready" — this function never touches phone_verified_at.
 */
export async function resolveOrCreateUserForGoogleIdentity(pool: DbPool, identity: GoogleIdentity): Promise<ResolvedGoogleUser> {
  const existingLink = await findOAuthIdentity(pool, GOOGLE_PROVIDER, identity.subject);
  if (existingLink) {
    const user = await findUserById(pool, existingLink.userId);
    if (!user) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCode.GOOGLE_OAUTH_FAILED,
        message: 'Google authentication failed.',
      });
    }
    return { user, isNewAccount: false };
  }

  if (!identity.emailVerified) {
    throw new AppError({
      statusCode: 401,
      code: ErrorCode.GOOGLE_OAUTH_FAILED,
      message: 'Google did not report a verified email for this account.',
    });
  }

  const existingUser = await findUserByEmail(pool, identity.email);
  if (existingUser) {
    await insertOAuthIdentity(pool, {
      userId: existingUser.id,
      provider: GOOGLE_PROVIDER,
      providerSubjectId: identity.subject,
    });
    if (!existingUser.emailVerifiedAt) {
      await markEmailVerified(pool, existingUser.id);
    }
    return {
      user: { ...existingUser, emailVerifiedAt: existingUser.emailVerifiedAt ?? new Date() },
      isNewAccount: false,
    };
  }

  const newUser = await insertUser(pool, {
    email: identity.email,
    phone: null,
    passwordHash: null,
    role: 'CUSTOMER',
    emailVerifiedAt: new Date(),
  });
  await insertOAuthIdentity(pool, {
    userId: newUser.id,
    provider: GOOGLE_PROVIDER,
    providerSubjectId: identity.subject,
  });
  return { user: newUser, isNewAccount: true };
}

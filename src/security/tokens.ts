import { createHash, randomBytes } from 'node:crypto';

/**
 * Session tokens, email-verification tokens and password-reset tokens are
 * all high-entropy random values, not user-chosen secrets — a fast
 * cryptographic hash (SHA-256) is the correct storage mechanism for them
 * (unlike passwords, which need a slow, salted KDF). This keeps
 * token-lookup a simple indexed equality query.
 */

export function generateSecureToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

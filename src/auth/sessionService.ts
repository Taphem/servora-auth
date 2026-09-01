import type { DbPool } from '../db/pool.js';
import { findActiveSessionByTokenHash, insertSession, revokeSessionByTokenHash } from '../db/queries/sessions.js';
import { findUserById } from '../db/queries/users.js';
import { generateSecureToken, hashToken } from '../security/tokens.js';
import type { Session, User } from '../types/domain.js';

export interface CreateSessionParams {
  userId: string;
  ttlSeconds: number;
  userAgent: string | null;
  ip: string | null;
}

export interface CreatedSession {
  session: Session;
  rawToken: string;
}

export async function createSession(pool: DbPool, params: CreateSessionParams): Promise<CreatedSession> {
  const rawToken = generateSecureToken(32);
  const session = await insertSession(pool, {
    userId: params.userId,
    sessionTokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + params.ttlSeconds * 1000),
    userAgent: params.userAgent,
    ip: params.ip,
  });
  return { session, rawToken };
}

export interface VerifiedSession {
  session: Session;
  user: User;
}

/** Resolves a raw session token to its session + user, or undefined if invalid/expired/revoked/orphaned. */
export async function verifySessionToken(pool: DbPool, rawToken: string): Promise<VerifiedSession | undefined> {
  const session = await findActiveSessionByTokenHash(pool, hashToken(rawToken));
  if (!session) {
    return undefined;
  }

  const user = await findUserById(pool, session.userId);
  if (!user || user.status !== 'ACTIVE') {
    return undefined;
  }

  return { session, user };
}

export async function revokeSession(pool: DbPool, rawToken: string): Promise<void> {
  await revokeSessionByTokenHash(pool, hashToken(rawToken));
}

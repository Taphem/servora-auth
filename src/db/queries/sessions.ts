import type { DbPool } from '../pool.js';
import { mapSessionRow } from '../rowMappers.js';
import type { Session } from '../../types/domain.js';

export async function insertSession(
  pool: DbPool,
  params: {
    userId: string;
    sessionTokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
    rotatedFrom?: string | null;
  },
): Promise<Session> {
  const result = await pool.query(
    `INSERT INTO sessions (user_id, session_token_hash, expires_at, user_agent, ip, rotated_from)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [params.userId, params.sessionTokenHash, params.expiresAt, params.userAgent, params.ip, params.rotatedFrom ?? null],
  );
  return mapSessionRow(result.rows[0]);
}

export async function findActiveSessionByTokenHash(pool: DbPool, tokenHash: string): Promise<Session | undefined> {
  const result = await pool.query(
    `SELECT * FROM sessions
     WHERE session_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] ? mapSessionRow(result.rows[0]) : undefined;
}

export async function revokeSessionByTokenHash(pool: DbPool, tokenHash: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE session_token_hash = $1 AND revoked_at IS NULL', [
    tokenHash,
  ]);
}

export async function revokeAllSessionsForUser(pool: DbPool, userId: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

import type { DbPool } from '../pool.js';
import { mapEmailVerificationTokenRow } from '../rowMappers.js';
import type { EmailVerificationToken } from '../../types/domain.js';

export async function insertEmailVerificationToken(
  pool: DbPool,
  params: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<EmailVerificationToken> {
  const result = await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.userId, params.tokenHash, params.expiresAt],
  );
  return mapEmailVerificationTokenRow(result.rows[0]);
}

export async function findValidEmailVerificationTokenByHash(
  pool: DbPool,
  tokenHash: string,
): Promise<EmailVerificationToken | undefined> {
  const result = await pool.query(
    `SELECT * FROM email_verification_tokens
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] ? mapEmailVerificationTokenRow(result.rows[0]) : undefined;
}

export async function consumeEmailVerificationToken(pool: DbPool, id: string): Promise<void> {
  await pool.query('UPDATE email_verification_tokens SET consumed_at = now() WHERE id = $1', [id]);
}

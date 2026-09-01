import type { DbPool } from '../pool.js';
import { mapPasswordResetTokenRow } from '../rowMappers.js';
import type { PasswordResetToken } from '../../types/domain.js';

export async function insertPasswordResetToken(
  pool: DbPool,
  params: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<PasswordResetToken> {
  const result = await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.userId, params.tokenHash, params.expiresAt],
  );
  return mapPasswordResetTokenRow(result.rows[0]);
}

export async function findValidPasswordResetTokenByHash(
  pool: DbPool,
  tokenHash: string,
): Promise<PasswordResetToken | undefined> {
  const result = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] ? mapPasswordResetTokenRow(result.rows[0]) : undefined;
}

export async function consumePasswordResetToken(pool: DbPool, id: string): Promise<void> {
  await pool.query('UPDATE password_reset_tokens SET consumed_at = now() WHERE id = $1', [id]);
}

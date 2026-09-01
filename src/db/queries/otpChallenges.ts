import type { DbPool } from '../pool.js';
import { mapOtpChallengeRow } from '../rowMappers.js';
import type { OtpChallenge } from '../../types/domain.js';

const PHONE_VERIFICATION_PURPOSE = 'PHONE_VERIFICATION';

export async function insertOtpChallenge(
  pool: DbPool,
  params: { userId: string; phone: string; otpHash: string; expiresAt: Date; maxAttempts: number },
): Promise<OtpChallenge> {
  const result = await pool.query(
    `INSERT INTO otp_challenges (user_id, phone, otp_hash, purpose, expires_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [params.userId, params.phone, params.otpHash, PHONE_VERIFICATION_PURPOSE, params.expiresAt, params.maxAttempts],
  );
  return mapOtpChallengeRow(result.rows[0]);
}

export async function findLatestActiveOtpChallenge(pool: DbPool, userId: string): Promise<OtpChallenge | undefined> {
  const result = await pool.query(
    `SELECT * FROM otp_challenges
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, PHONE_VERIFICATION_PURPOSE],
  );
  return result.rows[0] ? mapOtpChallengeRow(result.rows[0]) : undefined;
}

export async function findLatestOtpChallenge(pool: DbPool, userId: string): Promise<OtpChallenge | undefined> {
  const result = await pool.query(
    `SELECT * FROM otp_challenges
     WHERE user_id = $1 AND purpose = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, PHONE_VERIFICATION_PURPOSE],
  );
  return result.rows[0] ? mapOtpChallengeRow(result.rows[0]) : undefined;
}

export async function incrementOtpAttempts(pool: DbPool, id: string): Promise<void> {
  await pool.query('UPDATE otp_challenges SET attempt_count = attempt_count + 1 WHERE id = $1', [id]);
}

export async function consumeOtpChallenge(pool: DbPool, id: string): Promise<void> {
  await pool.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [id]);
}

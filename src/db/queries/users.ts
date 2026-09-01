import type { DbPool } from '../pool.js';
import { mapUserRow } from '../rowMappers.js';
import type { User, UserRole } from '../../types/domain.js';

export async function insertUser(
  pool: DbPool,
  params: { email: string; phone: string | null; passwordHash: string | null; role: UserRole; emailVerifiedAt: Date | null },
): Promise<User> {
  const result = await pool.query(
    `INSERT INTO users (email, phone, password_hash, role, email_verified_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.email, params.phone, params.passwordHash, params.role, params.emailVerifiedAt],
  );
  return mapUserRow(result.rows[0]);
}

export async function findUserByEmail(pool: DbPool, email: string): Promise<User | undefined> {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] ? mapUserRow(result.rows[0]) : undefined;
}

export async function findUserById(pool: DbPool, id: string): Promise<User | undefined> {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] ? mapUserRow(result.rows[0]) : undefined;
}

export async function findUserByPhone(pool: DbPool, phone: string): Promise<User | undefined> {
  const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  return result.rows[0] ? mapUserRow(result.rows[0]) : undefined;
}

export async function markEmailVerified(pool: DbPool, userId: string): Promise<void> {
  await pool.query('UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1', [userId]);
}

export async function markPhoneVerified(pool: DbPool, userId: string, phone: string): Promise<void> {
  await pool.query(
    'UPDATE users SET phone = $2, phone_verified_at = now(), updated_at = now() WHERE id = $1',
    [userId, phone],
  );
}

export async function updatePasswordHash(pool: DbPool, userId: string, passwordHash: string): Promise<void> {
  await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, passwordHash]);
}

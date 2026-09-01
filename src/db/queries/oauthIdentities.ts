import type { DbPool } from '../pool.js';
import { mapOAuthIdentityRow } from '../rowMappers.js';
import type { OAuthIdentity } from '../../types/domain.js';

export async function findOAuthIdentity(
  pool: DbPool,
  provider: string,
  providerSubjectId: string,
): Promise<OAuthIdentity | undefined> {
  const result = await pool.query(
    'SELECT * FROM oauth_identities WHERE provider = $1 AND provider_subject_id = $2',
    [provider, providerSubjectId],
  );
  return result.rows[0] ? mapOAuthIdentityRow(result.rows[0]) : undefined;
}

export async function insertOAuthIdentity(
  pool: DbPool,
  params: { userId: string; provider: string; providerSubjectId: string },
): Promise<OAuthIdentity> {
  const result = await pool.query(
    `INSERT INTO oauth_identities (user_id, provider, provider_subject_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.userId, params.provider, params.providerSubjectId],
  );
  return mapOAuthIdentityRow(result.rows[0]);
}

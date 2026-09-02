import type { Client } from 'pg';
import type { Redis } from 'ioredis';

/**
 * Core logic for the auth data reset command, factored out of the CLI
 * entrypoint (reset-auth-data.ts) so it can be exercised directly by
 * integration tests against a real Postgres/Redis instead of only via a
 * subprocess. No console I/O happens in here — the CLI wrapper is
 * responsible for printing the returned report.
 */

export const CONFIRM_PHRASE = 'DELETE-ALL-AUTH-DATA';
export const PRODUCTION_OVERRIDE_VALUE = 'I-UNDERSTAND-THIS-DELETES-PRODUCTION-DATA';
export const PRODUCTION_OVERRIDE_VAR = 'ALLOW_PRODUCTION_DESTRUCTIVE_RESET';

// Ordered children-first so deletion is FK-safe even without relying on the
// ON DELETE CASCADE already present on every user_id foreign key (that
// cascade exists in the schema independently of this script — it is not
// added or modified here). otp_challenges is included even though the
// application no longer writes to it (phone OTP challenges now live in
// Redis — see src/redis/otpChallenge.ts); the table was intentionally
// kept in the schema rather than dropped, so it's still cleaned here for
// completeness. Existence is checked at runtime regardless, so this
// script keeps working if that table is ever removed later.
export const TABLES_CHILDREN_FIRST = [
  'otp_challenges',
  'password_reset_tokens',
  'email_verification_tokens',
  'oauth_identities',
  'sessions',
  'users',
] as const;

// Every Redis key this service writes lives under one of these prefixes
// (see src/redis/rateLimiter.ts, cooldown.ts, oauth/googleOAuthState.ts,
// redis/otpChallenge.ts). Deletion is always by explicit SCAN+UNLINK of
// these named patterns — never FLUSHDB/FLUSHALL — so anything outside
// these namespaces is structurally impossible to delete here, even if
// this Redis instance ever ends up holding unrelated keys.
export const REDIS_KEY_PATTERNS: Record<string, string> = {
  'rate limit counters': 'ratelimit:*',
  'resend/OTP cooldowns': 'cooldown:*',
  'Google OAuth state': 'oauth:google:state:*',
  'phone OTP challenges': 'otp:phone:*',
};

export interface ResetOptions {
  execute: boolean;
  confirm: string | undefined;
  isProduction: boolean;
  productionOverride: string | undefined;
}

export type ResetOutcome = 'refused-production' | 'refused-not-confirmed' | 'dry-run' | 'executed';

export interface ResetReport {
  outcome: ResetOutcome;
  tableCountsBefore: Record<string, number>;
  redisGroupsBefore: Record<string, string[]>;
  sequences: string[];
  tableRowsDeleted?: Record<string, number>;
  redisKeysDeleted?: number;
  tableCountsAfter?: Record<string, number>;
  redisGroupsAfter?: Record<string, string[]>;
  verifiedClean?: boolean;
}

export async function getExistingTables(client: Client): Promise<Set<string>> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES_CHILDREN_FIRST],
  );
  return new Set(result.rows.map((row) => row.table_name));
}

export async function getTableCounts(client: Client, tables: Set<string>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES_CHILDREN_FIRST) {
    if (!tables.has(table)) {
      continue;
    }
    // Table names come only from the fixed, hardcoded TABLES_CHILDREN_FIRST
    // list above (checked against information_schema first) — never from
    // user input — so this is not a SQL-injection surface despite the
    // string interpolation.
    const result = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

export async function getSequences(client: Client): Promise<string[]> {
  const result = await client.query<{ sequence_name: string }>(
    `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'`,
  );
  return result.rows.map((row) => row.sequence_name);
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

export async function scanAuthRedisKeys(redis: Redis): Promise<Record<string, string[]>> {
  const groups: Record<string, string[]> = {};
  for (const [label, pattern] of Object.entries(REDIS_KEY_PATTERNS)) {
    groups[label] = await scanKeys(redis, pattern);
  }
  return groups;
}

async function deleteAllRows(client: Client, tables: Set<string>): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  await client.query('BEGIN');
  try {
    for (const table of TABLES_CHILDREN_FIRST) {
      if (!tables.has(table)) {
        continue;
      }
      const result = await client.query(`DELETE FROM ${table}`);
      deleted[table] = result.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return deleted;
}

async function deleteRedisKeys(redis: Redis, groups: Record<string, string[]>): Promise<number> {
  let deleted = 0;
  for (const keys of Object.values(groups)) {
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      if (chunk.length === 0) {
        continue;
      }
      // UNLINK, not DEL: non-blocking reclamation on the Redis server side.
      // Still an explicit, named list of keys — never FLUSHDB/FLUSHALL.
      deleted += await redis.unlink(...chunk);
    }
  }
  return deleted;
}

export async function runResetAuthData(pgClient: Client, redis: Redis, options: ResetOptions): Promise<ResetReport> {
  if (options.execute && options.isProduction && options.productionOverride !== PRODUCTION_OVERRIDE_VALUE) {
    return { outcome: 'refused-production', tableCountsBefore: {}, redisGroupsBefore: {}, sequences: [] };
  }

  if (options.execute && options.confirm !== CONFIRM_PHRASE) {
    return { outcome: 'refused-not-confirmed', tableCountsBefore: {}, redisGroupsBefore: {}, sequences: [] };
  }

  const existingTables = await getExistingTables(pgClient);
  const tableCountsBefore = await getTableCounts(pgClient, existingTables);
  const redisGroupsBefore = await scanAuthRedisKeys(redis);
  const sequences = await getSequences(pgClient);

  if (!options.execute) {
    return { outcome: 'dry-run', tableCountsBefore, redisGroupsBefore, sequences };
  }

  const tableRowsDeleted = await deleteAllRows(pgClient, existingTables);
  const redisKeysDeleted = await deleteRedisKeys(redis, redisGroupsBefore);

  const tableCountsAfter = await getTableCounts(pgClient, existingTables);
  const redisGroupsAfter = await scanAuthRedisKeys(redis);

  const remainingRows = Object.values(tableCountsAfter).reduce((sum, count) => sum + count, 0);
  const remainingRedisKeys = Object.values(redisGroupsAfter).reduce((sum, keys) => sum + keys.length, 0);

  return {
    outcome: 'executed',
    tableCountsBefore,
    redisGroupsBefore,
    sequences,
    tableRowsDeleted,
    redisKeysDeleted,
    tableCountsAfter,
    redisGroupsAfter,
    verifiedClean: remainingRows === 0 && remainingRedisKeys === 0,
  };
}

import { Client } from 'pg';
import { Redis } from 'ioredis';
import { loadEnv } from '../src/config/env.js';
import {
  CONFIRM_PHRASE,
  PRODUCTION_OVERRIDE_VALUE,
  PRODUCTION_OVERRIDE_VAR,
  REDIS_KEY_PATTERNS,
  TABLES_CHILDREN_FIRST,
  runResetAuthData,
  type ResetReport,
} from './resetAuthDataCore.js';

/**
 * Development/admin cleanup command — deletes ALL rows from every
 * auth-owned Postgres table and every auth-owned Redis key namespace,
 * while leaving the schema, migrations, indexes, constraints, and
 * infrastructure completely untouched. This is a deliberate full reset
 * (not test-data detection) per the explicit instruction that every
 * account currently in this database was created during development.
 *
 * Never run automatically. Never exposed as an HTTP endpoint. Defaults to
 * a dry run; destructive execution requires --execute AND an explicit
 * --confirm=DELETE-ALL-AUTH-DATA, and refuses to run at all against
 * NODE_ENV=production unless ALLOW_PRODUCTION_DESTRUCTIVE_RESET is set to
 * an exact, deliberately unwieldy override value.
 *
 * Usage:
 *   npm run reset-auth-data                                            # dry run (default)
 *   npm run reset-auth-data -- --dry-run                                # same, explicit
 *   npm run reset-auth-data -- --execute --confirm=DELETE-ALL-AUTH-DATA  # actually delete
 *
 * See scripts/resetAuthDataCore.ts for the actual deletion logic (also
 * exercised directly by test/integration/resetAuthData.test.ts).
 */

interface Args {
  execute: boolean;
  confirm: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const execute = argv.includes('--execute');
  const confirmArg = argv.find((arg) => arg.startsWith('--confirm='));
  return { execute, confirm: confirmArg?.slice('--confirm='.length) };
}

function maskConnectionString(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return '<unparseable connection string>';
  }
}

function printSection(title: string): void {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

function printTableCounts(title: string, counts: Record<string, number>): void {
  printSection(title);
  let total = 0;
  for (const table of TABLES_CHILDREN_FIRST) {
    if (!(table in counts)) {
      console.log(`  ${table}: (table does not exist — skipped)`);
      continue;
    }
    console.log(`  ${table}: ${counts[table]} row(s)`);
    total += counts[table] ?? 0;
  }
  console.log(`  TOTAL: ${total} row(s)`);
}

function printRedisGroups(title: string, groups: Record<string, string[]>): void {
  printSection(title);
  let total = 0;
  for (const [label, keys] of Object.entries(groups)) {
    console.log(`  ${label} (${REDIS_KEY_PATTERNS[label]}): ${keys.length} key(s)`);
    total += keys.length;
  }
  console.log(`  TOTAL: ${total} key(s)`);
}

function printReport(report: ResetReport): void {
  if (report.outcome === 'refused-production') {
    console.error(
      `\nRefusing to run: NODE_ENV=production. Set ${PRODUCTION_OVERRIDE_VAR}=${PRODUCTION_OVERRIDE_VALUE} ` +
        'if you are certain you intend to permanently delete all production auth data.',
    );
    process.exitCode = 1;
    return;
  }

  if (report.outcome === 'refused-not-confirmed') {
    console.error(
      `\nRefusing to execute: pass --confirm=${CONFIRM_PHRASE} to explicitly acknowledge this permanently ` +
        'deletes all rows in every auth table and every auth Redis key. Run without --execute for a dry run.',
    );
    process.exitCode = 1;
    return;
  }

  printTableCounts('Postgres — auth-owned tables', report.tableCountsBefore);
  printRedisGroups('Redis — auth-owned key namespaces', report.redisGroupsBefore);

  printSection('Sequences');
  if (report.sequences.length === 0) {
    console.log('  None — all primary keys are UUIDs (gen_random_uuid()). Nothing to reset.');
  } else {
    console.log(`  Found ${report.sequences.length} sequence(s): ${report.sequences.join(', ')} (not reset by this script).`);
  }

  if (report.outcome === 'dry-run') {
    console.log('\nDry run complete. No changes were made.');
    console.log(`Re-run with --execute --confirm=${CONFIRM_PHRASE} to actually delete the above.`);
    return;
  }

  printSection('Deleted from Postgres');
  for (const [table, count] of Object.entries(report.tableRowsDeleted ?? {})) {
    console.log(`  ${table}: deleted ${count} row(s)`);
  }

  printSection('Deleted from Redis');
  console.log(`  Deleted ${report.redisKeysDeleted ?? 0} key(s) total.`);

  printSection('Verification');
  const remainingRows = Object.values(report.tableCountsAfter ?? {}).reduce((sum, count) => sum + count, 0);
  if (remainingRows > 0) {
    console.error(`  FAILED: ${remainingRows} row(s) remain:`, report.tableCountsAfter);
    process.exitCode = 1;
  } else {
    console.log('  Postgres: verified zero rows remain in all auth tables.');
  }

  const remainingRedisKeys = Object.values(report.redisGroupsAfter ?? {}).reduce((sum, keys) => sum + keys.length, 0);
  if (remainingRedisKeys > 0) {
    console.error('  FAILED: auth-related Redis keys remain:', report.redisGroupsAfter);
    process.exitCode = 1;
  } else {
    console.log('  Redis: verified zero auth-related keys remain.');
  }

  console.log('\nSchema, migrations, indexes, and constraints were not modified.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();

  console.log('Servora Auth — auth data reset');
  console.log(`  Database: ${maskConnectionString(env.DATABASE_URL)}`);
  console.log(`  Redis:    ${maskConnectionString(env.REDIS_URL)}`);
  console.log(`  NODE_ENV: ${env.NODE_ENV}`);
  console.log(`  Mode:     ${args.execute ? 'EXECUTE (destructive)' : 'DRY RUN — no changes will be made'}`);

  if (args.execute && env.isProduction && process.env[PRODUCTION_OVERRIDE_VAR] === PRODUCTION_OVERRIDE_VALUE) {
    console.warn(`\n${PRODUCTION_OVERRIDE_VAR} override present — proceeding against a PRODUCTION environment.`);
  }

  const pgClient = new Client({ connectionString: env.DATABASE_URL });
  await pgClient.connect();
  const redis = new Redis(env.REDIS_URL);

  try {
    const report = await runResetAuthData(pgClient, redis, {
      execute: args.execute,
      confirm: args.confirm,
      isProduction: env.isProduction,
      productionOverride: process.env[PRODUCTION_OVERRIDE_VAR],
    });

    printReport(report);
  } finally {
    await pgClient.end();
    redis.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

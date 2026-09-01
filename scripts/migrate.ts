import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Minimal, dependency-free migration runner: applies numbered .sql files
 * from /migrations in order, tracking what's applied in schema_migrations.
 * No ORM — the database requirements are simple enough (six tables, plain
 * constraints/indexes) that a query builder would be unjustified weight.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    const { rows: applied } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const appliedIds = new Set(applied.map((row) => row.id));

    for (const file of files) {
      if (appliedIds.has(file)) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), 'utf-8');
      console.log(`Applying migration ${file}...`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    console.log('Migrations up to date.');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

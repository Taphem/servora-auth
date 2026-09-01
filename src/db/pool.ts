import { Pool } from 'pg';

export function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  return pool;
}

export type DbPool = Pool;

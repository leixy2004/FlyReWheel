import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';

export interface Queryable { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
export async function openPGliteDatabase(path?: string): Promise<Database> {
  const db = new PGlite(path);
  await db.waitReady;
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: fn => db.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
    exec: async sql => { await db.exec(sql); },
    close: () => db.close(),
  };
}
/** Explicit connection string only. Importing this module never connects or reads ambient credentials. */
export async function openPostgresDatabase(connectionString: string): Promise<Database> {
  if (!connectionString) throw new Error('PostgreSQL requires an explicit connection string');
  const pool = new Pool({ connectionString, max: 5 });
  const wrap = (client: Pool | PoolClient): Queryable => ({ query: async (sql, params) => { const result = await client.query(sql, params); return { rows: result.rows }; } });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(wrap(client)); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    exec: async sql => { await pool.query(sql); },
    close: () => pool.end(),
  };
}

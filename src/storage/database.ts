import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';

export interface Queryable { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** One pinned, exclusive transaction; query also accepts complete SQL migration files. */
  migrationTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
export async function openPGliteDatabase(path?: string): Promise<Database> {
  const db = new PGlite(path);
  await db.waitReady;
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: fn => db.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
    migrationTransaction: fn => db.transaction(tx => fn({
      query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => params === undefined
        ? { rows: ((await tx.exec(sql)).at(-1)?.rows ?? []) as T[] }
        : tx.query<T>(sql, params),
    })),
    exec: async sql => { await db.exec(sql); },
    close: () => db.close(),
  };
}
class PostgresDatabaseError extends Error {
  constructor() { super('PostgreSQL database operation failed; inspect secured database logs'); this.name = 'PostgresDatabaseError'; }
}
async function postgresOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { throw new PostgresDatabaseError(); }
}
/** Explicit connection string only. Importing this module never connects or reads ambient credentials.
 * Driver failures are redacted at this boundary; trusted domain callback errors keep their identity. */
export async function openPostgresDatabase(connectionString: string): Promise<Database> {
  if (!connectionString?.trim()) throw new Error('PostgreSQL requires an explicit connection string');
  let pool: Pool;
  try {
    pool = new Pool({ connectionString, max: 5 });
    pool.on('error', () => process.stderr.write('FlyReWheel PostgreSQL database error; inspect secured database logs\n'));
  } catch { throw new PostgresDatabaseError(); }
  const wrap = (client: Pool | PoolClient): Queryable => ({ query: async (sql, params) => {
    const result = await postgresOperation(() => client.query(sql, params)); return { rows: result.rows };
  } });
  const transaction = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      const client = await postgresOperation(() => pool.connect());
      let releaseError: Error | undefined;
      let failed = false, connectionFailed = false;
      // pg-pool's idle listener is removed while a client is checked out. Handle
      // disconnects between queries here so raw driver events cannot escape.
      const onClientError = () => { connectionFailed = true; };
      client.on('error', onClientError);
      const wrappedClient = wrap(client);
      const query = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        if (connectionFailed) throw new PostgresDatabaseError();
        const result = await wrappedClient.query<T>(sql, params);
        if (connectionFailed) throw new PostgresDatabaseError();
        return result;
      };
      try {
        await query('BEGIN');
        const result = await fn({ query });
        await query('COMMIT');
        return result;
      } catch (error) {
        failed = true;
        if (error instanceof PostgresDatabaseError || connectionFailed) releaseError = new PostgresDatabaseError();
        if (!connectionFailed) {
          try { await postgresOperation(() => client.query('ROLLBACK')); }
          catch { releaseError = new PostgresDatabaseError(); }
        }
        throw error;
      } finally {
        try {
          client.release(releaseError);
          // release restores the pool's idle listener before this listener leaves.
          client.off('error', onClientError);
        } catch { if (!failed) throw new PostgresDatabaseError(); }
      }
  };
  return {
    ...wrap(pool), transaction,
    migrationTransaction: fn => transaction(async tx => {
      // Transaction-scoped, waiting lock: no leaked session locks on pooled clients.
      // Keep this application-specific key stable across all future releases.
      await tx.query('SELECT pg_advisory_xact_lock(727413, 1)');
      return fn(tx);
    }),
    exec: async sql => { await postgresOperation(() => pool.query(sql)); },
    close: () => postgresOperation(() => pool.end()),
  };
}

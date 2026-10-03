import { QualEvoStore } from './store.js';

export interface DatabaseOptions { db?: string; postgres?: boolean }
export interface DatabaseSelectionPolicy { allowMemory?: boolean; postgresOnly?: boolean }
export type DatabaseSelection = { kind: 'pglite'; path?: string } | { kind: 'postgres'; connectionString: string };

/** No implicit production target: an ambient DATABASE_URL is ignored until PostgreSQL is selected. */
export function resolveDatabaseSelection(options: DatabaseOptions, environment: { DATABASE_URL?: string },
  policy: DatabaseSelectionPolicy = {}): DatabaseSelection {
  const hasLocal = options.db !== undefined;
  if (hasLocal && options.postgres) throw new Error('Choose exactly one database: --db <directory> or --postgres, never both');
  if (hasLocal) {
    if (policy.postgresOnly) throw new Error('Queue commands require --postgres with DATABASE_URL; --db is local domain storage only');
    if (!options.db?.trim()) throw new Error('--db requires a nonempty local PGlite directory');
    if (/^(?:memory|idb|opfs-ahp):\/\//i.test(options.db) || (options.db.startsWith('file://') && !options.db.slice(7).trim())) {
      throw new Error('--db requires a persistent local filesystem directory; memory/browser backends are not allowed');
    }
    return { kind: 'pglite', path: options.db };
  }
  if (!options.postgres) {
    if (policy.allowMemory && !policy.postgresOnly) return { kind: 'pglite' };
    throw new Error(policy.postgresOnly ? 'Choose --postgres with an explicitly configured DATABASE_URL for queue commands'
      : 'Choose exactly one database: --db <directory> or --postgres (requires DATABASE_URL)');
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString?.trim()) throw new Error('--postgres requires an explicitly configured DATABASE_URL');
  // Require the destination in the URL itself; do not let pg fall back to ambient PGHOST/PGDATABASE.
  // Validation errors deliberately never include the value (which may contain credentials).
  let target: URL, database: string;
  try { target = new URL(connectionString); database = decodeURI(target.pathname.slice(1)); }
  catch { throw new Error('DATABASE_URL must be a PostgreSQL URL with an explicit host and database'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname || !database.trim()
    || connectionString !== connectionString.trim() || target.hash) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL with an explicit host and database');
  }
  return { kind: 'postgres', connectionString };
}

export interface StoreOpeners {
  pglite(path?: string): Promise<QualEvoStore>;
  postgres(connectionString: string): Promise<QualEvoStore>;
}
/** Both targets use the same migrations, SQL store methods, identities and domain validation. */
export function openSelectedStore(selection: DatabaseSelection, openers: StoreOpeners = {
  pglite: path => QualEvoStore.openPGlite(path), postgres: connectionString => QualEvoStore.openPostgres(connectionString),
}): Promise<QualEvoStore> {
  return selection.kind === 'pglite' ? openers.pglite(selection.path) : openers.postgres(selection.connectionString);
}

import { Command } from 'commander';
import type { PgBoss } from 'pg-boss';
import { openQueue } from './jobs.js';
import { openSelectedStore, resolveDatabaseSelection, type DatabaseOptions, type DatabaseSelection, type DatabaseSelectionPolicy } from './storage/connection.js';

/** Validate before the action can acquire evidence, read input files or initialize storage. */
export function databaseCommand(parent: Command, name: string, policy: DatabaseSelectionPolicy = {}): Command {
  const command = parent.command(name).option('--postgres', 'Explicitly select PostgreSQL using DATABASE_URL; opening storage runs migrations');
  if (!policy.postgresOnly) command.option('--db <directory>', 'Persistent local PGlite directory; mutually exclusive with --postgres');
  if (policy.allowMemory) command.addHelpText('after', '\nWithout a database option, this command uses ephemeral in-memory PGlite. DATABASE_URL alone never selects PostgreSQL.');
  return command.hook('preAction', action => { resolveDatabaseSelection(action.opts(), process.env, policy); });
}
export function storeFor(options: DatabaseOptions, policy: DatabaseSelectionPolicy = {}) {
  return openSelectedStore(resolveDatabaseSelection(options, process.env, policy));
}
/** Resolve once and pass this same explicit destination to domain storage and the queue. */
export async function withSelectedQueue<T>(selection: DatabaseSelection, action: (boss: PgBoss) => Promise<T>): Promise<T> {
  if (selection.kind !== 'postgres') throw new Error('Queue commands require --postgres with DATABASE_URL');
  try {
    const boss = await openQueue({ connectionString: selection.connectionString });
    try { return await action(boss); }
    finally { await boss.stop({ graceful: true }); }
  } catch {
    // pg-boss errors can include credentials, endpoint names or query parameters.
    throw new Error('PostgreSQL queue operation failed; inspect secured database logs');
  }
}

import { openSelectedStore, resolveDatabaseSelection } from './storage/connection.js';
import { openQueue } from './jobs.js';
import { startWorkerService } from './worker-service.js';

async function startConfiguredWorker() {
  // Starting this PostgreSQL-only service is the explicit selection; never fall back to a local store.
  const selection = resolveDatabaseSelection({ postgres: true }, process.env, { postgresOnly: true });
  if (selection.kind !== 'postgres') throw new Error('Worker requires PostgreSQL');
  const store = await openSelectedStore(selection);
  let boss;
  try { boss = await openQueue({ connectionString: selection.connectionString }); }
  catch (error) { await store.close(); throw error; }
  // No ambient runtime module loading, fixture fallback, credentials or backend
  // selection. A reviewed deployment bootstrap must inject startWorkerService's
  // application dependencies before workspace execution can become configured.
  const service = await startWorkerService({ store, boss });
  const shutdown = () => { void service.stop().catch(() => { process.stderr.write('Worker shutdown failed; inspect secured operational logs\n'); process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
// Build/runtime import smoke without opening a database, service, socket or model.
if (process.argv.slice(2).includes('--check')) {
  process.stdout.write(JSON.stringify({ status: 'checked', queues: ['replay', 'application'], applicationRuntime: 'blocked',
    reason: 'Trusted workspace resolver/backend bootstrap and production lifecycle authority are not configured' }) + '\n');
} else {
  await startConfiguredWorker().catch(() => {
    process.stderr.write('Worker startup failed; check explicit DATABASE_URL configuration and secured operational logs\n');
    process.exitCode = 1;
  });
}

import { readFile, stat } from 'node:fs/promises';
import { preflightWorkerBootstrap } from './worker-bootstrap.js';
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
  const args = process.argv.slice(2), configIndex = args.indexOf('--config');
  if (configIndex >= 0) {
    try {
      const path = args[configIndex + 1];
      if (!path || path.startsWith('--')) throw new Error('Missing configuration path');
      if ((await stat(path)).size > 2_000_000) throw new Error('Configuration too large');
      const bytes = await readFile(path);
      if (bytes.length > 2_000_000) throw new Error('Configuration too large');
      const result = preflightWorkerBootstrap(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), new Set(Object.keys(process.env)));
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch { process.stderr.write('Worker preflight could not read a bounded UTF-8 configuration file\n'); process.exitCode = 1; }
  } else process.stdout.write(JSON.stringify({ status: 'checked', queues: ['replay', 'application'], applicationRuntime: 'blocked',
    reason: 'Trusted workspace resolver/backend bootstrap and production lifecycle authority are not configured' }) + '\n');
} else if (process.argv.slice(2).includes('--config')) {
  process.stderr.write('Worker configuration alone cannot supply lifecycle authority; use --check --config for preflight and a reviewed deployment bootstrap for execution\n');
  process.exitCode = 1;
} else {
  await startConfiguredWorker().catch(() => {
    process.stderr.write('Worker startup failed; check explicit DATABASE_URL configuration and secured operational logs\n');
    process.exitCode = 1;
  });
}

import { inspectLocalDevelopmentWorkspace, StoredLocalDevelopmentWorkspaceSchema } from './local-development-workspace.js';
import { readFile, stat } from 'node:fs/promises';
import { preflightWorkerBootstrap } from './worker-bootstrap.js';
import { parseWorkerLaunchOptions, startWorkerFromOptions, type WorkerLaunchOptions } from './worker-launch.js';

async function run(options: WorkerLaunchOptions) {
  // Build/runtime import smoke without opening a database, service, socket or model.
  if (options.check) {
    if (options.localDevelopment !== undefined) {
      try {
        const path = options.localDevelopment;
        if (!path || path.startsWith('--') || (await stat(path)).size > 2_000_000) throw new Error('Invalid development receipt');
        const bytes = await readFile(path);
        if (bytes.length > 2_000_000) throw new Error('Invalid development receipt');
        const inspection = await inspectLocalDevelopmentWorkspace(StoredLocalDevelopmentWorkspaceSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
        process.stdout.write(JSON.stringify({ ...inspection, workerExecution: 'not_supported_by_development_adapter' }) + '\n');
      } catch { process.stderr.write('Development workspace inspection failed; no runtime was started\n'); process.exitCode = 1; }
    } else if (options.config !== undefined) {
      try {
        const path = options.config;
        if (!path || path.startsWith('--')) throw new Error('Missing configuration path');
        if ((await stat(path)).size > 2_000_000) throw new Error('Configuration too large');
        const bytes = await readFile(path);
        if (bytes.length > 2_000_000) throw new Error('Configuration too large');
        const result = preflightWorkerBootstrap(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), new Set(Object.keys(process.env)));
        process.stdout.write(JSON.stringify(result) + '\n');
      } catch { process.stderr.write('Worker preflight could not read a bounded UTF-8 configuration file\n'); process.exitCode = 1; }
    } else process.stdout.write(JSON.stringify({ status: 'checked', queues: ['replay', 'application'], applicationRuntime: 'blocked',
      ...(options.application ? { applicationBootstrapRequested: true, trustedDependencies: 'not_loaded_or_verified' } : {}),
      reason: 'Trusted workspace resolver/backend bootstrap and production lifecycle authority are not configured' }) + '\n');
  } else if (options.localDevelopment !== undefined) {
    process.stderr.write('Local development supports --check inspection and workspace local lifecycle commands only; it cannot execute repository programs or models\n');
    process.exitCode = 1;
  } else if (options.config !== undefined) {
    process.stderr.write('Worker configuration alone cannot supply lifecycle authority; use --check --config for preflight and a reviewed deployment bootstrap for execution\n');
    process.exitCode = 1;
  } else {
    await startWorkerFromOptions(options, process.env).then(service => {
      const shutdown = () => { void service.stop().catch(() => { process.stderr.write('Worker shutdown failed; inspect secured operational logs\n'); process.exitCode = 1; }); };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    }).catch(() => {
      process.stderr.write('Worker startup failed; verify explicit bootstrap, DATABASE_URL configuration and secured operational logs\n');
      process.exitCode = 1;
    });
  }
}

try { await run(parseWorkerLaunchOptions(process.argv.slice(2))); }
catch {
  process.stderr.write('Invalid worker arguments; use --check, --check --config FILE, --check --local-development FILE, or explicit --enable-application-execution with --application-bootstrap and --application-bootstrap-sha256\n');
  process.exitCode = 1;
}

import { parseWorkerLaunchOptions, startWorkerFromOptions } from './worker-launch.js';

try {
  const options = parseWorkerLaunchOptions(process.argv.slice(2));
  // Pure import smoke: never read/import deployment code or open any resources.
  if (options.check) {
    process.stdout.write(JSON.stringify({ status: 'checked', queues: ['replay', 'application'], applicationRuntime: 'blocked',
      reason: 'Trusted workspace resolver/backend bootstrap and production lifecycle authority are not configured',
      applicationBootstrapRequested: !!options.application, trustedDependencies: 'not_loaded_or_verified' }) + '\n');
  } else {
    const service = await startWorkerFromOptions(options, process.env);
    const shutdown = () => { void service.stop().catch(() => { process.stderr.write('Worker shutdown failed; inspect secured operational logs\n'); process.exitCode = 1; }); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
} catch {
  process.stderr.write('Worker startup failed; check explicit launch options, DATABASE_URL and secured operational logs\n');
  process.exitCode = 1;
}

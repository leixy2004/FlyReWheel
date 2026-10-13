import { bindBatchFixtures, loadBatchFixtures, runBatchFromCli } from './review-batch-cli-execution.js';
import type { WorkerBootstrapDependencies } from './worker-bootstrap.js';
import { writeFile } from 'node:fs/promises';
import { Option } from 'commander';
import { exportReviewBatch, reviewBatchCsv } from './review-batch-export.js';
import type { Command } from 'commander';
import { databaseCommand, storeFor } from './cli-database.js';
import { ReviewBatchInputSchema, reviewBatchStatus } from './review-batch.js';

export function registerReviewBatchCommands(reviews: Command, json: (path: string) => Promise<unknown>, output: (value: unknown, path?: string) => Promise<void>, trusted: WorkerBootstrapDependencies = {}) {
  const batch = reviews.command('batch').description('Freeze up to 20 existing semantic review jobs and inspect their independent durable results');
  databaseCommand(batch, 'create').requiredOption('--file <file>', 'Strict JSON {id,jobs}; exact review job inputs in execution order')
    .option('--offline-fixtures <files...>', 'Explicit authored fixture JSON; bind separate offline job identities at creation')
    .option('--out <file>').action(async options => {
      const raw = ReviewBatchInputSchema.parse(await json(options.file));
      const input = options.offlineFixtures ? bindBatchFixtures(raw, await loadBatchFixtures(options.offlineFixtures, json)) : raw;
      const store = await storeFor(options);
      try { await output({ ...await store.createReviewBatch(input), execution: 'not_run' }, options.out); }
      finally { await store.close(); }
    });
  databaseCommand(batch, 'run').description('Execute a stored batch; explicit offline fixtures or trusted worker bootstrap, never automatic model authorization')
    .requiredOption('--digest <sha256>').option('--offline-fixtures <files...>', 'Explicit authored fixture files matching the frozen offline jobs')
    .option('--config <file>', 'Existing WorkerBootstrapConfigSchema; trusted authority/resolver must be injected by reviewed deployment code')
    .option('--retry-job-digest <sha256...>', 'Explicit exact retryable batch items; finished or active jobs are never restarted')
    .option('--out <file>').action(async options => {
      if (!!options.offlineFixtures === !!options.config) throw new Error('Choose exactly one: --offline-fixtures or --config');
      const fixtures = options.offlineFixtures ? await loadBatchFixtures(options.offlineFixtures, json) : undefined;
      const config = options.config ? await json(options.config) : undefined;
      const controller = new AbortController(), abort = () => controller.abort();
      const store = await storeFor(options);
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try {
        const result = await runBatchFromCli(store, options.digest, controller.signal, { fixtures, config, retryJobDigests: options.retryJobDigest }, trusted);
        await output(result, options.out);
        if (result.state !== 'completed') process.exitCode = 2;
      } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); await store.close(); }
    });
  databaseCommand(batch, 'show').requiredOption('--digest <sha256>').option('--out <file>').action(async options => {
    const store = await storeFor(options);
    try { await output(await store.getReviewBatch(options.digest), options.out); } finally { await store.close(); }
  });
  databaseCommand(batch, 'status').requiredOption('--digest <sha256>').option('--out <file>').action(async options => {
    const store = await storeFor(options);
    try { await output(await reviewBatchStatus(store, options.digest), options.out); } finally { await store.close(); }
  });
  databaseCommand(batch, 'export').requiredOption('--digest <sha256>')
    .addOption(new Option('--format <format>', 'JSON report or spreadsheet CSV').choices(['json', 'csv']).default('json'))
    .option('--out <file>').action(async options => {
      const store = await storeFor(options);
      try {
        const report = await exportReviewBatch(store, options.digest);
        if (options.format === 'json') await output(report, options.out);
        else {
          const csv = reviewBatchCsv(report);
          if (options.out) await writeFile(options.out, csv); else process.stdout.write(csv);
        }
      } finally { await store.close(); }
    });

}

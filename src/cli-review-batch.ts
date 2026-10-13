import { writeFile } from 'node:fs/promises';
import { Option } from 'commander';
import { exportReviewBatch, reviewBatchCsv } from './review-batch-export.js';
import type { Command } from 'commander';
import { databaseCommand, storeFor } from './cli-database.js';
import { ReviewBatchInputSchema, reviewBatchStatus } from './review-batch.js';

export function registerReviewBatchCommands(reviews: Command, json: (path: string) => Promise<unknown>, output: (value: unknown, path?: string) => Promise<void>) {
  const batch = reviews.command('batch').description('Freeze up to 20 existing semantic review jobs and inspect their independent durable results');
  databaseCommand(batch, 'create').requiredOption('--file <file>', 'Strict JSON {id,jobs}; exact review job inputs in execution order')
    .option('--out <file>').action(async options => {
      const input = ReviewBatchInputSchema.parse(await json(options.file)), store = await storeFor(options);
      try { await output({ ...await store.createReviewBatch(input), execution: 'not_run' }, options.out); }
      finally { await store.close(); }
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

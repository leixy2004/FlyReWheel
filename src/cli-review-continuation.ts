import type { Command } from 'commander';
import { databaseCommand, storeFor } from './cli-database.js';
import { ReviewContinuationInputSchema, reviewContinuationJob, reviewContinuationStatus } from './review-continuation.js';

export function registerReviewContinuationCommands(revisions: Command, output: (value: unknown, path?: string) => Promise<void>) {
  const commands = revisions.command('continuations').description('Explicit context-selected follow-up; preserves original outcomes and frozen experiments');
  databaseCommand(commands, 'create').requiredOption('--id <id>').requiredOption('--outcome-digest <sha256>')
    .requiredOption('--finding-id <id>').requiredOption('--repository-context-digest <sha256...>')
    .option('--offline-fixture-digest <sha256>', 'Explicit authored fixture digest for a separate offline continuation job')
    .requiredOption('--workspace-id <id>').option('--attempt <id>', 'Immutable attempt; use a new ID and attempt after a terminal blocked run', 'initial')
    .option('--out <file>').action(async options => {
      const input = ReviewContinuationInputSchema.parse({ id: options.id, outcomeDigest: options.outcomeDigest,
        findingId: options.findingId, repositoryContextDigests: options.repositoryContextDigest,
        workspaceId: options.workspaceId, attempt: options.attempt, ...(options.offlineFixtureDigest ? { offlineFixtureDigest: options.offlineFixtureDigest } : {}) });
      const store = await storeFor(options);
      try {
        const stored = await store.createReviewContinuation(input);
        await output({ ...stored, job: reviewContinuationJob(stored), execution: 'not_run',
          nextStep: 'Pass the exact job to the existing application dispatcher with trusted runtime dependencies; inspect this continuation with status.' }, options.out);
      } finally { await store.close(); }
    });
  databaseCommand(commands, 'show').requiredOption('--digest <sha256>').option('--out <file>').action(async options => {
    const store = await storeFor(options);
    try { const stored = await store.getReviewContinuation(options.digest); await output({ ...stored, job: reviewContinuationJob(stored) }, options.out); }
    finally { await store.close(); }
  });
  databaseCommand(commands, 'status').requiredOption('--digest <sha256>').option('--out <file>').action(async options => {
    const store = await storeFor(options);
    try { await output(await reviewContinuationStatus(store, options.digest), options.out); } finally { await store.close(); }
  });
  databaseCommand(commands, 'list').requiredOption('--outcome-digest <sha256>').option('--after <sha256>')
    .option('--limit <count>', '1–100 records, ordered by digest', '20').option('--out <file>').action(async options => {
      const store = await storeFor(options);
      try {
        const records = await store.listReviewContinuations({ outcomeDigest: options.outcomeDigest, after: options.after, limit: Number(options.limit) });
        await output({ continuations: records, nextAfter: records.at(-1)?.digest ?? null }, options.out);
      } finally { await store.close(); }
    });
}

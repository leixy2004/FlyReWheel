import { z } from 'zod';
import { DigestSchema } from './core/model.js';
import { digestOf } from './core/identity.js';
import { ApplicationJobSchema, ApplicationLogicalIdSchema, applicationJobDigest } from './application-job-contract.js';
import { ApplicationJobBusyError, ApplicationJobRetryError, createApplicationJobDispatcher, type ApplicationDispatcherDependencies } from './application-dispatcher.js';
import { inspectApplicationOperation } from './application-preflight.js';
import type { QualEvoStore } from './storage/store.js';

export const ReviewBatchInputSchema = z.object({ id: ApplicationLogicalIdSchema,
  jobs: z.array(ApplicationJobSchema.options[1]).min(1).max(20)
    .refine(jobs => new Set(jobs.map(applicationJobDigest)).size === jobs.length, 'Duplicate review job in batch'),
}).strict();
export type ReviewBatchInput = z.input<typeof ReviewBatchInputSchema>;
export const ReviewBatchSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('explicit-review-batch'),
  input: ReviewBatchInputSchema, scheduling: z.literal('serial-explicit-no-automatic-retries'),
  notification: z.literal('not_performed'), certification: z.literal('none'),
}).strict();
export type StoredReviewBatch = { digest: string; batch: z.infer<typeof ReviewBatchSchema> };
export function deriveReviewBatch(input: ReviewBatchInput): StoredReviewBatch {
  const batch = ReviewBatchSchema.parse({ schemaVersion: 1, kind: 'explicit-review-batch', input,
    scheduling: 'serial-explicit-no-automatic-retries', notification: 'not_performed', certification: 'none' });
  return { digest: digestOf(batch), batch };
}
export async function reviewBatchStatus(store: QualEvoStore, digest: string) {
  const stored = await store.getReviewBatch(digest), items = [];
  for (const job of stored.batch.input.jobs) items.push(await inspectApplicationOperation(store, job));
  const counts = { total: items.length, notStarted: 0, running: 0, retryable: 0, completed: 0, blocked: 0 };
  for (const item of items) {
    if (item.state === 'not_started') counts.notStarted++;
    else if (item.state === 'running') counts.running++;
    else if (item.state === 'retryable') counts.retryable++;
    else if (item.result?.status === 'completed') counts.completed++;
    else counts.blocked++;
  }
  return { ...stored, state: counts.completed === counts.total ? 'completed' : counts.running ? 'running'
    : counts.notStarted ? 'pending' : 'needs_attention', counts, items,
    execution: 'not_started_by_status', certification: 'none' };
}
export const ReviewBatchRunOptionsSchema = z.object({
  retryJobDigests: z.array(DigestSchema).max(20).default([]).refine(values => new Set(values).size === values.length, 'Duplicate retry selection'),
}).strict();
/** Each job commits independently through the existing dispatcher. Completed/blocked
 * jobs are never restarted and retryable jobs require an exact explicit selection.
 * Cancellation or infrastructure/integrity errors stop this invocation; durable
 * earlier results remain discoverable. A concurrent owner is left undisturbed. */
export async function runReviewBatch(dependencies: ApplicationDispatcherDependencies, digest: string, signal: AbortSignal,
  options: z.input<typeof ReviewBatchRunOptionsSchema> = {}) {
  const selected = ReviewBatchRunOptionsSchema.parse(options), stored = await dependencies.store.getReviewBatch(digest);
  const members = new Set(stored.batch.input.jobs.map(applicationJobDigest));
  if (selected.retryJobDigests.some(digest => !members.has(digest))) throw new Error('Retry selection must belong to this review batch');
  const dispatch = createApplicationJobDispatcher(dependencies);
  for (const job of stored.batch.input.jobs) {
    signal.throwIfAborted();
    const jobDigest = applicationJobDigest(job), record = await dependencies.store.getApplicationJob(jobDigest);
    if (record?.state === 'finished' || record?.state === 'running'
      || (record?.state === 'retryable' && !selected.retryJobDigests.includes(jobDigest))) continue;
    try { await dispatch(job, signal, { allowRetry: selected.retryJobDigests.includes(jobDigest) }); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ApplicationJobRetryError) && !(error instanceof ApplicationJobBusyError)) throw error;
    }
  }
  return reviewBatchStatus(dependencies.store, digest);
}

import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { QualEvoStore } from '../src/storage/store.js';
import { applicationJobDigest, ApplicationJobSchema } from '../src/application-job-contract.js';
import { runReviewBatch, reviewBatchStatus } from '../src/review-batch.js';
import { registerReviewBatchCommands } from '../src/cli-review-batch.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const jobs = ['first', 'second', 'third'].map(attempt => ApplicationJobSchema.options[1].parse({ ...f.jobs.review, attempt }));
  return { ...f, input: { id: 'review-batch', jobs }, dependencies: { store: f.store, runtime: f.dependency, config: f.config, resolveWorkspace: f.resolveWorkspace } };
}
it('continues after a durable item failure, requires explicit retry, reuses completed reviews and reopens', async () => {
  const f = await fixture(), stored = await f.store.createReviewBatch(f.input);
  expect(await f.store.createReviewBatch(f.input)).toEqual(stored);
  f.faults.executeFailures = 1;
  const first = await runReviewBatch(f.dependencies, stored.digest, new AbortController().signal);
  expect(first).toMatchObject({ state: 'needs_attention', counts: { total: 3, retryable: 1, completed: 2, notStarted: 0 } });
  expect(first.items[0]).toMatchObject({ state: 'retryable', attempts: 1, result: { reason: 'runtime_failed', modelExecution: 'not_run' } });
  expect(first.items[1].result).toMatchObject({ status: 'completed', modelExecution: 'not_run' });
  const executions = f.executions.length;
  expect(await runReviewBatch(f.dependencies, stored.digest, new AbortController().signal)).toEqual(first);
  expect(f.executions).toHaveLength(executions);
  await expect(runReviewBatch(f.dependencies, stored.digest, new AbortController().signal, { retryJobDigests: ['f'.repeat(64)] })).rejects.toThrow('belong to this review batch');
  const completed = await runReviewBatch(f.dependencies, stored.digest, new AbortController().signal,
    { retryJobDigests: [applicationJobDigest(f.input.jobs[0])] });
  expect(completed).toMatchObject({ state: 'completed', counts: { completed: 3, retryable: 0 } });
  expect(completed.items.map(item => item.attempts)).toEqual([2, 1, 1]);
  expect(completed.items.slice(1)).toEqual(first.items.slice(1));
  await f.closeStore();
  const reopened = await QualEvoStore.openPGlite(f.storePath);
  try { expect(await reviewBatchStatus(reopened, stored.digest)).toEqual(completed); }
  finally { await reopened.close(); }
}, 30_000);
it('leaves concurrent owners alone and preserves not-started items on cancellation', async () => {
  const f = await fixture(), stored = await f.store.createReviewBatch(f.input);
  await f.store.claimApplicationJob(f.input.jobs[0], randomUUID());
  const signal = new AbortController(); signal.abort();
  await expect(runReviewBatch(f.dependencies, stored.digest, signal.signal)).rejects.toThrow();
  expect(await reviewBatchStatus(f.store, stored.digest)).toMatchObject({ counts: { running: 1, notStarted: 2 } });
  const status = await runReviewBatch({ store: f.store }, stored.digest, new AbortController().signal);
  expect(status).toMatchObject({ state: 'running', counts: { running: 1, blocked: 2, completed: 0 } });
  expect(status.items[1].result).toMatchObject({ status: 'blocked', reason: 'runtime_unavailable', modelExecution: 'not_run' });
  expect(f.executions).toHaveLength(0);
}, 30_000);
it('rejects duplicate jobs, invalid references and mutations; CLI exports durable item progress', async () => {
  const f = await fixture();
  await expect(f.store.createReviewBatch({ id: 'duplicate', jobs: [f.input.jobs[0], f.input.jobs[0]] })).rejects.toThrow('Duplicate');
  await expect(f.store.createReviewBatch({ id: 'missing', jobs: [{ ...f.input.jobs[0], snapshotDigest: 'f'.repeat(64) }] })).rejects.toThrow();
  const stored = await f.store.createReviewBatch(f.input);
  await expect(f.store.createReviewBatch({ ...f.input, jobs: [...f.input.jobs].reverse() })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  await expect(f.db.query('DELETE FROM qe_review_batches WHERE digest=$1', [stored.digest])).rejects.toThrow('append-only');
  await f.closeStore();
  const outputs: unknown[] = [], cli = new Command();
  registerReviewBatchCommands(cli, async path => JSON.parse(await readFile(path, 'utf8')), async value => { outputs.push(value); });
  await cli.parseAsync(['batch', 'status', '--db', f.storePath, '--digest', stored.digest], { from: 'user' });
  expect(outputs[0]).toMatchObject({ state: 'pending', counts: { total: 3, notStarted: 3 }, items: expect.any(Array) });
}, 30_000);

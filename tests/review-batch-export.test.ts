import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { ApplicationJobSchema, applicationJobDigest } from '../src/application-job-contract.js';
import { exportReviewBatch, reviewBatchCsv } from '../src/review-batch-export.js';
import { runReviewBatch } from '../src/review-batch.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
it('exports completed, retryable and active items without conflating missing results with safe reviews; CLI writes JSON and CSV', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const jobs = ['fails', 'completes', 'active'].map(attempt => ApplicationJobSchema.options[1].parse({ ...f.jobs.review, attempt }));
  const stored = await f.store.createReviewBatch({ id: 'export-batch', jobs });
  await f.store.claimApplicationJob(jobs[2], randomUUID());
  f.faults.executeFailures = 1;
  await runReviewBatch({ store: f.store, config: f.config, runtime: f.dependency, resolveWorkspace: f.resolveWorkspace }, stored.digest, new AbortController().signal);
  const executions = f.executions.length, report = await exportReviewBatch(f.store, stored.digest);
  expect(report.rows[0]).toMatchObject({ state: 'retryable', findings: null, reason: 'runtime_failed', reviewId: null });
  expect(report.rows[1]).toMatchObject({ state: 'finished', outcomeStatus: 'completed', modelExecution: 'not_run', findings: expect.any(Object) });
  expect(report.rows[2]).toMatchObject({ state: 'running', modelExecution: 'unknown', cleanup: null, findings: null });
  expect(report.retrySelection.retryJobDigests).toEqual([applicationJobDigest(jobs[0])]);
  expect(f.executions).toHaveLength(executions);
  const csv = reviewBatchCsv(report);
  expect(csv).toContain('"model_execution"'); expect(csv).toContain('"runtime_failed"'); expect(csv).toContain('"unknown"');
  expect(csv.split('\r\n')).toHaveLength(5);
  const formula = structuredClone(report); formula.rows[0].nextAction = '=DANGEROUS("x")\nline2';
  expect(reviewBatchCsv(formula)).toContain('"\'=DANGEROUS(""x"")\nline2"');
  await f.closeStore();
  const invoke = async (...args: string[]) => (await promisify(execFile)(process.execPath,
    [...(process.env.REVIEW_BATCH_COMPILED_SMOKE === '1' ? ['dist/cli.js'] : ['--import', 'tsx', 'src/cli.ts']), 'reviews', 'batch', 'export', '--db', f.storePath, '--digest', stored.digest, ...args],
    { timeout: 30_000, maxBuffer: 2_000_000 })).stdout;
  expect(JSON.parse(await invoke())).toEqual(report);
  const path = join(f.directory, 'report.csv');
  expect(await invoke('--format', 'csv', '--out', path)).toBe('');
  expect(await readFile(path, 'utf8')).toBe(csv);
  await expect(invoke('--format', 'xml')).rejects.toThrow();
}, 30_000);

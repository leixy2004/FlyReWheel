import { afterEach, expect, it, vi } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { contextReviewFixture } from './helpers/semantic-review-context-fixture.js';
import { bindBatchFixtures, runBatchFromCli } from '../src/review-batch-cli-execution.js';
import { digestOf } from '../src/core/identity.js';
import { applicationJobDigest } from '../src/application-job-contract.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const f = contextReviewFixture(), store = await QualEvoStore.openPGlite(); cleanup.push(() => store.close());
  await store.importRuleVersion(f.input.rule.rule, [f.input.problemCase]); await store.importChangeSnapshot(f.input.snapshot.snapshot);
  await store.importRepositoryContext(f.context.context);
  const fixtures = new Map([[digestOf(f.fixtures), f.fixtures]]);
  const job = { schemaVersion: 1 as const, kind: 'semantic-review' as const, workspaceId: 'offline-unused',
    ruleDigest: f.input.rule.digest, snapshotDigest: f.input.snapshot.digest, repositoryContextDigests: [f.context.digest] };
  const input = { id: 'offline', jobs: [job] };
  return { ...f, store, fixtures, input, job };
}
it('binds distinct fixture-only jobs, commits offline reviews atomically and never resolves a workspace', async () => {
  const f = await fixture(), bound = bindBatchFixtures(f.input, f.fixtures), stored = await f.store.createReviewBatch(bound);
  expect(applicationJobDigest(bound.jobs[0])).not.toBe(applicationJobDigest(f.job));
  const resolveWorkspace = vi.fn();
  const done = await runBatchFromCli(f.store, stored.digest, new AbortController().signal, { fixtures: f.fixtures }, { resolveWorkspace });
  expect(done).toMatchObject({ state: 'completed', modelExecution: 'not_run', workspaceExecution: 'not_run' });
  expect(resolveWorkspace).not.toHaveBeenCalled();
  const review = await f.store.getSemanticReview(done.items[0].result!.outcome!.id);
  expect(review.config.mode).toBe('offline_fixture'); expect(review.executionReceipt).toBeUndefined();
  expect(await runBatchFromCli(f.store, stored.digest, new AbortController().signal, { fixtures: f.fixtures })).toEqual(done);
  expect((await f.store.getApplicationJobHistory(applicationJobDigest(bound.jobs[0]))).outcomes).toHaveLength(1);
});
it('rejects ambiguous/incorrect fixtures and untrusted configuration before claiming jobs', async () => {
  const f = await fixture(), stored = await f.store.createReviewBatch(f.input);
  await expect(runBatchFromCli(f.store, stored.digest, new AbortController().signal, { fixtures: f.fixtures })).rejects.toThrow('not bound');
  await expect(runBatchFromCli(f.store, stored.digest, new AbortController().signal, {})).rejects.toThrow('exactly one');
  await expect(runBatchFromCli(f.store, stored.digest, new AbortController().signal, { config: { enabled: true, module: '/tmp/execute-me.js' } })).rejects.toThrow('invalid_configuration');
  await expect(runBatchFromCli(f.store, stored.digest, new AbortController().signal, { config: { enabled: true } })).rejects.toThrow('lifecycle_authority_required');
  expect(await f.store.getApplicationJob(applicationJobDigest(f.job))).toBeNull();
  const other = structuredClone(f.fixtures.values().next().value!); other.judgments[0].reasoning = 'Another authored fixture';
  expect(() => bindBatchFixtures(f.input, new Map([...f.fixtures, [digestOf(other), other]]))).toThrow('unambiguous');
  expect(() => bindBatchFixtures({ ...f.input, jobs: [{ ...f.job, evaluationExportId: 'frozen-study' }] }, f.fixtures)).toThrow('evaluation');
});

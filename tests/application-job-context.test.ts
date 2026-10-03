import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ApplicationJobSchema, applicationJobDigest } from '../src/application-job-contract.js';
import { createApplicationJobDispatcher } from '../src/application-dispatcher.js';
import { createSemanticReviewWorkspaceModelAdapter } from '../src/adapters/semantic-review-model.js';
import { makeReviewEvidence } from '../src/adapters/semantic-review-fixture.js';
import { PerAnchorSemanticReviewModelResponseSchema } from '../src/core/semantic-review-model.js';
import { captureRepositoryContext } from '../src/repository-context.js';
import { digestOf } from '../src/core/identity.js';
import { QualEvoStore } from '../src/storage/store.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const base = { schemaVersion: 1 as const, kind: 'semantic-review' as const, workspaceId: 'review-workspace',
  ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) };
function contextResponse(f: Awaited<ReturnType<typeof applicationJobsFixture>>, digest: string) {
  const value = PerAnchorSemanticReviewModelResponseSchema.parse(f.values['semantic-review-v2']);
  const proof = makeReviewEvidence(f.reviewSnapshot, value.judgments[0].anchorJudgments[0].anchor, 'changed-source');
  return { ...value, repositoryContextDigests: [digest], evidence: [...value.evidence, proof],
    judgments: value.judgments.map(judgment => ({ ...judgment, evidenceRefs: [...judgment.evidenceRefs, proof.id],
      anchorJudgments: judgment.anchorJudgments.map(anchor => ({ ...anchor, evidenceRefs: [...anchor.evidenceRefs, proof.id] })) })) };
}

it('binds optional canonical context sets into job identity and rejects empty, duplicate, oversized or authority-bearing inputs', () => {
  const repositoryContextDigests = ['a'.repeat(64), 'b'.repeat(64)];
  const input = { ...base, repositoryContextDigests }, parsed = ApplicationJobSchema.parse(input);
  expect(parsed).toMatchObject({ repositoryContextDigests });
  expect(applicationJobDigest(parsed)).not.toBe(applicationJobDigest(base));
  repositoryContextDigests[0] = 'c'.repeat(64);
  expect(parsed).toHaveProperty('repositoryContextDigests', ['a'.repeat(64), 'b'.repeat(64)]);
  for (const set of [[], ['a'.repeat(64), 'a'.repeat(64)], ['b'.repeat(64), 'a'.repeat(64)], ['HEAD'], Array.from({ length: 9 }, (_, i) => `${i}`.repeat(64))]) {
    expect(ApplicationJobSchema.safeParse({ ...base, repositoryContextDigests: set }).success).toBe(false);
  }
  expect(ApplicationJobSchema.safeParse({ ...base, repositoryContexts: [] }).success).toBe(false);
  expect(ApplicationJobSchema.parse(base)).not.toHaveProperty('repositoryContextDigests');
});

it('rejects missing context references before allocating or executing any workspace', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const dispatch = createApplicationJobDispatcher({ store: f.store, config: f.config, runtime: f.dependency, resolveWorkspace: f.resolveWorkspace });
  await expect(dispatch({ ...f.jobs.review, repositoryContextDigests: ['f'.repeat(64)] }, new AbortController().signal))
    .rejects.toMatchObject({ result: { reason: 'input_rejected', modelExecution: 'not_run', cleanup: 'not_started' } });
  expect(f.resolved).toEqual([]); expect(f.executions).toEqual([]);
}, 30_000);

it('loads selected registered contexts into the authored workspace contract and replays the durable outcome after reopen', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const value = await captureRepositoryContext({ repositoryPath: join(f.directory, 'application-repo'), repositoryId: f.reviewSnapshot.snapshot.repository.id,
    head: f.reviewSnapshot.snapshot.head, paths: ['src/sample.ts'] });
  const context = await f.store.importRepositoryContext(value.context);
  f.values['semantic-review-v3'] = contextResponse(f, context.digest);
  const job = { ...f.jobs.review, repositoryContextDigests: [context.digest] };
  const dispatch = createApplicationJobDispatcher({ store: f.store, config: f.config, runtime: f.dependency, resolveWorkspace: f.resolveWorkspace });
  const result = await dispatch(job, new AbortController().signal);
  expect(result).toMatchObject({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified', outcome: { kind: 'semantic-review' } });
  const review = await f.store.getSemanticReview(result.outcome!.id);
  expect(review.repositoryContexts).toEqual([context]); expect(review.config.repositoryContextDigests).toEqual([context.digest]);
  expect(review.executionReceipt).toMatchObject({ repositoryContextDigests: [context.digest], workerResult: { outputContract: 'semantic-review-v3' } });
  expect(f.executions).toEqual(['semantic-review-v3']);
  await f.closeStore();
  const reopened = await QualEvoStore.openPGlite(f.storePath); cleanup.push(() => reopened.close());
  expect(await createApplicationJobDispatcher({ store: reopened })(job, new AbortController().signal)).toEqual(result);
  expect(await reopened.getSemanticReview(review.id)).toEqual(review); expect(f.resolved).toHaveLength(1);
}, 30_000);

it('requires adapter contexts to be registered and atomically rejects a result from a different job-selected set', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const capture = (paths: string[]) => captureRepositoryContext({ repositoryPath: join(f.directory, 'application-repo'),
    repositoryId: f.reviewSnapshot.snapshot.repository.id, head: f.reviewSnapshot.snapshot.head, paths });
  const selected = await capture(['.gitignore']), supplied = await capture(['src/sample.ts']);
  const job = ApplicationJobSchema.parse({ ...f.jobs.review, repositoryContextDigests: [selected.digest] });
  const jobDigest = applicationJobDigest(job), owner = randomUUID();
  await f.store.claimApplicationJob(job, owner);
  const workspace = await f.resolveWorkspace({ workspaceId: job.workspaceId, jobDigest, expectedSha: f.reviewSnapshot.snapshot.head });
  f.values['semantic-review-v3'] = contextResponse(f, supplied.digest);
  const generated = await createSemanticReviewWorkspaceModelAdapter(f.config, f.dependency).review({ rule: f.reviewRule, snapshot: f.reviewSnapshot,
    repositoryContexts: [{ digest: supplied.digest, context: supplied.context }], attempt: `application-${jobDigest}`,
    context: { kind: 'full-repository', repository: f.reviewSnapshot.snapshot.repository.id, checkout: 'after', workspace } });
  if (generated.execution !== 'succeeded') throw new Error(`Expected authored review: ${JSON.stringify(generated)}`);
  await expect(f.store.saveSemanticReviewModelResult(generated.persistence)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await f.store.importRepositoryContext(selected.context); await f.store.importRepositoryContext(supplied.context);
  await expect(f.store.completeApplicationJob(job, owner, { status: 'completed', modelExecution: 'not_run', cleanup: 'verified',
    outcome: { kind: 'semantic-review', id: generated.review.id, digest: digestOf(generated.review) } },
  async scoped => { await scoped.saveSemanticReviewModelResult(generated.persistence); })).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.getSemanticReview(generated.review.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await f.store.getApplicationJob(jobDigest)).toMatchObject({ state: 'running', result: null });
}, 30_000);

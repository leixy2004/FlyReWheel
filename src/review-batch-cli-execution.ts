import { ReviewFixtureSchema, type ReviewFixture } from './core/semantic-review.js';
import { digestOf } from './core/identity.js';
import { applicationJobDigest } from './application-job-contract.js';
import { ReviewBatchInputSchema, runReviewBatch, type ReviewBatchInput } from './review-batch.js';
import { composeWorkerApplication, type WorkerBootstrapDependencies } from './worker-bootstrap.js';
import type { QualEvoStore } from './storage/store.js';

export async function loadBatchFixtures(paths: string[], json: (path: string) => Promise<unknown>) {
  if (paths.length < 1 || paths.length > 20) throw new Error('Select 1–20 explicit offline fixture files');
  const fixtures = new Map<string, ReviewFixture>();
  for (const path of paths) {
    const fixture = ReviewFixtureSchema.parse(await json(path)), digest = digestOf(fixture);
    if (fixtures.has(digest)) throw new Error('Duplicate offline fixture selection');
    fixtures.set(digest, fixture);
  }
  return fixtures;
}
/** Existing fixture schema is input data, not an executable/runtime configuration.
 * Binding its digest creates a distinct job identity before a batch is persisted. */
export function bindBatchFixtures(input: ReviewBatchInput, fixtures: ReadonlyMap<string, ReviewFixture>) {
  const normalized = ReviewBatchInputSchema.parse(input);
  const jobs = normalized.jobs.map(job => {
    if (job.evaluationExportId || job.governancePlanDigest) throw new Error('Offline batch creation requires explicit replay jobs, not evaluation or governed workspace claims');
    const matches = [...fixtures].filter(([digest, fixture]) => fixture.ruleDigest === job.ruleDigest && fixture.snapshotDigest === job.snapshotDigest
      && digestOf('repositoryContextDigests' in fixture ? fixture.repositoryContextDigests : []) === digestOf(job.repositoryContextDigests ?? [])
      && (!job.offlineFixtureDigest || digest === job.offlineFixtureDigest));
    if (matches.length !== 1) throw new Error('Each offline job requires one unambiguous matching fixture selection');
    return { ...job, offlineFixtureDigest: matches[0][0] };
  });
  if ([...fixtures.keys()].some(digest => !jobs.some(job => job.offlineFixtureDigest === digest))) throw new Error('Unselected fixture file');
  return ReviewBatchInputSchema.parse({ ...normalized, jobs });
}
export async function runBatchFromCli(store: QualEvoStore, digest: string, signal: AbortSignal,
  input: { fixtures?: ReadonlyMap<string, ReviewFixture>; config?: unknown; retryJobDigests?: string[] },
  trusted: WorkerBootstrapDependencies = {}) {
  if ((input.fixtures === undefined) === (input.config === undefined)) throw new Error('Choose exactly one: --offline-fixtures or --config');
  const stored = await store.getReviewBatch(digest);
  if (input.fixtures) {
    const bound = bindBatchFixtures(stored.batch.input, input.fixtures);
    if (bound.jobs.some((job, index) => applicationJobDigest(job) !== applicationJobDigest(stored.batch.input.jobs[index])))
      throw new Error('Batch is not bound to these offline fixtures; create an explicit offline batch first');
    const status = await runReviewBatch({ store, offlineReviewFixtures: input.fixtures }, digest, signal, { retryJobDigests: input.retryJobDigests });
    return { ...status, executionMode: 'authored-offline-fixtures', modelExecution: 'not_run', workspaceExecution: 'not_run' };
  }
  if (stored.batch.input.jobs.some(job => job.offlineFixtureDigest)) throw new Error('Offline fixture jobs cannot execute with live runtime configuration');
  // No ambient credential lookup. Reviewed embedding code must explicitly inject
  // its environment, lifecycle authority and resolver; JSON cannot grant these.
  const application = composeWorkerApplication(input.config, { ...trusted, environment: trusted.environment ?? {} });
  return { ...await runReviewBatch({ store, ...application }, digest, signal, { retryJobDigests: input.retryJobDigests }), executionMode: 'configured-workspace-runtime' };
}

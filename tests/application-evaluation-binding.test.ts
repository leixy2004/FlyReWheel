import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationJobSchema, applicationJobDigest } from '../src/application-job-contract.js';
import { createApplicationJobDispatcher, type ApplicationWorkspaceSelection, type ApplicationWorkspaceResolution } from '../src/application-dispatcher.js';
import { buildPrMiningModelInput, buildPrMiningWorkspaceRequest, createPrMiningWorkspaceModelAdapter } from '../src/adapters/pr-mining-model.js';
import { createSemanticReviewWorkspaceModelAdapter } from '../src/adapters/semantic-review-model.js';
import { buildSemanticReviewModelInput, buildSemanticReviewWorkspaceRequest, validateSemanticReviewExecution } from '../src/semantic-review-execution.js';
import { buildRevisionModelInput, buildRevisionWorkspaceRequest } from '../src/revision-generation.js';
import { createRevisionWorkspaceModelAdapter } from '../src/adapters/revision-model.js';
import { digestOf } from '../src/core/identity.js';
import { bytesDigest } from '../src/workspace/execution-receipt.js';
import type { EvaluationWorkspaceBinding } from '../src/workspace/history-policy.js';
import type { CodexWorkspaceBackend } from '../src/workspace/codex-runner.js';
import { prepareWorkspace } from '../src/workspace/index.js';
import { deriveEvaluationRepository, evaluationWorkspaceBinding, exportEvaluationCheckout, type EvaluationVisibilityManifest } from '../src/workspace/evaluation-checkout.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';
import { miningDate, miningFixture } from './helpers/pr-mining-fixture.js';
import { semanticInputs } from './helpers/semantic-review-fixture.js';
import { revisionConfig, revisionLimits, revisionUsage } from './helpers/revision-generation-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const workspace = { repoPath: '/authored/evaluation-repo', runId: 'compatibility', attemptId: 'initial' };
function evaluation(repositoryId: string, checkoutSha: string): EvaluationWorkspaceBinding {
  return { schemaVersion: 1, exportId: 'evaluation-fixture', requestDigest: 'a'.repeat(64), recordDigest: 'b'.repeat(64),
    repositoryId, checkoutSha, allowedHeads: [checkoutSha], inventory: { count: 1, expandedBytes: 1, digest: 'c'.repeat(64) } };
}
function inputs() {
  const mining = miningFixture(), review = semanticInputs();
  return {
    mining: { request: mining.request, evidence: mining.evidence, candidateId: 'evaluation-candidate', candidateCreatedAt: miningDate,
      context: { kind: 'full-repository' as const, repository: mining.evidence.evidence.snapshot.repository.id, checkout: 'before' as const, workspace } },
    review: { rule: review.rule, snapshot: review.snapshot,
      context: { kind: 'full-repository' as const, repository: review.snapshot.snapshot.repository.id, checkout: 'after' as const, workspace } },
  };
}

it('preserves pre-evaluation generation, prompt, request and job hashes when omitted', () => {
  const raw = inputs();
  const mining = buildPrMiningModelInput(raw.mining, revisionConfig), review = buildSemanticReviewModelInput(raw.review, revisionConfig);
  // Captured from the pre-evaluation source for these deterministic authored inputs.
  expect([digestOf(mining.generation), bytesDigest(mining.generation.prompt), bytesDigest(JSON.stringify(buildPrMiningWorkspaceRequest(mining, revisionLimits)))])
    .toEqual(['6648519c8e12d3a190bbd3e8ea440e37ed22e15ed05f5ee87e84f93849f9d93d', '0e06e1a411f6ab328e43bed3ebb51dc27b946785c687febc9180d3c597d84ce1', '20f9178b59bc88b5762457f7a62afb902a0110e17a2c6e81cb63c0b33ab6c10c']);
  expect([digestOf(review.generation), bytesDigest(review.generation.prompt), bytesDigest(JSON.stringify(buildSemanticReviewWorkspaceRequest(review, revisionLimits)))])
    .toEqual(['e9ac98e64ac5b0643d1d44590788b88df0a84e15ff89580e02db3dc8193979ac', 'ff8148f14ac121f7a649cef9d20c201ec1b7f3b4659c7a79480b69cf4d7b21ad', '2d34891bc99a366af323f382fc8cfc12ddd7e42834591357455ef3a25c87a4b1']);
  const job = { schemaVersion: 1 as const, kind: 'semantic-review' as const, workspaceId: 'review', ruleDigest: raw.review.rule.digest, snapshotDigest: raw.review.snapshot.digest };
  expect(applicationJobDigest(job)).toBe(digestOf({ ...job, attempt: 'initial' }));
  expect(ApplicationJobSchema.parse(job)).not.toHaveProperty('evaluationExportId');
});

it('accepts logical export selection only and binds it into every job identity', () => {
  const jobs = [{ schemaVersion: 1, kind: 'pr-mining', workspaceId: 'mining', requestDigest: 'a'.repeat(64), candidateCreatedAt: miningDate },
    { schemaVersion: 1, kind: 'semantic-review', workspaceId: 'review', ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) },
    { schemaVersion: 1, kind: 'revision-generation', workspaceId: 'revision', requestDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), candidateCreatedAt: miningDate }];
  for (const raw of jobs) {
    const legacy = ApplicationJobSchema.parse(raw), selected = ApplicationJobSchema.parse({ ...raw, evaluationExportId: 'allowed-export' });
    expect(applicationJobDigest(selected)).not.toBe(applicationJobDigest(legacy));
    for (const value of ['../export', '/tmp/export', 'file://export', '', 'x'.repeat(81)])
      expect(ApplicationJobSchema.safeParse({ ...raw, evaluationExportId: value }).success).toBe(false);
    for (const field of ['evaluation', 'evaluationStorePath', 'allowedHeads', 'historyPolicy'])
      expect(ApplicationJobSchema.safeParse({ ...raw, [field]: {} }).success).toBe(false);
  }
});

it('binds evaluation into mining/review generation and prompt/request identity with package validation', () => {
  const raw = inputs();
  const miningBinding = evaluation(raw.mining.context.repository, raw.mining.evidence.evidence.snapshot.mergeBase);
  const reviewBinding = evaluation(raw.review.context.repository, raw.review.snapshot.snapshot.head);
  const mining = buildPrMiningModelInput({ ...raw.mining, context: { ...raw.mining.context, evaluation: miningBinding } }, revisionConfig);
  const review = buildSemanticReviewModelInput({ ...raw.review, context: { ...raw.review.context, evaluation: reviewBinding } }, revisionConfig);
  for (const [prepared, request, binding] of [[mining, buildPrMiningWorkspaceRequest(mining, revisionLimits), miningBinding],
    [review, buildSemanticReviewWorkspaceRequest(review, revisionLimits), reviewBinding]] as const) {
    expect(prepared.generation.context).toMatchObject({ historyPolicy: 'exact-allowed-head-closure-v1', evaluation: binding });
    expect(request).toMatchObject({ historyPolicy: 'exact-allowed-head-closure-v1', evaluation: binding });
    expect(prepared.generation.prompt).toContain(binding.recordDigest);
    expect(JSON.stringify(request)).not.toContain('storePath');
  }
  for (const bad of [{ ...miningBinding, repositoryId: 'other' }, { ...miningBinding, checkoutSha: 'f'.repeat(40), allowedHeads: ['f'.repeat(40)] }])
    expect(() => buildPrMiningModelInput({ ...raw.mining, context: { ...raw.mining.context, evaluation: bad } }, revisionConfig)).toThrow(/binding/);
  for (const bad of [{ ...reviewBinding, repositoryId: 'other' }, { ...reviewBinding, checkoutSha: 'f'.repeat(40), allowedHeads: ['f'.repeat(40)] }])
    expect(() => buildSemanticReviewModelInput({ ...raw.review, context: { ...raw.review.context, evaluation: bad } }, revisionConfig)).toThrow(/binding/);
});

it('rejects missing, unrequested and mismatched resolver bindings before runtime reservation', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const binding = evaluation(f.reviewSnapshot.snapshot.repository.id, f.reviewSnapshot.snapshot.head);
  const cases: Array<{ selected: boolean; resolution: ApplicationWorkspaceResolution }> = [
    { selected: true, resolution: workspace }, { selected: true, resolution: { workspace } },
    { selected: false, resolution: { workspace, evaluation: binding } },
    { selected: true, resolution: { workspace, evaluation: { ...binding, exportId: 'different-export' } } },
    { selected: true, resolution: { workspace, evaluation: { ...binding, repositoryId: 'other' } } },
    { selected: true, resolution: { workspace, evaluation: { ...binding, checkoutSha: 'f'.repeat(40), allowedHeads: ['f'.repeat(40)] } } },
  ];
  for (const [index, c] of cases.entries()) {
    const resolveWorkspace = vi.fn(async (_selection: Readonly<ApplicationWorkspaceSelection>) => c.resolution);
    const dispatch = createApplicationJobDispatcher({ store: f.store, config: f.config, runtime: f.dependency, resolveWorkspace });
    const job = { ...f.jobs.review, attempt: `rejection-${index}`, ...(c.selected ? { evaluationExportId: binding.exportId } : {}) };
    await expect(dispatch(job, new AbortController().signal)).rejects.toMatchObject({ result: { reason: 'input_rejected', modelExecution: 'not_run', cleanup: 'not_started' } });
    expect(resolveWorkspace.mock.calls).toHaveLength(1);
    expect(resolveWorkspace.mock.calls[0]?.[0]).toMatchObject(c.selected ? { evaluationExportId: binding.exportId } : {});
  }
  expect(f.calls).toEqual([]);
}, 30_000);

it('recaptures evaluation mining/revision selected packages before any runtime access', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const raw = inputs().mining;
  const mining = { ...raw, context: { ...raw.context, workspace: f.workspace,
    evaluation: evaluation(raw.context.repository, raw.evidence.evidence.snapshot.mergeBase) } };
  const mined = await createPrMiningWorkspaceModelAdapter(f.config, f.dependency).generate(mining);
  expect(mined).toMatchObject({ execution: 'failed', stage: 'input', modelExecution: 'not_run', runtimeResult: null });
  const binding = evaluation(f.repository, f.head);
  const revised = await createRevisionWorkspaceModelAdapter(f.config, f.dependency).generate({ ...f.input,
    context: { ...f.context, evaluation: binding, workspace: { ...f.workspace, repoPath: join(f.directory, 'application-repo') } } });
  expect(revised).toMatchObject({ execution: 'failed', stage: 'input', modelExecution: 'not_run', runtimeResult: null });
  expect(f.calls).toEqual([]);
  const legacy = buildRevisionModelInput(f.input, f.config);
  const prepared = buildRevisionModelInput({ ...f.input, context: { ...f.context, evaluation: binding } }, f.config);
  expect(prepared.generation.context).toMatchObject({ evaluation: binding, historyPolicy: 'exact-allowed-head-closure-v1' });
  expect(buildRevisionWorkspaceRequest(prepared, revisionLimits)).toMatchObject({ evaluation: binding });
  expect(digestOf(prepared.generation)).not.toBe(digestOf(legacy.generation));
  expect(legacy.generation.context).not.toHaveProperty('evaluation');
  expect(legacy.generation.prompt).not.toContain('evaluationWorkspace');
}, 30_000);

it('atomically rejects a legacy result for an export-selected job', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const job = ApplicationJobSchema.parse({ ...f.jobs.review, evaluationExportId: 'required-export' });
  const jobDigest = applicationJobDigest(job), owner = randomUUID();
  await f.store.claimApplicationJob(job, owner);
  const selected = await f.resolveWorkspace({ workspaceId: job.workspaceId, jobDigest, expectedSha: f.reviewSnapshot.snapshot.head });
  const generated = await createSemanticReviewWorkspaceModelAdapter(f.config, f.dependency).review({ rule: f.reviewRule, snapshot: f.reviewSnapshot,
    attempt: `application-${jobDigest}`, context: { kind: 'full-repository', repository: f.reviewSnapshot.snapshot.repository.id, checkout: 'after', workspace: selected } });
  if (generated.execution !== 'succeeded') throw new Error(`Expected authored review: ${JSON.stringify(generated)}`);
  await expect(f.store.completeApplicationJob(job, owner, { status: 'completed', modelExecution: 'not_run', cleanup: 'verified',
    outcome: { kind: 'semantic-review', id: generated.review.id, digest: digestOf(generated.review) } },
  async scoped => { await scoped.saveSemanticReviewModelResult(generated.persistence); })).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.getSemanticReview(generated.review.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await f.store.getApplicationJob(jobDigest)).toMatchObject({ state: 'running', result: null });
}, 30_000);

it('executes and persists all three evaluation job profiles with exact receipt bindings', async () => {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  const requests: Array<{ evaluation?: EvaluationWorkspaceBinding }> = [];
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(request) {
    requests.push(request);
    return { async prepare() { return { expectedSha: request.expectedSha, headSha: request.expectedSha, clean: true,
      identityValid: true, historyPolicy: request.historyPolicy, evaluation: request.evaluation }; },
    async execute() { return { protocolVersion: 2, outputContract: request.outputContract, value: f.values[request.outputContract!],
      usage: revisionUsage, sessionId: 'authored-evaluation-session', boundary: 'authored-test-no-isolation',
      processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true } }; },
    async stop() { return { stopped: true, verified: true }; }, async collect() { return []; },
    async destroy() { return { destroyed: true, verified: true }; } };
  } };
  const bindings = new Map<string, EvaluationWorkspaceBinding>();
  const dispatch = createApplicationJobDispatcher({ store: f.store, config: f.config, runtime: { ...f.dependency, backend },
    async resolveWorkspace(selection) {
      const repoPath = selection.kind === 'revision-generation' ? f.repoPath : join(f.directory, 'application-repo');
      const storePath = join(f.directory, `evaluation-store-${selection.kind}`);
      const manifest: EvaluationVisibilityManifest = { schemaVersion: 1, repositoryId: selection.repository, classification: 'development-fixture',
        allowedHeads: [...new Set([selection.expectedSha, selection.headSha])].sort(), checkoutSha: selection.expectedSha,
        visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: null, evidenceDigests: [] } };
      const exported = await exportEvaluationCheckout({ repoPath, storePath, manifest });
      const binding = evaluationWorkspaceBinding(selection.evaluationExportId!, exported);
      const workspace = { repoPath: join(f.directory, `derived-${selection.kind}`), runId: 'evaluation', attemptId: 'authored' };
      const proof = await deriveEvaluationRepository({ ...workspace, binding, storePath, manifest });
      await prepareWorkspace({ ...workspace, baseSha: selection.expectedSha, evaluation: proof });
      bindings.set(selection.kind, binding);
      return { workspace, evaluation: binding };
    } });
  const jobs = Object.values(f.jobs).map(job => ({ ...job, evaluationExportId: `export-${job.kind}` }));
  const results = [];
  for (const job of jobs) results.push(await dispatch(job, new AbortController().signal));
  expect(results.map(result => result.status)).toEqual(['completed', 'completed', 'completed']);
  expect(requests).toHaveLength(3);
  for (const [i, job] of jobs.entries()) {
    expect(requests[i].evaluation).toEqual(bindings.get(job.kind));
    expect(await createApplicationJobDispatcher({ store: f.store })(job, new AbortController().signal)).toEqual(results[i]);
  }
  const mining = (await f.store.listPrMiningCandidates())[0].candidate;
  if (mining.schemaVersion !== 2) throw new Error('Expected executed mining candidate');
  const review = await f.store.getSemanticReview(results[1].outcome!.id);
  const revision = (await f.store.listRevisionCandidates())[0].candidate;
  expect(mining.executionReceipt.context.evaluation).toEqual(bindings.get('pr-mining'));
  expect(review.executionReceipt!.context.evaluation).toEqual(bindings.get('semantic-review'));
  expect(revision.executionReceipt.context.evaluation).toEqual(bindings.get('revision-generation'));
  const forged = structuredClone(review.executionReceipt!);
  forged.context.evaluation!.recordDigest = 'f'.repeat(64);
  expect(() => validateSemanticReviewExecution(forged, f.reviewRule, f.reviewSnapshot)).toThrow(/binding mismatch/);
}, 60_000);

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { Command } from 'commander';
import { QualEvoStore } from '../src/storage/store.js';
import { generateRuleRevision } from '../src/rule-revision.js';
import { reviewContinuationJob, reviewContinuationStatus, runReviewContinuation } from '../src/review-continuation.js';
import { createApplicationJobDispatcher } from '../src/application-dispatcher.js';
import { applicationJobDigest } from '../src/application-job-contract.js';
import { registerReviewContinuationCommands } from '../src/cli-review-continuation.js';
import { captureRepositoryContext } from '../src/repository-context.js';
import { digestOf } from '../src/core/identity.js';
import { preflightApplicationJob } from '../src/application-preflight.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { revisionGenerationFixture, revisionConfig, revisionDate } from './helpers/revision-generation-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(operator: 'request_context' | 'retain_rule' | 'abstain' = 'request_context', detectorless = false) {
  const f = await revisionGenerationFixture(undefined, false, true, detectorless ? 'omitted' : 'present'); cleanup.push(f.cleanup);
  f.runtime.execute = async () => ({ ...f.envelope, value: { ...f.value, result: {
    status: 'no_rule_change', operator, reasoning: 'Authored follow-up proposal only',
    nextStep: 'Explicitly select captured context and review again', missingEvidence: operator === 'request_context' ? ['guard applicability'] : [],
    evidenceRefs: f.value.result.evidenceRefs,
    diagnoses: f.value.result.diagnoses.map(diagnosis => ({ ...diagnosis,
      category: operator === 'request_context' ? 'context' : operator === 'retain_rule' ? 'judgment' : 'mixed',
      missingEvidence: operator === 'request_context' ? ['guard applicability'] : [] })),
  } } });
  const result = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: f.input.candidateId,
    candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
  if (!('savedOutcome' in result)) throw new Error(JSON.stringify(result));
  const input = { id: 'follow-up', outcomeDigest: result.savedOutcome.digest, findingId: f.finding.id,
    repositoryContextDigests: f.repositoryContexts!.map(c => c.digest), workspaceId: 'review-workspace', attempt: 'follow-up' };
  const dependencies = { store: f.store, config: revisionConfig, runtime: f.dependency,
    resolveWorkspace: async () => f.workspace };
  return { ...f, input, outcome: result.savedOutcome, dependencies };
}

it('runs explicit context-selected continuation through the dispatcher, preserves originals and reopens offline', async () => {
  const f = await fixture(), original = await f.store.getReviewFinding(f.finding.id);
  const stored = await f.store.createReviewContinuation(f.input);
  expect(await f.store.createReviewContinuation(f.input)).toEqual(stored);
  const response = f.contextFixtures(f.baseRule, ['violation', 'safe']);
  const targets = buildSemanticReview({ rule: f.baseRule, snapshot: f.snapshot }).coverage.targets;
  const { schemaVersion: _schema, kind: _kind, ...value } = response;
  value.judgments.push(...targets.filter(target => target.disposition === 'captured' && !value.judgments.some(j => j.targetId === target.id))
    .map(target => ({ targetId: target.id, decision: 'unknown' as const, reasoning: 'Authored missing context', missingContext: ['Unassessed'], evidenceRefs: [], anchorJudgments: [] })));
  f.runtime.execute = async () => ({ ...f.envelope, outputContract: 'semantic-review-v3', value });
  const status = await runReviewContinuation(f.dependencies, stored.digest, new AbortController().signal);
  expect(status).toMatchObject({ state: 'completed', assessment: 'safe', result: { modelExecution: 'not_run' }, certification: 'none' });
  const calls = f.calls.length;
  expect(await runReviewContinuation(f.dependencies, stored.digest, new AbortController().signal)).toEqual(status);
  expect(f.calls).toHaveLength(calls);
  expect(await f.store.getReviewFinding(f.finding.id)).toEqual(original);
  expect(await f.store.getRevisionOutcome(f.outcome.digest)).toEqual(f.outcome);
  expect(await f.store.listRuleVersions()).toEqual([f.baseRule]);
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
  await f.closeStore(); await rm(f.repoPath, { recursive: true, force: true });
  const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db'));
  try { expect(await reviewContinuationStatus(reopened, stored.digest)).toEqual(status); }
  finally { await reopened.close(); }
}, 30_000);

it('rejects changed identities, unselected findings, missing/wrong-head contexts and substituted jobs before runtime', async () => {
  const f = await fixture(), stored = await f.store.createReviewContinuation(f.input);
  for (const change of [{ workspaceId: 'other' }, { attempt: 'other' }])
    await expect(f.store.createReviewContinuation({ ...f.input, ...change })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  const other = f.baseReview.findings.find(x => x.id !== f.finding.id)!;
  await expect(f.store.createReviewContinuation({ ...f.input, id: 'wrong-finding', findingId: other.id })).rejects.toThrow('frozen selected feedback');
  await expect(f.store.createReviewContinuation({ ...f.input, id: 'missing', repositoryContextDigests: ['f'.repeat(64)] })).rejects.toThrow();
  const context = f.repositoryContexts![0].context;
  for (const change of [{ head: f.base }, { repository: { ...context.repository, id: 'other-repository' } }]) {
    const wrong = await f.store.importRepositoryContext({ ...context, ...change });
    await expect(f.store.createReviewContinuation({ ...f.input, id: 'wrong-context', repositoryContextDigests: [wrong.digest] })).rejects.toThrow();
  }
  const alternate = await f.store.importRepositoryContext((await captureRepositoryContext({ repositoryPath: f.repoPath, repositoryId: f.repository, head: f.head, paths: ['contracts/guard.txt'] })).context);
  await expect(f.store.createReviewContinuation({ ...f.input, repositoryContextDigests: [alternate.digest] })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  const job = { ...reviewContinuationJob(stored), workspaceId: 'substituted' }, calls = f.calls.length;
  await expect(createApplicationJobDispatcher(f.dependencies)(job, new AbortController().signal)).rejects.toThrow('exact continuation selection');
  expect(f.calls).toHaveLength(calls);
  expect(await f.store.getApplicationJob(applicationJobDigest(job))).toBeNull();
  expect((await preflightApplicationJob(f.store, job)).issues).toContainEqual(expect.objectContaining({ code: 'domain_contract_rejected' }));
  await expect(f.db.query('DELETE FROM qe_review_continuations WHERE digest=$1', [stored.digest])).rejects.toThrow('append-only');
  expect(await f.store.listReviewContinuations({ outcomeDigest: f.outcome.digest })).toEqual([stored]);
  await f.db.exec('ALTER TABLE qe_review_continuations DISABLE TRIGGER qe_review_continuations_immutable');
  const forged = { ...stored.continuation, snapshotDigest: 'e'.repeat(64) };
  await f.db.query('UPDATE qe_review_continuations SET digest=$1,payload=$2::jsonb WHERE digest=$3', [digestOf(forged), JSON.stringify(forged), stored.digest]);
  await expect(f.store.getReviewContinuation(digestOf(forged))).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
}, 30_000);

it('retains unresolved anchor judgments and reports missing runtime as blocked, without repair claims', async () => {
  const f = await fixture('retain_rule'), stored = await f.store.createReviewContinuation(f.input);
  const response = f.contextFixtures(f.baseRule, ['violation', 'safe']);
  const judgment = response.judgments[1];
  judgment.decision = 'unknown'; judgment.missingContext = ['Applicability not established'];
  judgment.anchorJudgments[0].decision = 'unknown'; judgment.anchorJudgments[0].missingContext = ['Applicability not established'];
  const { schemaVersion: _schema, kind: _kind, ...value } = response;
  const targets = buildSemanticReview({ rule: f.baseRule, snapshot: f.snapshot }).coverage.targets;
  for (const target of targets.filter(t => t.disposition === 'captured' && !value.judgments.some(j => j.targetId === t.id)))
    value.judgments.push({ targetId: target.id, decision: 'unknown', reasoning: 'Authored unassessed', evidenceRefs: [], missingContext: ['Unassessed'], anchorJudgments: [] });
  f.runtime.execute = async () => ({ ...f.envelope, outputContract: 'semantic-review-v3', value });
  expect(await runReviewContinuation(f.dependencies, stored.digest, new AbortController().signal)).toMatchObject({ state: 'completed', assessment: 'unknown' });
  const blocked = await f.store.createReviewContinuation({ ...f.input, id: 'no-runtime', attempt: 'no-runtime' });
  expect(await runReviewContinuation({ store: f.store }, blocked.digest, new AbortController().signal)).toMatchObject({ state: 'blocked', assessment: 'not_run', result: { modelExecution: 'not_run', reason: 'runtime_unavailable' } });
}, 30_000);

it('offers CLI create/show/status/list with explicit database selection and links back from an outcome', async () => {
  const f = await fixture(), directory = join(f.directory, 'db'); await f.closeStore();
  const outputs: any[] = [];
  const invoke = async (args: string[]) => {
    const cli = new Command(); registerReviewContinuationCommands(cli, async value => { outputs.push(value); });
    await cli.parseAsync(['continuations', ...args, '--db', directory], { from: 'user' }); return outputs.at(-1);
  };
  const created = await invoke(['create', '--id', f.input.id, '--outcome-digest', f.input.outcomeDigest, '--finding-id', f.input.findingId,
    '--repository-context-digest', ...f.input.repositoryContextDigests, '--workspace-id', f.input.workspaceId, '--attempt', f.input.attempt]);
  expect(created.execution).toBe('not_run');
  expect((await invoke(['show', '--digest', created.digest])).job).toEqual(created.job);
  expect(await invoke(['status', '--digest', created.digest])).toMatchObject({ state: 'not_started', assessment: 'not_run' });
  expect((await invoke(['list', '--outcome-digest', f.input.outcomeDigest])).continuations).toHaveLength(1);
}, 30_000);

it('rejects abstention and does not treat a target-safe review with no exact anchor as repair', async () => {
  const abstained = await fixture('abstain');
  await expect(abstained.store.createReviewContinuation(abstained.input)).rejects.toThrow('Only request_context or retain_rule');
  const f = await fixture('request_context', true), stored = await f.store.createReviewContinuation(f.input);
  const response = f.contextFixtures(f.baseRule, ['violation', 'safe']);
  response.judgments[1].anchorJudgments = [];
  const { schemaVersion: _schema, kind: _kind, ...value } = response;
  const targets = buildSemanticReview({ rule: f.baseRule, snapshot: f.snapshot }).coverage.targets;
  for (const target of targets.filter(t => t.disposition === 'captured' && !value.judgments.some(j => j.targetId === t.id)))
    value.judgments.push({ targetId: target.id, decision: 'unknown', reasoning: 'Authored unassessed', evidenceRefs: [], missingContext: ['Unassessed'], anchorJudgments: [] });
  f.runtime.execute = async () => ({ ...f.envelope, outputContract: 'semantic-review-v3', value });
  expect(await runReviewContinuation(f.dependencies, stored.digest, new AbortController().signal)).toMatchObject({ state: 'completed', assessment: 'not_adjudicated', findingId: null });
}, 30_000);

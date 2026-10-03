import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { ContextRevisionModelResponseSchema, type AnyRevisionModelResponse } from '../src/core/revision-model.js';
import { RevisionCandidateSchema, RevisionNoMutationOutcomeSchema } from '../src/core/revision-generation.js';
import { buildRevisionModelInput, revisionConsumedSourceDigests, validateRevisionGenerationEvidence, validateRevisionModelResponse, validateExecutedRevisionCandidate } from '../src/revision-generation.js';
import { generateRuleRevision } from '../src/rule-revision.js';
import { QualEvoStore } from '../src/storage/store.js';
import { cleanupWorkspace } from '../src/workspace/index.js';
import { revisionGenerationFixture, revisionConfig, revisionDate } from './helpers/revision-generation-fixture.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() { const f = await revisionGenerationFixture(undefined, false, true); cleanup.push(f.cleanup); return f; }
const options = (f: Awaited<ReturnType<typeof fixture>>) => ({ requestDigest: f.request.digest, candidateId: f.input.candidateId, candidateCreatedAt: revisionDate, context: f.context });
function nonMutation(response: AnyRevisionModelResponse, category: 'judgment' | 'context' | 'mixed', operator: 'retain_rule' | 'request_context' | 'abstain') {
  return { ...response, result: { status: 'no_rule_change', operator, reasoning: 'Authored diagnosis only', nextStep: 'Inspect exact selected evidence before a local decision',
    missingEvidence: category === 'context' ? ['An additional policy interpretation remains unresolved'] : [], evidenceRefs: response.result.evidenceRefs,
    diagnoses: response.result.diagnoses.map(item => ({ ...item, category, missingEvidence: category === 'context' ? ['An additional policy interpretation remains unresolved'] : [] })) } };
}

it('runs context-supported FP through official SDK, boundary revision, comparison and source-gone reopen with immutable cases', async () => {
  const f = await fixture(); await f.sdk();
  expect(f.snapshot.snapshot.changes.some(change => change.after.state !== 'absent' && change.after.path === 'contracts/guard.txt')).toBe(false);
  const generated = await generateRuleRevision(f.store, options(f), revisionConfig, f.dependency);
  expect(generated).toMatchObject({ execution: 'succeeded', status: 'candidate_requires_review', modelExecution: 'not_run',
    candidate: { schemaVersion: 3, policyVersion: 'diagnosis-operators-v1', evidencePolicyVersion: 'selected-context-evidence-v1', operator: 'boundary_update', activation: 'not_performed' } });
  if (generated.execution !== 'succeeded' || generated.status !== 'candidate_requires_review') throw Error(JSON.stringify(generated));
  const prepared = buildRevisionModelInput(f.input, revisionConfig), saved = generated.saved;
  expect(saved.candidate).toHaveProperty('repositoryContextBindings', prepared.repositoryContextBindings);
  expect(generated.executionReceipt.workerResult.outputContract).toBe('rule-revision-v3');
  expect(generated.executionReceipt.workerResult.value).toEqual(f.value);
  const args = await readFile(join(f.directory, 'sdk-args.json'), 'utf8');
  for (const value of ['shell_tool=false', 'unified_exec=false', 'project_doc_max_bytes=0', 'read-only']) expect(args).toContain(value);
  const rule = await f.store.getRuleVersion(saved.candidate.ruleDigest);
  if (rule.rule.schemaVersion !== 2) throw Error('Expected semantic rule');
  expect(rule.rule.regressionCases).toEqual(f.baseInput.regressionCases); expect(rule.rule.provenance.sourceCases).toEqual(f.baseInput.provenance.sourceCases);
  expect(rule.rule.schemaVersion === 2 && rule.rule.semantics.requiredContext).toEqual(['guard-contract']);
  const reviewed = await f.store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: f.snapshot.digest, fixtures: f.contextFixtures(rule, ['violation', 'safe']), ...f.reviewOptions });
  const comparison = await f.store.createRevisionComparison({ id: 'context-generated-comparison', requestDigest: f.request.digest, candidateRuleDigest: rule.digest,
    reviewPairs: [{ baseReviewId: f.baseReview.id, candidateReviewId: reviewed.id }], caseBindings: f.cases.map(item => ({ caseId: item.id, baseReviewId: f.baseReview.id })) });
  expect(comparison.comparison).toMatchObject({ scorer: 'per-anchor-context-v4', summary: { status: 'compatible', preserved: 1, corrected: 2 }, activation: 'not_performed' });
  expect(comparison.comparison.feedback[0]).toMatchObject({ repositoryContextDigests: f.reviewOptions.repositoryContextDigests, baseReviewDigest: prepared.repositoryContextBindings[0].reviewDigest });
  expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Unknown'); expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
  for (const item of f.cases) expect(await f.store.getProblemCase(item.id)).toEqual(item);
  expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
  expect((await cleanupWorkspace(f.workspace)).record.status).toBe('closed-clean');
  await rm(f.repoPath, { recursive: true, force: true }); await f.closeStore();
  const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db'));
  try {
    expect(await reopened.getRevisionCandidate(saved.digest)).toEqual(saved);
    expect(await reopened.getRevisionComparison(comparison.digest)).toEqual(comparison);
    expect(await reopened.getSemanticReview(f.baseReview.id)).toEqual(f.baseReview);
  } finally { await reopened.close(); }
}, 60_000);

it('exposes exactly selected excerpts and frozen package/citation identities without consuming uncited bytes or future feedback', async () => {
  const f = await fixture(), prepared = buildRevisionModelInput(f.input, revisionConfig);
  expect(prepared.generation.prompt).toContain(f.policySource.trim());
  expect(prepared.generation.prompt).not.toContain('UNCITED_CONTEXT_SENTINEL');
  expect(prepared.generation.prompt).not.toContain(f.unusedEvidence!.id);
  expect(prepared.generation.prompt).not.toContain('bytesBase64');
  expect(prepared.repositoryContextBindings[0]).toMatchObject({ repositoryContextDigests: f.reviewOptions.repositoryContextDigests, evidenceRefs: [f.policyEvidence!.id] });
  const consumed = revisionConsumedSourceDigests(f.input);
  expect(consumed).toContain(f.policyEvidence!.anchor.sourceDigest); expect(consumed).not.toContain(f.unusedEvidence!.anchor.sourceDigest);
  await f.store.appendReviewFeedback({ ...f.feedback, id: 'future-context-feedback', label: 'TP', reason: 'FUTURE_FEEDBACK_SENTINEL', createdAt: '2026-10-03T00:00:00Z' });
  const holdout = { ...f.cases[0], id: 'uncited-holdout', lineageId: 'uncited-holdout', split: 'holdout' as const, sourceDigest: f.unusedEvidence!.anchor.sourceDigest, path: f.unusedEvidence!.anchor.path };
  await f.store.importProblemCase(holdout);
  const graph = await f.store.prepareRevisionGeneration(f.request.digest);
  expect(buildRevisionModelInput({ ...f.input, ...graph }, revisionConfig)).toEqual(prepared);
  const reserved = (await f.db.query<{ digest: string; split: string }>('SELECT digest,split FROM qe_source_splits ORDER BY digest')).rows;
  expect(reserved.find(item => item.digest === f.policyEvidence!.anchor.sourceDigest)?.split).toBe('training');
  expect(reserved.find(item => item.digest === f.unusedEvidence!.anchor.sourceDigest)?.split).toBe('holdout');
  const generated = await generateRuleRevision(f.store, options(f), revisionConfig, f.dependency);
  expect(generated.execution).toBe('succeeded');
  if (generated.execution === 'succeeded' && generated.status === 'candidate_requires_review') expect(await f.store.getRevisionCandidate(generated.saved.digest)).toEqual(generated.saved);
}, 30_000);

it('blocks selected context holdout consumption before runtime and reserves consumed hashes against later holdout import', async () => {
  const f = await fixture(), holdout = { ...f.cases[0], id: 'context-holdout', lineageId: 'context-holdout', split: 'holdout' as const,
    sourceDigest: f.policyEvidence!.anchor.sourceDigest, path: f.policyEvidence!.anchor.path };
  await f.store.importProblemCase(holdout);
  await expect(generateRuleRevision(f.store, options(f), revisionConfig, f.dependency)).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  expect(f.calls).toEqual([]); expect(await f.store.listRevisionCandidates()).toEqual([]);
  const g = await fixture(); await g.store.prepareRevisionGeneration(g.request.digest);
  await expect(g.store.importProblemCase({ ...holdout, repository: g.repository, commit: g.head })).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
}, 30_000);

it('serializes context-use reservations with concurrent holdout registration', async () => {
  const f = await fixture(), holdout = { ...f.cases[0], id: 'racing-context', lineageId: 'racing-context', split: 'holdout' as const,
    sourceDigest: f.policyEvidence!.anchor.sourceDigest, path: f.policyEvidence!.anchor.path };
  const results = await Promise.allSettled([f.store.prepareRevisionGeneration(f.request.digest), f.store.importProblemCase(holdout)]);
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: expect.stringMatching(/^(HOLDOUT_CONTAMINATION|SPLIT_LEAKAGE)$/) } });
}, 30_000);

it('rejects missing, wrong, future-head, and substituted selected context packages or citations in the input graph', async () => {
  const f = await fixture();
  for (const mode of ['missing-package', 'wrong-package', 'future-head', 'wrong-citation', 'missing-citation', 'wrong-excerpt'] as const) {
    const bad = structuredClone(f.input), review = bad.feedback[0].review;
    if (!review.fixtures || review.fixtures.schemaVersion !== 3) throw Error('Context fixture required');
    if (mode === 'missing-package') delete review.repositoryContexts;
    else if (mode === 'wrong-package') review.repositoryContexts![0].digest = 'f'.repeat(64);
    else if (mode === 'future-head') {
      review.repositoryContexts![0].context.head = 'f'.repeat(40);
      review.repositoryContexts![0].digest = digestOf(review.repositoryContexts![0].context);
      review.config.repositoryContextDigests = [review.repositoryContexts![0].digest];
      review.fixtures.repositoryContextDigests = [review.repositoryContexts![0].digest];
    } else {
      const index = review.fixtures.evidence.findIndex(item => item.id === f.policyEvidence!.id);
      if (mode === 'missing-citation') review.fixtures.evidence.splice(index, 1);
      else if (mode === 'wrong-excerpt') review.fixtures.evidence[index].content = 'invented excerpt';
      else review.fixtures.evidence[index].anchor.sourceDigest = 'f'.repeat(64);
    }
    expect(() => validateRevisionGenerationEvidence(bad), mode).toThrow();
    expect(() => revisionConsumedSourceDigests(bad), mode).toThrow();
  }
}, 30_000);

it('rejects missing, wrong and unselected response citations/bindings and legacy worker downgrade before persistence', async () => {
  const f = await fixture(), prepared = buildRevisionModelInput(f.input, revisionConfig);
  for (const mode of ['missing-binding', 'wrong-review', 'wrong-package', 'missing-citation-binding', 'result-citation', 'diagnosis-citation', 'unselected-citation', 'invented-citation'] as const) {
    const bad = ContextRevisionModelResponseSchema.parse(structuredClone(f.value));
    if (mode === 'missing-binding') bad.repositoryContextBindings = [];
    else if (mode === 'wrong-review') bad.repositoryContextBindings[0].reviewDigest = 'f'.repeat(64);
    else if (mode === 'wrong-package') bad.repositoryContextBindings[0].repositoryContextDigests = ['f'.repeat(64)];
    else if (mode === 'missing-citation-binding') bad.repositoryContextBindings[0].evidenceRefs = [];
    else if (mode === 'result-citation') bad.result.evidenceRefs = bad.result.evidenceRefs.filter(ref => ref !== `evidence:${f.policyEvidence!.id}`);
    else if (mode === 'diagnosis-citation') bad.result.diagnoses[0].evidenceRefs = [`feedback:${f.feedback.id}`];
    else bad.result.evidenceRefs.push(`evidence:${mode === 'unselected-citation' ? f.unusedEvidence!.id : 'f'.repeat(64)}`);
    expect(() => validateRevisionModelResponse(prepared, bad), mode).toThrow();
    f.runtime.execute = async () => ({ ...f.envelope, value: bad });
    expect(await f.adapter().generate(f.input), mode).toMatchObject({ execution: 'failed', stage: 'output', candidate: null });
  }
  const replacement = ContextRevisionModelResponseSchema.parse(f.value);
  if (replacement.result.status !== 'candidate') throw Error('Expected candidate');
  replacement.result.operator = 'contract_replacement'; replacement.result.diagnoses[0].category = 'contract';
  replacement.result.replacement = { priorRuleDigest: f.baseRule.digest, previousContract: 'Prior guard contract', proposedContract: 'Proposed new guard contract',
    evidenceRefs: [`rule:${f.baseRule.digest}`, `finding:${f.finding.id}`], retirement: { status: 'proposed_requires_review', oldRuleAppliesWhen: 'Old guard', replacementAppliesWhen: 'New guard', rationale: 'Unverified transition proposal', activation: 'not_performed' } };
  expect(() => validateRevisionModelResponse(prepared, replacement)).toThrow('Contract replacement must cite');
  replacement.result.replacement.evidenceRefs.push(`evidence:${f.policyEvidence!.id}`);
  expect(validateRevisionModelResponse(prepared, replacement).result.status).toBe('candidate');
  const withoutContext = nonMutation(f.value, 'context', 'request_context');
  withoutContext.result.evidenceRefs = [];
  expect(() => validateRevisionModelResponse(prepared, withoutContext)).toThrow('retain every selected context citation');
  const { evidencePolicyVersion, repositoryContextBindings, ...legacy } = ContextRevisionModelResponseSchema.parse(f.value);
  f.runtime.execute = async () => ({ ...f.envelope, outputContract: 'rule-revision-v2', value: legacy });
  expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', error: 'Revision worker policy contract mismatch' });
  expect(await f.store.listRevisionCandidates()).toEqual([]); expect(await f.store.listRevisionOutcomes()).toEqual([]);
  await f.sdk({ type: 'item.completed', item: { id: 'forbidden', type: 'command_execution', command: 'echo forbidden', aggregated_output: '', exit_code: 0, status: 'completed' } });
  expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', candidate: null, runtimeResult: { cleanup: 'verified' } });
}, 30_000);

it('preserves context in all non-mutation outcomes, enforces diagnosis operators, and reopens without original sources', async () => {
  const f = await fixture(), saved = [];
  for (const [category, operator] of [['judgment', 'retain_rule'], ['context', 'request_context'], ['mixed', 'abstain']] as const) {
    const invalid = structuredClone(f.value); invalid.result.diagnoses[0].category = category;
    f.runtime.execute = async () => ({ ...f.envelope, value: invalid });
    expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', error: expect.stringContaining('diagnosis/operator mismatch') });
    f.runtime.execute = async () => ({ ...f.envelope, value: nonMutation(f.value, category, operator) });
    const outcome = await generateRuleRevision(f.store, { ...options(f), candidateId: category }, revisionConfig, f.dependency);
    expect(outcome).toMatchObject({ execution: 'succeeded', status: 'no_rule_change', candidate: null, savedOutcome: { outcome: {
      schemaVersion: 2, evidencePolicyVersion: 'selected-context-evidence-v1', result: { operator }, ruleMutation: 'not_performed', reviewRepair: 'not_performed', activation: 'not_performed' } } });
    if (outcome.execution !== 'succeeded' || outcome.status !== 'no_rule_change') throw Error('Missing non-mutation outcome');
    saved.push(outcome.savedOutcome); expect(RevisionNoMutationOutcomeSchema.parse(outcome.savedOutcome.outcome)).toEqual(outcome.savedOutcome.outcome);
  }
  expect(await f.store.listRuleVersions()).toHaveLength(1); expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Unknown');
  await f.closeStore(); await rm(f.repoPath, { recursive: true, force: true });
  const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db'));
  try { for (const value of saved) expect(await reopened.getRevisionOutcome(value.digest)).toEqual(value); }
  finally { await reopened.close(); }
}, 30_000);

it('rejects tampered context candidate receipts and stored policy bindings during rederivation', async () => {
  const f = await fixture(), generated = await generateRuleRevision(f.store, options(f), revisionConfig, f.dependency);
  if (generated.execution !== 'succeeded' || generated.status !== 'candidate_requires_review') throw Error(JSON.stringify(generated));
  const bad = structuredClone(generated.candidateInput);
  const value = ContextRevisionModelResponseSchema.parse(bad.executionReceipt.workerResult.value);
  value.repositoryContextBindings[0].evidenceRefs = [];
  Object.assign(bad.executionReceipt.workerResult, { value });
  expect(() => validateExecutedRevisionCandidate(bad, f.input)).toThrow('binding mismatch');
  expect(RevisionCandidateSchema.safeParse({ ...generated.candidate, schemaVersion: 2 }).success).toBe(false);
  // Preserve row identity hashes while changing a claimed selected binding: rederive must still reject.
  const stored = structuredClone(generated.saved.candidate);
  if (stored.schemaVersion !== 3) throw Error('Expected v3');
  stored.repositoryContextBindings[0].evidenceRefs = [];
  const digest = digestOf(stored);
  await f.db.exec('ALTER TABLE qe_revision_candidates DISABLE TRIGGER qe_revision_candidates_immutable');
  await f.db.query('UPDATE qe_revision_candidates SET digest=$1,payload=$2::jsonb WHERE id=$3', [digest, JSON.stringify(stored), stored.id]);
  await expect(f.store.getRevisionCandidate(digest)).rejects.toThrow('rederived execution');
}, 30_000);


it('keeps missing required-context or unknown anchor evidence unresolved despite an FP boundary proposal', async () => {
  const f = await fixture();
  for (const mode of ['missing-kind', 'declared-missing', 'unknown-decision'] as const) {
    const fixtures = f.contextFixtures(f.baseRule, ['violation', 'violation']);
    const target = fixtures.judgments.find(item => item.anchorJudgments[0].anchor.path === f.finding.anchor.path)!;
    const anchor = target.anchorJudgments[0];
    if (mode === 'missing-kind') anchor.evidenceRefs = anchor.evidenceRefs.filter(id => id !== f.policyEvidence!.id);
    else if (mode === 'declared-missing') anchor.missingContext = ['Exact guard applicability is unresolved'];
    else { target.decision = 'unknown'; anchor.decision = 'unknown'; }
    const review = await f.store.runSemanticReview({ ruleDigest: f.baseRule.digest, snapshotDigest: f.snapshot.digest, fixtures, ...f.reviewOptions, attempt: mode });
    const finding = review.findings.find(item => item.anchor.path === f.finding.anchor.path)!;
    expect(finding.status).toBe('unknown');
    const feedback = await f.store.appendReviewFeedback({ ...f.feedback, id: mode, reviewId: review.id, findingId: finding.id });
    const request = await f.store.createRevisionRequest({ id: mode, baseRuleDigest: f.baseRule.digest, requestedRuleVersion: 'generated', feedbackIds: [feedback.id], requestedChange: 'Authored unresolved context check', actor: 'fixture', source: 'fixture', createdAt: revisionDate });
    const input = { ...f.input, ...await f.store.getRevisionGenerationEvidence(request.digest) }, prepared = buildRevisionModelInput(input, revisionConfig);
    const response = ContextRevisionModelResponseSchema.parse(f.value);
    response.requestDigest = request.digest; response.repositoryContextBindings = prepared.repositoryContextBindings;
    response.result.evidenceRefs = [`rule:${f.baseRule.digest}`, `feedback:${feedback.id}`, `finding:${finding.id}`, ...prepared.repositoryContextBindings.flatMap(item => item.evidenceRefs.map(id => `evidence:${id}`))];
    response.result.diagnoses = [{ ...response.result.diagnoses[0], feedbackId: feedback.id, evidenceRefs: response.result.evidenceRefs }];
    expect(() => validateRevisionModelResponse(prepared, response)).toThrow('diagnosis/operator mismatch');
    expect(validateRevisionModelResponse(prepared, nonMutation(response, 'context', 'request_context')).result.status).toBe('no_rule_change');
    expect(validateRevisionModelResponse(prepared, nonMutation(response, 'mixed', 'abstain')).result.status).toBe('no_rule_change');
    expect(() => validateRevisionModelResponse(prepared, nonMutation(response, 'judgment', 'retain_rule'))).toThrow('diagnosis/operator mismatch');
  }
}, 30_000);

it('does not borrow another selected finding context citation for an individual diagnosis', async () => {
  const f = await fixture(), fixtures = f.contextFixtures(f.baseRule, ['violation', 'violation']);
  const first = fixtures.judgments.find(item => item.anchorJudgments[0].anchor.path !== f.finding.anchor.path)!;
  first.anchorJudgments[0].evidenceRefs.push(f.unusedEvidence!.id);
  const review = await f.store.runSemanticReview({ ruleDigest: f.baseRule.digest, snapshotDigest: f.snapshot.digest, fixtures, ...f.reviewOptions });
  const feedback = [];
  for (const [i, finding] of review.findings.entries()) feedback.push(await f.store.appendReviewFeedback({ ...f.feedback, id: `selected-${i}`, findingId: finding.id, reviewId: review.id }));
  const request = await f.store.createRevisionRequest({ id: 'two-selected', baseRuleDigest: f.baseRule.digest, requestedRuleVersion: 'generated', feedbackIds: feedback.map(item => item.id), requestedChange: 'Diagnose both anchors independently', source: 'fixture', actor: 'fixture', createdAt: revisionDate });
  const input = { ...f.input, ...await f.store.getRevisionGenerationEvidence(request.digest) }, prepared = buildRevisionModelInput(input, revisionConfig);
  const response = ContextRevisionModelResponseSchema.parse(f.value); response.requestDigest = request.digest; response.repositoryContextBindings = prepared.repositoryContextBindings;
  response.result.evidenceRefs = [...new Set([`rule:${f.baseRule.digest}`, ...input.feedback.flatMap(({ feedback, finding }) => [`feedback:${feedback.id}`, `finding:${finding.id}`, ...finding.evidenceRefs.map(id => `evidence:${id}`)])])];
  response.result.diagnoses = input.feedback.map(({ feedback, finding }) => ({ ...response.result.diagnoses[0], feedbackId: feedback.id,
    evidenceRefs: [`feedback:${feedback.id}`, ...finding.evidenceRefs.map(id => `evidence:${id}`)] }));
  expect(validateRevisionModelResponse(prepared, response).result.status).toBe('candidate');
  const own = input.feedback.find(item => item.finding.anchor.path === f.finding.anchor.path)!;
  response.result.diagnoses.find(item => item.feedbackId === own.feedback.id)!.evidenceRefs.push(`evidence:${f.unusedEvidence!.id}`);
  expect(() => validateRevisionModelResponse(prepared, response)).toThrow('another feedback selection');
}, 30_000);

it('requires the exact immutable context registry again before save and on candidate/outcome reads', async () => {
  const f = await fixture(), generated = await f.adapter().generate(f.input);
  if (generated.execution !== 'succeeded' || generated.status !== 'candidate_requires_review') throw Error(JSON.stringify(generated));
  const saved = await f.store.saveRevisionModelCandidate(generated.persistence);
  f.runtime.execute = async () => ({ ...f.envelope, value: nonMutation(f.value, 'context', 'request_context') });
  const outcome = await generateRuleRevision(f.store, { ...options(f), candidateId: 'outcome' }, revisionConfig, f.dependency);
  if (outcome.execution !== 'succeeded' || outcome.status !== 'no_rule_change') throw Error('Missing outcome');
  // Authored database damage: ordinary callers cannot mutate/delete this registry.
  await expect(f.db.query('DELETE FROM qe_repository_contexts WHERE digest=$1', [f.repositoryContexts![0].digest])).rejects.toThrow('append-only');
  await f.db.exec('ALTER TABLE qe_repository_contexts DISABLE TRIGGER qe_repository_contexts_immutable');
  await f.db.query('DELETE FROM qe_repository_contexts WHERE digest=$1', [f.repositoryContexts![0].digest]);
  await expect(f.store.getRevisionCandidate(saved.digest)).rejects.toThrow('Unknown repository context');
  await expect(f.store.getRevisionOutcome(outcome.savedOutcome.digest)).rejects.toThrow('Unknown repository context');
  await expect(f.store.saveRevisionModelCandidate(generated.persistence)).rejects.toThrow('Unknown repository context');
}, 30_000);

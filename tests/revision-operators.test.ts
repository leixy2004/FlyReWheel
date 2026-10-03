import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase } from '../src/storage/database.js';
import { afterEach, expect, it } from 'vitest';
import { RevisionCandidateSchema, RevisionCandidateInputSchema } from '../src/core/revision-generation.js';
import { type RevisionModelResponse } from '../src/core/revision-model.js';
import { digestOf } from '../src/core/identity.js';
import { buildRevisionModelInput, validateExecutedRevisionCandidate, validateRevisionModelResponse } from '../src/revision-generation.js';
import { generateRuleRevision } from '../src/rule-revision.js';
import { revisionGenerationFixture, revisionConfig, revisionDate } from './helpers/revision-generation-fixture.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() { const f = await revisionGenerationFixture(); cleanup.push(f.cleanup); return f; }
function candidateResponse(f: Awaited<ReturnType<typeof fixture>>) {
  const response = structuredClone(f.value);
  if (response.result.status !== 'candidate') throw new Error('Fixture must be a candidate');
  return response as RevisionModelResponse & { result: Extract<RevisionModelResponse['result'], { status: 'candidate' }> };
}
function noMutation(response: RevisionModelResponse, operator: 'retain_rule' | 'request_context' | 'abstain'): RevisionModelResponse {
  return { ...response, result: { status: 'no_rule_change', operator, diagnoses: response.result.diagnoses,
    reasoning: 'Authored intervention, not verified diagnosis', nextStep: 'Inspect the captured guard context before any rule edit',
    missingEvidence: [], evidenceRefs: response.result.evidenceRefs } };
}

it('allows actual applicability, exception and path edits while preserving protected boundary fields exactly', async () => {
  const f = await fixture(), response = candidateResponse(f);
  response.result.semantics.applicability = ['Danger calls without a preceding applicable guard'];
  response.result.paths = { include: ['src'], exclude: ['src/unselected.ts'] };
  f.runtime.execute = async () => ({ ...f.envelope, value: response });
  const result = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: f.input.candidateId, candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
  expect(result).toMatchObject({ status: 'candidate_requires_review', candidate: { schemaVersion: 2, policyVersion: 'diagnosis-operators-v1', operator: 'boundary_update' } });
  if (result.execution !== 'succeeded' || result.status !== 'candidate_requires_review') throw new Error('Missing candidate');
  expect(result.candidateInput.rule.semantics).toEqual(response.result.semantics);
  expect(result.candidateInput.rule.scope.paths).toEqual(response.result.paths);
  expect(result.candidateInput.rule.provenance.sourceCases).toEqual(f.baseInput.provenance.sourceCases);
  expect(result.candidateInput.rule.regressionCases).toEqual(f.baseInput.regressionCases);
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
}, 30_000);

it('rejects every protected-field boundary edit and no-op candidate through the runtime before persistence', async () => {
  const f = await fixture();
  for (const field of ['title', 'mechanism', 'invariant', 'requiredContext', 'expectedBehavior', 'detectionAssets', 'no-op'] as const) {
    const response = candidateResponse(f);
    if (field === 'detectionAssets') response.result.detectionAssets = [];
    else if (field === 'no-op') response.result.semantics = f.baseInput.semantics;
    else if (field === 'requiredContext') response.result.semantics.requiredContext = ['new obligation'];
    else response.result.semantics[field] = 'unrelated rewritten contract';
    f.runtime.execute = async () => ({ ...f.envelope, value: response });
    expect(await f.adapter().generate(f.input), field).toMatchObject({ execution: 'failed', stage: 'output', candidate: null, runtimeResult: { cleanup: 'verified' } });
  }
  expect(await f.store.listRevisionCandidates()).toEqual([]); expect(await f.store.listRuleVersions()).toHaveLength(1);
}, 30_000);

it('routes judgment/context to persisted non-mutation and rejects their attempted rewrites or operator mismatches', async () => {
  const f = await fixture();
  for (const [category, operator] of [['judgment', 'retain_rule'], ['context', 'request_context']] as const) {
    const response = candidateResponse(f); response.result.diagnoses[0].category = category;
    if (category === 'context') response.result.diagnoses[0].missingEvidence = ['Uncaptured helper contract'];
    f.runtime.execute = async () => ({ ...f.envelope, value: response });
    expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', error: expect.stringContaining('diagnosis/operator mismatch') });
    const valid = noMutation(response, operator);
    if (category === 'judgment') {
      const unresolved = noMutation(response, operator);
      if (unresolved.result.status !== 'no_rule_change') throw new Error('Fixture');
      unresolved.result.missingEvidence = ['Unresolved review interpretation'];
      expect(() => validateRevisionModelResponse(buildRevisionModelInput(f.input, revisionConfig), unresolved)).toThrow('diagnosis/operator mismatch');
    }
    const wrong = noMutation(response, operator === 'retain_rule' ? 'request_context' : 'retain_rule');
    expect(() => validateRevisionModelResponse(buildRevisionModelInput(f.input, revisionConfig), wrong)).toThrow('diagnosis/operator mismatch');
    f.runtime.execute = async () => ({ ...f.envelope, value: valid });
    const outcome = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: category, candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
    expect(outcome).toMatchObject({ execution: 'succeeded', status: 'no_rule_change', candidate: null, savedOutcome: { outcome: { result: { operator }, ruleMutation: 'not_performed', reviewRepair: 'not_performed' } } });
  }
  expect(await f.store.listRuleVersions()).toHaveLength(1); expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Unknown');
}, 30_000);

it('abstains on uncertain or mixed diagnoses and permits a voluntary abstention rather than a fake version', async () => {
  const f = await fixture();
  for (const category of ['insufficient_evidence', 'mixed', 'boundary', 'contract'] as const) {
    const response = candidateResponse(f); response.result.diagnoses[0].category = category;
    if (category !== 'mixed') response.result.diagnoses[0].missingEvidence = ['A prerequisite is unresolved'];
    f.runtime.execute = async () => ({ ...f.envelope, value: response });
    expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', candidate: null });
    const abstained = noMutation(response, 'abstain');
    f.runtime.execute = async () => ({ ...f.envelope, value: abstained });
    expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'succeeded', status: 'no_rule_change', result: { operator: 'abstain' }, candidate: null });
  }
  expect(validateRevisionModelResponse(buildRevisionModelInput(f.input, revisionConfig), noMutation(f.value, 'abstain')).result.status).toBe('no_rule_change');
  expect(await f.store.listRuleVersions()).toHaveLength(1);
}, 30_000);

it('requires explicit evidence-linked contract and proposed retirement without activating or relabeling historical cases', async () => {
  const f = await fixture(), response = candidateResponse(f);
  response.result.operator = 'contract_replacement'; response.result.diagnoses[0].category = 'contract';
  response.result.semantics.invariant = 'Use the new capability contract in the declared replacement context';
  response.result.replacement = { priorRuleDigest: f.baseRule.digest, previousContract: 'Authored old guard contract', proposedContract: 'Authored replacement capability contract',
    evidenceRefs: [`rule:${f.baseRule.digest}`, `finding:${f.finding.id}`], retirement: { status: 'proposed_requires_review', oldRuleAppliesWhen: 'Old guard-based API is in use', replacementAppliesWhen: 'New capability-based API is in use', rationale: 'Requires independent validation of this proposed transition', activation: 'not_performed' } };
  const prepared = buildRevisionModelInput(f.input, revisionConfig);
  for (const kind of ['absent', 'parent', 'invented-evidence', 'missing-evidence', 'routing', 'activation', 'boundary-operator'] as const) {
    const bad = structuredClone(response);
    if (kind === 'absent') bad.result.replacement = null;
    else if (kind === 'parent') bad.result.replacement!.priorRuleDigest = 'f'.repeat(64);
    else if (kind === 'invented-evidence') bad.result.replacement!.evidenceRefs.push('finding:invented');
    else if (kind === 'missing-evidence') bad.result.replacement!.evidenceRefs.pop();
    else if (kind === 'routing') bad.result.replacement!.retirement.replacementAppliesWhen = bad.result.replacement!.retirement.oldRuleAppliesWhen;
    else if (kind === 'activation') Object.assign(bad.result.replacement!.retirement, { activation: 'performed' });
    else bad.result.operator = 'boundary_update';
    expect(() => validateRevisionModelResponse(prepared, bad), kind).toThrow();
  }
  f.runtime.execute = async () => ({ ...f.envelope, value: response });
  const result = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: 'replacement', candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
  expect(result).toMatchObject({ status: 'candidate_requires_review', candidate: { operator: 'contract_replacement', activation: 'not_performed', diagnosis: 'model-proposal-not-ground-truth' } });
  if (result.execution !== 'succeeded' || result.status !== 'candidate_requires_review') throw new Error('Missing candidate');
  expect(result.candidateInput.rule.regressionCases).toEqual(f.baseInput.regressionCases);
  expect(await f.store.getRuleVersion(f.baseRule.digest)).toEqual(f.baseRule);
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
  const reread = await f.store.getRevisionCandidate(result.saved.digest);
  expect(reread.candidate.executionReceipt.workerResult.value).toEqual(response);
}, 30_000);

it.each([1, 2])('rederives an unchanged archived v%s record without attaching new claims or changing its digest', async version => {
  const historical = JSON.parse(await readFile(new URL(`./fixtures/revision-v${version}-record.json`, import.meta.url), 'utf8'));
  const result = validateExecutedRevisionCandidate(RevisionCandidateInputSchema.parse(historical.input), historical.graph);
  expect(result).toEqual(historical.stored.candidate); expect(digestOf(result)).toBe(historical.stored.digest);
  expect(result.schemaVersion).toBe(version); expect(result).not.toHaveProperty('evidencePolicyVersion');
  if (version === 1) expect(result).not.toHaveProperty('policyVersion');
  expect(RevisionCandidateSchema.parse(result)).toEqual(result);
});

it.each([1, 2])('opens an archived v%s candidate through the current persistent store without reinterpreting it', async version => {
  const historical = JSON.parse(await readFile(new URL(`./fixtures/revision-v${version}-record.json`, import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'revision-legacy-read-'));
  const db = await openPGliteDatabase(directory); let store = await QualEvoStore.initialize(db);
  try {
    const { graph, input, stored } = historical;
    await store.importRuleVersion(graph.baseRule.rule, graph.cases);
    for (const snapshot of graph.snapshots) await store.importChangeSnapshot(snapshot.snapshot);
    for (const { feedback, review } of graph.feedback) {
      expect(await store.runSemanticReview({ ruleDigest: review.ruleDigest, snapshotDigest: review.snapshotDigest, fixtures: review.fixtures, attempt: review.config.attempt })).toEqual(review);
      await store.appendReviewFeedback(feedback);
    }
    const { schemaVersion, kind, status, feedbackBindings, synthesis, ...request } = graph.request.request;
    expect(await store.createRevisionRequest(request)).toEqual(graph.request);
    await store.importRuleVersion(input.rule);
    // Restore an already-existing archived row, not a new-generation authorization path.
    await db.query('INSERT INTO qe_revision_candidates(digest,id,request_digest,rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
      [stored.digest, stored.candidate.id, stored.candidate.requestDigest, stored.candidate.ruleDigest, JSON.stringify(stored.candidate)]);
    await store.close(); store = await QualEvoStore.openPGlite(directory);
    expect(await store.getRevisionCandidate(stored.digest)).toEqual(stored);
    expect(await store.listRevisionCandidates(graph.request.digest)).toEqual([stored]);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('abstains on mixed conclusive diagnoses, conflicting anchor labels, and non-label feedback independently', async () => {
  const f = await fixture();
  for (const scenario of ['mixed-diagnoses', 'conflicting-labels', 'note'] as const) {
    const added = await f.store.appendReviewFeedback({ ...f.feedback, id: scenario,
      ...(scenario === 'note' ? { kind: 'note' as const, label: null } : { label: scenario === 'conflicting-labels' ? 'TP' as const : 'FP' as const }) });
    const request = await f.store.createRevisionRequest({ id: scenario, baseRuleDigest: f.baseRule.digest, requestedRuleVersion: 'generated',
      feedbackIds: [f.feedback.id, added.id], requestedChange: 'Authored ambiguous selection', source: 'fixture', actor: 'fixture', createdAt: revisionDate });
    const input = { ...f.input, ...await f.store.getRevisionGenerationEvidence(request.digest) };
    const response = candidateResponse(f); response.requestDigest = request.digest;
    response.result.evidenceRefs.push(`feedback:${added.id}`);
    response.result.diagnoses.push({ ...response.result.diagnoses[0], feedbackId: added.id,
      category: scenario === 'mixed-diagnoses' ? 'judgment' : 'boundary', evidenceRefs: [`feedback:${added.id}`] });
    f.runtime.execute = async () => ({ ...f.envelope, value: response });
    expect(await f.adapter().generate(input), scenario).toMatchObject({ execution: 'failed', candidate: null });
    f.runtime.execute = async () => ({ ...f.envelope, value: noMutation(response, 'abstain') });
    expect(await f.adapter().generate(input), scenario).toMatchObject({ execution: 'succeeded', status: 'no_rule_change', candidate: null });
  }
  expect(await f.store.listRevisionCandidates()).toEqual([]);
}, 30_000);

it('cannot downgrade new generation to the legacy unrestrained worker response', async () => {
  const f = await fixture(), legacy = JSON.parse(await readFile(new URL('./fixtures/revision-v1-record.json', import.meta.url), 'utf8'));
  f.runtime.execute = async () => legacy.input.executionReceipt.workerResult;
  expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', stage: 'output', error: 'Revision worker policy contract mismatch', candidate: null });
  expect(await f.store.listRevisionCandidates()).toEqual([]);
}, 30_000);

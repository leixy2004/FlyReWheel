import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceDigest } from '../src/adapters/candidates.js';
import { digestOf } from '../src/core/identity.js';
import { RevisionCandidateSchema, RevisionExecutionReceiptSchema } from '../src/core/revision-generation.js';
import { RevisionModelResponseSchema } from '../src/core/revision-model.js';
import { buildRevisionModelInput, buildRevisionWorkspaceRequest, validateExecutedRevisionCandidate, validateRevisionModelResponse } from '../src/revision-generation.js';
import { createRevisionWorkspaceModelAdapter, readTrustedRevisionCandidate, type RevisionWorkspaceModelOutcome, type TrustedRevisionCandidate } from '../src/adapters/revision-model.js';
import { generateRuleRevision } from '../src/rule-revision.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { cleanupWorkspace } from '../src/workspace/index.js';
import { revisionGenerationFixture, revisionConfig, revisionDate, revisionLimits } from './helpers/revision-generation-fixture.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(db?: Database, unregisteredFeedbackSource = false) { const value = await revisionGenerationFixture(db, unregisteredFeedbackSource); cleanup.push(value.cleanup); return value; }
function candidate(result: RevisionWorkspaceModelOutcome) {
  expect(result, JSON.stringify(result)).toMatchObject({ execution: 'succeeded', status: 'candidate_requires_review' });
  if (result.execution !== 'succeeded' || result.status !== 'candidate_requires_review') throw new Error('Missing generated candidate'); return result;
}

it('runs authored official SDK output through persistence, comparison and local acceptance without activation or human truth', async () => {
  const f = await fixture(); await f.sdk();
  const generated = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: f.input.candidateId,
    candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
  const result = candidate(generated);
  if (!('saved' in generated)) throw new Error('Missing stored candidate');
  expect(result).toMatchObject({ modelExecution: 'not_run', candidate: { source: 'fixture', synthesis: 'not_run', activation: 'not_performed',
    semanticValidation: 'not_run', regressionExecution: 'not_run', diagnosis: 'model-proposal-not-ground-truth' } });
  expect(result.executionReceipt.workerResult.sessionId).toBe('authored-sdk-session');
  expect(result.candidateInput.rule.provenance.sourceCases).toEqual(f.baseInput.provenance.sourceCases);
  expect(result.candidateInput.rule.regressionCases).toEqual(f.baseInput.regressionCases);
  const args = await readFile(join(f.directory, 'sdk-args.json'), 'utf8');
  expect(args).toContain('shell_tool=false'); expect(args).toContain('unified_exec=false'); expect(args).toContain('read-only');
  expect(args).toContain('project_doc_max_bytes=0'); expect(args).toContain('web_search=');
  const saved = generated.saved;
  expect(await f.store.saveRevisionModelCandidate(result.persistence)).toEqual(saved);
  expect(await f.store.listRevisionCandidates(f.request.digest)).toEqual([saved]);
  const rule = await f.store.getRuleVersion(saved.candidate.ruleDigest);
  const review = await f.store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: f.snapshot.digest, fixtures: f.fixtures(rule, ['violation', 'safe']) });
  const comparison = await f.store.createRevisionComparison({ id: 'generated-comparison', requestDigest: f.request.digest, candidateRuleDigest: rule.digest,
    reviewPairs: [{ baseReviewId: f.baseReview.id, candidateReviewId: review.id }], caseBindings: f.cases.map(item => ({ caseId: item.id, baseReviewId: f.baseReview.id })) });
  expect(comparison.comparison.summary).toMatchObject({ status: 'compatible', preserved: 1, corrected: 2 });
  const decision = await f.store.recordRevisionDecision({ id: 'generated-decision', comparisonDigest: comparison.digest, choice: 'accept', actor: 'fixture', source: 'fixture', reason: 'Local authored acceptance only', createdAt: revisionDate });
  expect(decision.decision.activation).toBe('not_performed'); expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
  expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Unknown');
  expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
  expect(await f.store.getProblemCase('safe-case')).toEqual(f.cases[1]);
  await f.closeStore(); const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db'));
  try { expect(await reopened.getRevisionCandidate(saved.digest)).toEqual(saved); expect(await reopened.getRevisionComparison(comparison.digest)).toEqual(comparison); expect(await reopened.getRevisionDecision(decision.digest)).toEqual(decision); }
  finally { await reopened.close(); }
  expect((await cleanupWorkspace(f.workspace)).record.status).toBe('closed-clean');
}, 60_000);

it('a generated proposal that fixes selected FP but regresses a known positive cannot be accepted', async () => {
  const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input)); await f.store.saveRevisionModelCandidate(outcome.persistence);
  const rule = await f.store.getRuleVersion(outcome.candidate.ruleDigest);
  const review = await f.store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: f.snapshot.digest, fixtures: f.fixtures(rule, ['safe', 'safe']) });
  const comparison = await f.store.createRevisionComparison({ id: 'regression', requestDigest: f.request.digest, candidateRuleDigest: rule.digest,
    reviewPairs: [{ baseReviewId: f.baseReview.id, candidateReviewId: review.id }], caseBindings: f.cases.map(item => ({ caseId: item.id, baseReviewId: f.baseReview.id })) });
  expect(comparison.comparison.summary).toMatchObject({ status: 'regressed', regressed: 1, corrected: 2 });
  await expect(f.store.recordRevisionDecision({ id: 'blocked-accept', comparisonDigest: comparison.digest, choice: 'accept', actor: 'fixture', source: 'fixture', reason: 'Attempt acceptance', createdAt: revisionDate })).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
}, 30_000);

it('freezes only selected feedback and excerpts; later feedback, unrelated source text and decisions do not enter generation', async () => {
  const f = await fixture(), before = buildRevisionModelInput(f.input, revisionConfig);
  await f.store.appendReviewFeedback({ ...f.feedback, id: 'later-feedback', source: 'local-human-declared', label: 'TP', reason: 'FUTURE_ONLY_SECRET', createdAt: '2026-10-03T00:00:00Z' });
  const after = buildRevisionModelInput({ ...f.input, ...await f.store.getRevisionGenerationEvidence(f.request.digest) }, revisionConfig);
  expect(after).toEqual(before); expect(after.generation.prompt).not.toContain('FUTURE_ONLY_SECRET');
  expect(after.generation.prompt).not.toContain('guard(one); danger(one);');
  expect(after.generation.prompt).toContain('danger(one)'); expect(after.generation.prompt).toContain('anchor-scoped-declaration-not-whole-file-label');
  expect(after.generation.prompt).toContain('isolation":"not-attested-by-sdk-policy');
  expect(buildRevisionWorkspaceRequest(after, revisionLimits).toolPolicy).toBe('selected-evidence-no-tools-v1');
  const mutable = structuredClone(f.input);
  f.runtime.execute = async () => { mutable.request.request.requestedChange = 'mutated'; mutable.cases[0].expected = 'safe'; return f.envelope; };
  const outcome = candidate(await f.adapter().generate(mutable));
  expect(outcome.candidateInput.rule.regressionCases).toEqual(f.baseInput.regressionCases);
  expect(validateExecutedRevisionCandidate(outcome.candidateInput, before.graph)).toEqual(outcome.candidate);
}, 30_000);

it('retains insufficient evidence diagnoses and receipt without a rule candidate', async () => {
  const f = await fixture();
  f.runtime.execute = async () => ({ ...f.envelope, value: { ...f.value, result: { status: 'no_rule_change', operator: 'abstain', nextStep: 'Capture the missing policy before another proposal', reasoning: 'Policy absent', missingEvidence: ['policy'], evidenceRefs: [],
    diagnoses: [{ feedbackId: f.feedback.id, category: 'insufficient_evidence', reasoning: 'Policy absent', missingEvidence: ['policy'], evidenceRefs: [`feedback:${f.feedback.id}`], claim: 'proposal-not-established-fact' }] } } });
  const outcome = await f.adapter().generate(f.input);
  expect(outcome).toMatchObject({ execution: 'succeeded', modelExecution: 'not_run', status: 'no_rule_change', candidate: null, executionReceipt: { cleanup: 'verified' } });
  expect(outcome).not.toHaveProperty('persistence'); expect(await f.store.listRevisionCandidates()).toEqual([]);
}, 30_000);

it('rejects JSON/copy capabilities and self-declared provenance without saving anything', async () => {
  const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input));
  for (const forged of [outcome.candidateInput, outcome.candidate, JSON.parse(JSON.stringify(outcome.persistence)), {}, null]) await expect(f.store.saveRevisionModelCandidate(forged as TrustedRevisionCandidate)).rejects.toThrow('trusted runtime capability');
  expect(readTrustedRevisionCandidate(outcome.persistence)).toEqual(outcome.candidateInput);
  expect(() => { readTrustedRevisionCandidate(outcome.persistence).rule.semantics.title = 'changed'; }).toThrow();
  expect(await f.store.listRevisionCandidates()).toEqual([]); expect(await f.store.listRuleVersions()).toHaveLength(1);
  expect(RevisionCandidateSchema.safeParse({ ...outcome.candidate, source: 'model' }).success).toBe(false);
  expect(RevisionExecutionReceiptSchema.safeParse({ ...outcome.executionReceipt, modelExecution: 'completed' }).success).toBe(false);
}, 30_000);

it('rederives exact receipt, response, parent, version, source and regression bindings', async () => {
  const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input));
  for (const field of ['requestDigest', 'baseRuleDigest', 'inputDigest', 'generationDigest', 'promptDigest', 'responseDigest', 'workspaceRequestDigest', 'runtimeResultDigest'] as const) {
    const input = structuredClone(outcome.candidateInput); input.executionReceipt[field] = 'f'.repeat(64);
    expect(() => validateExecutedRevisionCandidate(input, f.input)).toThrow(/binding/);
  }
  for (const change of [
    (x: typeof outcome.candidateInput) => { x.id = 'substituted-id'; },
    (x: typeof outcome.candidateInput) => { x.rule.provenance.createdAt = '2026-10-03T00:00:00Z'; },
    (x: typeof outcome.candidateInput) => { x.rule.version = 'wrong'; },
    (x: typeof outcome.candidateInput) => { x.rule.provenance.parentDigest = 'f'.repeat(64); },
    (x: typeof outcome.candidateInput) => { x.rule.provenance.sourceCases[0].commit = 'f'.repeat(40); },
    (x: typeof outcome.candidateInput) => { x.rule.regressionCases[0].role = 'negative'; },
    (x: typeof outcome.candidateInput) => { x.rule.regressionCases = []; },
    (x: typeof outcome.candidateInput) => { x.executionReceipt.model = 'changed'; },
    (x: typeof outcome.candidateInput) => { x.executionReceipt.workerResult.sessionId = 'changed'; },
    (x: typeof outcome.candidateInput) => { x.executionReceipt.lifecycle.pop(); },
  ]) { const input = structuredClone(outcome.candidateInput); change(input); expect(() => validateExecutedRevisionCandidate(input, f.input)).toThrow(); }
}, 30_000);

it('fails atomic candidate persistence without orphaning a rule and supports retry of the same capability', async () => {
  const db = await openPGliteDatabase(); let fail = true;
  const wrapped: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, params) => {
    if (fail && sql.startsWith('INSERT INTO qe_revision_candidates(')) throw new Error('Authored write failure'); return tx.query(sql, params);
  } })) };
  const f = await fixture(wrapped), outcome = candidate(await f.adapter().generate(f.input));
  await expect(f.store.saveRevisionModelCandidate(outcome.persistence)).rejects.toThrow('Authored write failure');
  expect(await f.store.listRuleVersions()).toHaveLength(1); expect(await f.store.listRevisionCandidates()).toEqual([]);
  fail = false; expect((await f.store.saveRevisionModelCandidate(outcome.persistence)).candidate).toEqual(outcome.candidate);
}, 30_000);

it('read validation rejects a tampered receipt even after recomputing the candidate digest', async () => {
  const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input)), saved = await f.store.saveRevisionModelCandidate(outcome.persistence);
  await f.db.exec('ALTER TABLE qe_revision_candidates DISABLE TRIGGER qe_revision_candidates_immutable');
  const forged = structuredClone(saved.candidate); forged.executionReceipt.promptDigest = 'f'.repeat(64); const digest = digestOf(forged);
  await f.db.query('UPDATE qe_revision_candidates SET digest=$1,payload=$2::jsonb WHERE digest=$3', [digest, JSON.stringify(forged), saved.digest]);
  await expect(f.store.getRevisionCandidate(digest)).rejects.toThrow('binding mismatch');
}, 30_000);

it('rejects registered heldout source aliases before generation and again before save', async () => {
  const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input));
  // Simulate a registry corruption/late classification without relabeling any case.
  await f.db.exec('ALTER TABLE qe_source_splits DISABLE TRIGGER ALL');
  await f.db.query("UPDATE qe_source_splits SET split='holdout' WHERE digest=$1", [f.cases[1].sourceDigest]);
  await expect(f.store.getRevisionGenerationEvidence(f.request.digest)).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  await expect(f.store.saveRevisionModelCandidate(outcome.persistence)).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  expect(await f.store.listRevisionCandidates()).toEqual([]);
}, 30_000);

it('reserves previously unregistered consumed content before generation, even when generation fails, without labeling files', async () => {
  const f = await fixture(undefined, true);
  const heldout = { ...f.cases[1], id: 'future-holdout', lineageId: 'future-holdout', split: 'holdout' as const, expected: 'unknown' as const };
  const before = await f.db.query("SELECT * FROM qe_source_splits WHERE digest=$1", [heldout.sourceDigest]); expect(before.rows).toEqual([]);
  f.runtime.execute = async () => { throw new Error('Authored failed attempt after source reservation'); };
  expect(await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: 'failure', candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency)).toMatchObject({ execution: 'failed' });
  await expect(f.store.importProblemCase(heldout)).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
  await expect(f.store.getProblemCase(heldout.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Unknown');
  expect(await f.store.listRevisionCandidates()).toEqual([]);
}, 30_000);

it('serializes concurrent holdout registration and source reservation so both cannot succeed', async () => {
  const f = await fixture(undefined, true);
  const heldout = { ...f.cases[1], id: 'concurrent-holdout', lineageId: 'concurrent-holdout', split: 'holdout' as const };
  const results = await Promise.allSettled([f.store.prepareRevisionGeneration(f.request.digest), f.store.importProblemCase(heldout)]);
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  const reverse = await fixture(undefined, true);
  await reverse.store.importProblemCase({ ...reverse.cases[1], id: 'prior-holdout', lineageId: 'prior-holdout', split: 'holdout' });
  await expect(reverse.store.prepareRevisionGeneration(reverse.request.digest)).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
}, 30_000);

describe('fail-closed bounded generation', () => {
  it('requires exact selected graph and prevents future feedback, added cases/snapshots, heldout cases and forged sources', async () => {
    const f = await fixture();
    for (const change of [
      (x: typeof f.input) => { x.request.digest = 'f'.repeat(64); },
      (x: typeof f.input) => { x.feedback[0].feedback.reason = 'changed'; },
      (x: typeof f.input) => { x.feedback[0].finding.anchor.span.end.offset++; },
      (x: typeof f.input) => { x.feedback = []; },
      (x: typeof f.input) => { x.cases.push(x.cases[0]); },
      (x: typeof f.input) => { x.cases[0].split = 'holdout'; },
      (x: typeof f.input) => { x.cases[0].commit = 'f'.repeat(40); },
      (x: typeof f.input) => { x.snapshots.push(x.snapshots[0]); },
      (x: typeof f.input) => { x.context.snapshotDigest = 'f'.repeat(64); },
    ]) { const input = structuredClone(f.input); change(input); expect(() => buildRevisionModelInput(input, revisionConfig)).toThrow(); }
    const future = structuredClone(f.input); future.feedback[0].feedback.createdAt = '2027-01-01T00:00:00Z';
    future.request.request.feedbackBindings[0].digest = digestOf(future.feedback[0].feedback); future.request.digest = digestOf(future.request.request);
    expect(() => buildRevisionModelInput(future, revisionConfig)).toThrow('postdates');
    expect(() => buildRevisionModelInput(f.input, { ...revisionConfig, limits: { ...revisionLimits, maxInputBytes: 50 } })).toThrow();
    expect(() => buildRevisionWorkspaceRequest(buildRevisionModelInput(f.input, revisionConfig), { ...revisionLimits, maxOutputBytes: 262144 })).toThrow();
    expect(f.calls).toEqual([]);
  }, 30_000);

  it.each(['parent', 'version', 'request', 'citation', 'missing-base', 'missing-diagnosis', 'wrong-feedback', 'duplicate-diagnosis', 'labels', 'provenance', 'regressionCases', 'scope', 'activation', 'whole-file-safe', 'unknown-category', 'empty-missing'])(
    'rejects %s model output without authority after cleanup', async kind => {
      const f = await fixture(), value = structuredClone(f.envelope), response = value.value;
      if (response.result.status !== 'candidate') throw new Error('fixture');
      if (kind === 'parent') response.baseRuleDigest = 'f'.repeat(64);
      else if (kind === 'version') response.requestedRuleVersion = 'wrong';
      else if (kind === 'request') response.requestDigest = 'f'.repeat(64);
      else if (kind === 'citation') response.result.evidenceRefs.push('evidence:invented');
      else if (kind === 'missing-base') response.result.evidenceRefs.shift();
      else if (kind === 'missing-diagnosis') response.result.diagnoses = [];
      else if (kind === 'wrong-feedback') response.result.diagnoses[0].feedbackId = 'unselected';
      else if (kind === 'duplicate-diagnosis') response.result.diagnoses.push(response.result.diagnoses[0]);
      else if (kind === 'unknown-category') Object.assign(response.result.diagnoses[0], { category: 'confirmed_safe' });
      else if (kind === 'empty-missing') response.result.diagnoses[0].category = 'insufficient_evidence';
      else Object.assign(response.result, { [kind]: 'model-authored-forbidden' });
      f.runtime.execute = async () => value;
      expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', modelExecution: 'not_run', stage: 'output', candidate: null, runtimeResult: { cleanup: 'verified' } });
      expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']); expect(await f.store.listRevisionCandidates()).toEqual([]);
    }, 30_000);

  it.each(['boundary', 'supervision', 'exit', 'stop', 'bytes', 'legacy-envelope'])(
    'rejects %s execution envelope', async kind => {
      const f = await fixture(), value = structuredClone(f.envelope);
      if (kind === 'boundary') value.boundary = 'isolated-runtime';
      if (kind === 'supervision') value.processEvidence.reason = 'timeout';
      if (kind === 'exit') value.processEvidence.exitCode = 1;
      if (kind === 'stop') value.processEvidence.processGroupStopped = false;
      if (kind === 'bytes') value.processEvidence.stdoutBytes = revisionLimits.maxOutputBytes + 1;
      if (kind === 'legacy-envelope') value.protocolVersion = 1;
      f.runtime.execute = async () => value;
      expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', candidate: null, runtimeResult: { cleanup: 'verified' } });
    }, 30_000);

  it('SDK no-tools contract rejects observed command events after bounded cleanup', async () => {
    const f = await fixture(); await f.sdk({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'echo forbidden', aggregated_output: '', exit_code: 0, status: 'completed' } });
    expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', candidate: null, runtimeResult: { cleanup: 'verified' } });
    expect(await f.store.listRevisionCandidates()).toEqual([]);
  }, 30_000);

  it('keeps disabled/unavailable/cancelled runs unallocated and waits for timeout cleanup', async () => {
    const f = await fixture();
    expect(await createRevisionWorkspaceModelAdapter({ ...revisionConfig, enabled: false }, f.dependency).generate(f.input)).toMatchObject({ reason: 'disabled' });
    expect(await createRevisionWorkspaceModelAdapter(revisionConfig).generate(f.input)).toMatchObject({ reason: 'runtime_unavailable' });
    const controller = new AbortController(); controller.abort();
    expect(await f.adapter().generate(f.input, controller.signal)).toMatchObject({ reason: 'cancelled' }); expect(f.calls).toEqual([]);
    f.runtime.execute = async () => new Promise(() => {});
    expect(await createRevisionWorkspaceModelAdapter(revisionConfig, { ...f.dependency, limits: { ...revisionLimits, timeoutMs: 50 } }).generate(f.input)).toMatchObject({ execution: 'failed', candidate: null, runtimeResult: { execution: 'timed-out', cleanup: 'verified' } });
    expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
  }, 30_000);
});

it('preserves Unknown/Disputed and multiple selected feedback on one finding without changing human verdicts', async () => {
  const f = await fixture();
  const unknown = await f.store.appendReviewFeedback({ ...f.feedback, id: 'selected-unknown', source: 'local-human-declared', label: 'Unknown', reason: 'Unresolved context' });
  const disputed = await f.store.appendReviewFeedback({ ...f.feedback, id: 'selected-disputed', source: 'local-human-declared', label: 'Disputed', reason: 'Conflicting interpretation' });
  const { schemaVersion, kind, status, feedbackBindings, synthesis, ...requestInput } = f.request.request;
  const request = await f.store.createRevisionRequest({ ...requestInput, id: 'multiple-selected', feedbackIds: [f.feedback.id, unknown.id, disputed.id] });
  const input = { ...f.input, ...await f.store.getRevisionGenerationEvidence(request.digest) }, prepared = buildRevisionModelInput(input, revisionConfig);
  const response = structuredClone(f.value); response.requestDigest = request.digest;
  if (response.result.status !== 'candidate') throw new Error('fixture');
  response.result.evidenceRefs.push(`feedback:${unknown.id}`, `feedback:${disputed.id}`);
  response.result.diagnoses.push({ ...response.result.diagnoses[0], feedbackId: unknown.id, category: 'context', evidenceRefs: [`feedback:${unknown.id}`] },
    { ...response.result.diagnoses[0], feedbackId: disputed.id, category: 'judgment', evidenceRefs: [`feedback:${disputed.id}`] });
  expect(() => validateRevisionModelResponse(prepared, response)).toThrow('diagnosis/operator mismatch');
  expect(prepared.generation.prompt).toContain('"label":"Unknown"'); expect(prepared.generation.prompt).toContain('"label":"Disputed"');
  const abstention = { ...response, result: { status: 'no_rule_change', operator: 'abstain', reasoning: 'Selected feedback and diagnoses conflict',
    nextStep: 'Resolve the uncertainty before changing a rule', missingEvidence: [], evidenceRefs: response.result.evidenceRefs, diagnoses: response.result.diagnoses } };
  expect(validateRevisionModelResponse(prepared, abstention)).toEqual(abstention);
  f.runtime.execute = async () => ({ ...f.envelope, value: abstention });
  expect(await f.adapter().generate(input)).toMatchObject({ execution: 'succeeded', status: 'no_rule_change', candidate: null });
  expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Disputed');
  expect(await f.store.getProblemCase('safe-case')).toEqual(f.cases[1]);
}, 30_000);

it('withholds acceptance when cancelled during cleanup and when cleanup remains unverified', async () => {
  const f = await fixture(), controller = new AbortController();
  f.runtime.stop = async () => { controller.abort(); return { stopped: true, verified: true }; };
  const cancelled = await f.adapter().generate(f.input, controller.signal);
  expect(cancelled).toMatchObject({ execution: 'failed', candidate: null, runtimeResult: { cleanup: 'verified' } });
  expect(cancelled).not.toHaveProperty('persistence');
  f.runtime.stop = async () => ({ stopped: false, verified: false });
  const unverified = await f.adapter().generate(f.input);
  expect(unverified).toMatchObject({ execution: 'failed', candidate: null, runtimeResult: { cleanup: 'retained-for-recovery' } });
  expect(unverified).not.toHaveProperty('persistence'); expect(await f.store.listRevisionCandidates()).toEqual([]);
}, 30_000);


it('late holdout registration of unconsumed snapshot content does not invalidate a frozen generated candidate', async () => {
  const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input));
  const saved = await f.store.saveRevisionModelCandidate(outcome.persistence);
  await f.store.importProblemCase({ ...f.cases[0], id: 'unconsumed-holdout', lineageId: 'unconsumed-holdout', split: 'holdout', expected: 'unknown',
    path: 'src/unselected.ts', sourceDigest: sourceDigest('export const unrelated = 0;\n') });
  expect(await f.store.getRevisionCandidate(saved.digest)).toEqual(saved);
  expect(buildRevisionModelInput(await f.store.prepareRevisionGeneration(f.request.digest).then(graph => ({ ...f.input, ...graph })), revisionConfig).generation.prompt).not.toContain('export const unrelated = 0');
}, 30_000);

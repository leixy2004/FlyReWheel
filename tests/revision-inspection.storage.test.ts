import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { RevisionCandidateSchema, type StoredRevisionCandidate, type StoredRevisionNoMutationOutcome } from '../src/core/revision-generation.js';
import { revisionInspection, revisionInspectionSummary } from '../src/cli-revision-inspection.js';
import { buildRevisionModelInput } from '../src/revision-generation.js';
import { QualEvoStore, RevisionCatalogPageSchema, RevisionCandidatePageSchema, RevisionComparisonPageSchema } from '../src/storage/store.js';
import { revisionComparisonFixture, comparisonDate } from './helpers/revision-comparison-fixture.js';
import { revisionGenerationFixture, revisionDate, revisionConfig } from './helpers/revision-generation-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});
type Fixture = Awaited<ReturnType<typeof revisionGenerationFixture>>;
async function fixture(withContext = false) {
  const f = await revisionGenerationFixture(undefined, false, withContext);
  cleanup.push(f.cleanup);
  return f;
}
async function request(f: Fixture, id: string, feedbackIds = [f.feedback.id], version = 'generated') {
  return f.store.createRevisionRequest({ id, baseRuleDigest: f.baseRule.digest, requestedRuleVersion: version,
    feedbackIds, requestedChange: 'Inspect this exact frozen feedback selection', actor: 'authored-fixture',
    source: 'fixture', createdAt: revisionDate });
}
async function generate(f: Fixture, id: string, kind: 'candidate' | 'outcome', requestDigest = f.request.digest) {
  const graph = await f.store.getRevisionGenerationEvidence(requestDigest);
  const input = { ...f.input, ...graph, candidateId: id };
  const bindings = buildRevisionModelInput(input, revisionConfig).repositoryContextBindings;
  const contextRefs = (feedbackId: string) => bindings.find(binding => binding.feedbackId === feedbackId)?.evidenceRefs.map(ref => `evidence:${ref}`) ?? [];
  const evidenceRefs = [...new Set([`rule:${graph.baseRule.digest}`, ...graph.feedback.flatMap(({ feedback, finding }) =>
    [`feedback:${feedback.id}`, `finding:${finding.id}`, ...contextRefs(feedback.id)])])];
  const diagnoses = graph.feedback.map(({ feedback, finding }) => ({ feedbackId: feedback.id,
    category: kind === 'candidate' ? 'boundary' as const : 'context' as const,
    reasoning: 'Authored proposal, not an established diagnosis', missingEvidence: [],
    evidenceRefs: [`feedback:${feedback.id}`, `finding:${finding.id}`, ...contextRefs(feedback.id)], claim: 'proposal-not-established-fact' as const }));
  const value = { ...f.value, requestDigest, requestedRuleVersion: graph.request.request.requestedRuleVersion,
    result: kind === 'candidate' ? { ...f.value.result, evidenceRefs, diagnoses } : {
      status: 'no_rule_change', operator: 'request_context', reasoning: 'Applicable guard policy is missing',
      nextStep: 'Obtain the applicable guard policy for the selected anchor', missingEvidence: ['Applicable guard policy'], evidenceRefs, diagnoses,
    } };
  f.runtime.execute = async () => ({ ...f.envelope, value });
  const generated = await f.adapter().generate(input);
  if (generated.execution !== 'succeeded') throw new Error(JSON.stringify(generated));
  return generated;
}
async function candidate(f: Fixture, id: string, requestDigest = f.request.digest): Promise<StoredRevisionCandidate> {
  const generated = await generate(f, id, 'candidate', requestDigest);
  if (generated.status !== 'candidate_requires_review') throw new Error('Expected an authored candidate');
  return f.store.saveRevisionModelCandidate(generated.persistence);
}
async function outcome(f: Fixture, id: string, requestDigest = f.request.digest): Promise<StoredRevisionNoMutationOutcome> {
  const generated = await generate(f, id, 'outcome', requestDigest);
  if (generated.status !== 'no_rule_change') throw new Error('Expected an authored no-mutation outcome');
  return f.store.saveRevisionModelOutcome(generated.outcomePersistence);
}
const digestOrder = <T extends { digest: string }>(values: T[]) => values.slice().sort((a, b) => a.digest.localeCompare(b.digest));

it('pages candidate and outcome catalogs by exclusive digest with exact filters and a default of 20', async () => {
  const f = await fixture(), candidates: StoredRevisionCandidate[] = [], outcomes: StoredRevisionNoMutationOutcome[] = [];
  for (let i = 0; i < 21; i++) {
    candidates.push(await candidate(f, `candidate-${i}`));
    outcomes.push(await outcome(f, `outcome-${i}`));
  }
  const otherRequest = await request(f, 'other-request', undefined, 'other-version');
  const otherCandidate = await candidate(f, 'other-candidate', otherRequest.digest);
  const otherOutcome = await outcome(f, 'other-outcome', otherRequest.digest);
  const callsBeforeRead = [...f.calls];
  const sortedCandidates = digestOrder(candidates), sortedOutcomes = digestOrder(outcomes);
  expect(await f.store.listRevisionCandidates({ requestDigest: f.request.digest })).toEqual(sortedCandidates.slice(0, 20));
  expect(await f.store.listRevisionOutcomes({ requestDigest: f.request.digest })).toEqual(sortedOutcomes.slice(0, 20));
  expect(await f.store.listRevisionCandidates({ requestDigest: f.request.digest, after: sortedCandidates[19].digest })).toEqual(sortedCandidates.slice(20));
  expect(await f.store.listRevisionOutcomes({ requestDigest: f.request.digest, after: sortedOutcomes[19].digest })).toEqual(sortedOutcomes.slice(20));
  expect(await f.store.listRevisionCandidates({ requestDigest: f.request.digest, after: sortedCandidates[20].digest })).toEqual([]);
  expect(await f.store.listRevisionOutcomes({ requestDigest: f.request.digest, after: sortedOutcomes[20].digest })).toEqual([]);
  expect(await f.store.listRevisionCandidates({ limit: 100 })).toEqual(digestOrder([...candidates, otherCandidate]));
  expect(await f.store.listRevisionOutcomes({ limit: 100 })).toEqual(digestOrder([...outcomes, otherOutcome]));
  expect(await f.store.listRevisionCandidates(f.request.digest)).toEqual(sortedCandidates);
  expect(await f.store.listRevisionOutcomes(f.request.digest)).toEqual(sortedOutcomes);
  expect(await f.store.listRevisionCandidates({ id: candidates[0].candidate.id, ruleDigest: candidates[0].candidate.ruleDigest, requestDigest: f.request.digest, limit: 1 })).toEqual([candidates[0]]);
  expect(await f.store.listRevisionOutcomes({ id: outcomes[0].outcome.id, requestDigest: f.request.digest, limit: 1 })).toEqual([outcomes[0]]);
  expect(await f.store.listRevisionCandidates({ ruleDigest: otherCandidate.candidate.ruleDigest })).toEqual([otherCandidate]);
  expect(await f.store.listRevisionCandidates({ requestDigest: f.request.digest, ruleDigest: otherCandidate.candidate.ruleDigest })).toEqual([]);
  expect(await f.store.listRevisionCandidates({ requestDigest: otherRequest.digest, id: candidates[0].candidate.id })).toEqual([]);
  expect(await f.store.listRevisionOutcomes({ requestDigest: otherRequest.digest, id: outcomes[0].outcome.id })).toEqual([]);
  for (const list of [f.store.listRevisionCandidates.bind(f.store), f.store.listRevisionOutcomes.bind(f.store)]) {
    expect(await list({ after: 'f'.repeat(64), limit: 1 })).toEqual([]);
    expect(await list({ requestDigest: 'f'.repeat(64) })).toEqual([]);
    expect(await list({ id: 'not-present' })).toEqual([]);
  }
  expect(f.calls).toEqual(callsBeforeRead);
}, 60_000);

it('rejects malformed page options before discovering records', async () => {
  const store = await QualEvoStore.openPGlite(); cleanup.push(() => store.close());
  for (const schema of [RevisionCatalogPageSchema, RevisionCandidatePageSchema, RevisionComparisonPageSchema]) {
    expect(schema.parse({})).toEqual({ limit: 20 });
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: NaN }, { limit: '20' },
      { after: 'bad' }, { requestDigest: 'bad' }, { extra: true }, []]) expect(schema.safeParse(options).success).toBe(false);
  }
  const lists = [store.listRevisionCandidates.bind(store), store.listRevisionOutcomes.bind(store), store.listRevisionComparisons.bind(store)];
  for (const list of lists) {
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: 'bad' }, { requestDigest: 'bad' }]) await expect(list(options)).rejects.toThrow();
    expect(await list({})).toEqual([]);
  }
  await expect(store.listRevisionCandidates({ id: '' })).rejects.toThrow();
  await expect(store.listRevisionCandidates({ ruleDigest: 'bad' })).rejects.toThrow();
  await expect(store.listRevisionOutcomes({ id: '' })).rejects.toThrow();
  await expect(store.listRevisionComparisons({ candidateRuleDigest: 'bad' })).rejects.toThrow();
  expect(RevisionCatalogPageSchema.safeParse({ ruleDigest: 'a'.repeat(64) }).success).toBe(false);
  expect(RevisionComparisonPageSchema.safeParse({ id: 'unsupported' }).success).toBe(false);
}, 30_000);

it('preserves the legacy over-100 failure while allowing exact cursor-page selections', async () => {
  const f = await fixture(), savedCandidate = await candidate(f, 'valid-candidate'), savedOutcome = await outcome(f, 'valid-outcome');
  // These deliberately undecodable rows test cardinality only: legacy APIs must fail before reading payloads.
  for (let i = 1; i <= 100; i++) {
    const digest = i.toString(16).padStart(64, '0'), id = `over-limit-${i}`;
    await f.db.query('INSERT INTO qe_revision_candidates(digest,id,request_digest,rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
      [digest, id, f.request.digest, savedCandidate.candidate.ruleDigest, '{}']);
    await f.db.query('INSERT INTO qe_revision_outcomes(digest,id,request_digest,payload) VALUES($1,$2,$3,$4::jsonb)',
      [digest, id, f.request.digest, '{}']);
  }
  for (const list of [f.store.listRevisionCandidates.bind(f.store), f.store.listRevisionOutcomes.bind(f.store)]) {
    await expect(list()).rejects.toMatchObject({ code: 'LIST_LIMIT' });
    await expect(list(f.request.digest)).rejects.toMatchObject({ code: 'LIST_LIMIT' });
    expect(await list('f'.repeat(64))).toEqual([]);
  }
  expect(await f.store.listRevisionCandidates({ id: savedCandidate.candidate.id })).toEqual([savedCandidate]);
  expect(await f.store.listRevisionOutcomes({ id: savedOutcome.outcome.id })).toEqual([savedOutcome]);
  const hundredthDigest = (100).toString(16).padStart(64, '0');
  expect(await f.store.listRevisionCandidates({ after: hundredthDigest, limit: 1 })).toEqual([savedCandidate]);
  expect(await f.store.listRevisionOutcomes({ after: hundredthDigest, limit: 1 })).toEqual([savedOutcome]);
  expect(await f.store.listRevisionCandidates({ after: savedCandidate.digest, limit: 1 })).toEqual([]);
  expect(await f.store.listRevisionOutcomes({ after: savedOutcome.digest, limit: 1 })).toEqual([]);
}, 30_000);

it('revalidates selected indexed records and execution receipts instead of trusting catalog columns', async () => {
  const f = await fixture(), savedCandidate = await candidate(f, 'candidate'), savedOutcome = await outcome(f, 'outcome');
  await f.db.exec('ALTER TABLE qe_revision_candidates DISABLE TRIGGER qe_revision_candidates_immutable');
  await f.db.exec('ALTER TABLE qe_revision_outcomes DISABLE TRIGGER qe_revision_outcomes_immutable');
  await f.db.query('UPDATE qe_revision_candidates SET id=$1 WHERE digest=$2', ['wrong-indexed-id', savedCandidate.digest]);
  await f.db.query('UPDATE qe_revision_outcomes SET id=$1 WHERE digest=$2', ['wrong-indexed-id', savedOutcome.digest]);
  await expect(f.store.listRevisionCandidates({ id: 'wrong-indexed-id' })).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.listRevisionOutcomes({ id: 'wrong-indexed-id' })).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  const forgedCandidate = structuredClone(savedCandidate.candidate), forgedOutcome = structuredClone(savedOutcome.outcome);
  forgedCandidate.executionReceipt.promptDigest = 'f'.repeat(64);
  forgedOutcome.executionReceipt.promptDigest = 'f'.repeat(64);
  await f.db.query('UPDATE qe_revision_candidates SET digest=$1,id=$2,payload=$3::jsonb WHERE digest=$4',
    [digestOf(forgedCandidate), forgedCandidate.id, JSON.stringify(forgedCandidate), savedCandidate.digest]);
  await f.db.query('UPDATE qe_revision_outcomes SET digest=$1,id=$2,payload=$3::jsonb WHERE digest=$4',
    [digestOf(forgedOutcome), forgedOutcome.id, JSON.stringify(forgedOutcome), savedOutcome.digest]);
  await expect(f.store.listRevisionCandidates({ ruleDigest: forgedCandidate.ruleDigest })).rejects.toThrow('binding mismatch');
  await expect(f.store.listRevisionOutcomes({ requestDigest: f.request.digest })).rejects.toThrow('binding mismatch');
  expect(await f.store.listRevisionCandidates({ id: 'not-selected' })).toEqual([]);
  expect(await f.store.listRevisionOutcomes({ id: 'not-selected' })).toEqual([]);
}, 30_000);

it('keeps the inclusive 16MB page boundary for both catalogs after exact-record validation', async () => {
  const f = await fixture();
  const candidates = digestOrder([await candidate(f, 'candidate-1'), await candidate(f, 'candidate-2')]);
  const outcomes = digestOrder([await outcome(f, 'outcome-1'), await outcome(f, 'outcome-2')]);
  const records = new Set([...candidates, ...outcomes].map(value => JSON.stringify(value)));
  const actualByteLength = Buffer.byteLength.bind(Buffer); let recordBytes = 8_000_000;
  // Inflate only final stored-record accounting, leaving schema, graph and receipt validation real.
  vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) =>
    typeof value === 'string' && records.has(value) ? recordBytes : actualByteLength(value, encoding));
  expect(await f.store.listRevisionCandidates({ limit: 2 })).toEqual(candidates);
  expect(await f.store.listRevisionOutcomes({ limit: 2 })).toEqual(outcomes);
  recordBytes++;
  await expect(f.store.listRevisionCandidates({ limit: 2 })).rejects.toMatchObject({ code: 'LIST_LIMIT' });
  await expect(f.store.listRevisionOutcomes({ limit: 2 })).rejects.toMatchObject({ code: 'LIST_LIMIT' });
  expect(await f.store.listRevisionCandidates({ limit: 1 })).toEqual(candidates.slice(0, 1));
  expect(await f.store.listRevisionOutcomes({ limit: 1 })).toEqual(outcomes.slice(0, 1));
}, 30_000);

it('projects archived candidates without inventing an operator or upgrading legacy policies', async () => {
  for (const version of [1, 2]) {
    const historical = JSON.parse(await readFile(new URL(`./fixtures/revision-v${version}-record.json`, import.meta.url), 'utf8'));
    const stored: StoredRevisionCandidate = { digest: historical.stored.digest, candidate: RevisionCandidateSchema.parse(historical.stored.candidate) };
    const before = structuredClone(stored), summary = revisionInspectionSummary(stored);
    expect(summary).toMatchObject({ recordSchemaVersion: version, operator: version === 1 ? null : 'boundary_update',
      policyVersion: version === 1 ? null : 'diagnosis-operators-v1', evidencePolicyVersion: null,
      repositoryContextBindings: [], source: 'fixture', synthesis: 'not_run', modelExecution: 'not_run', certification: 'none' });
    expect(summary.links.comparisons).toEqual(['revisions', 'comparisons', '--request-digest', stored.candidate.requestDigest, '--candidate-rule-digest', stored.candidate.ruleDigest]);
    expect(stored).toEqual(before);
    expect(digestOf(stored.candidate)).toBe(stored.digest);
    // Display projection must copy both independent fields; this copy is never persisted or executed.
    const completed = structuredClone(stored);
    completed.candidate.synthesis = 'completed';
    completed.candidate.executionReceipt.modelExecution = 'completed';
    expect(revisionInspectionSummary(completed)).toMatchObject({ source: 'fixture', synthesis: 'completed', modelExecution: 'completed' });
  }
});

it('shows only frozen selected declarations, keeps fixture verdicts Unknown, and never mutates stored evidence', async () => {
  const f = await fixture(), saved = await candidate(f, 'fixture-candidate');
  const initialGraph = await f.store.getRevisionGenerationEvidence(f.request.digest);
  expect(revisionInspection(saved, initialGraph).selectedFeedback).toEqual([expect.objectContaining({ id: f.feedback.id, source: 'fixture', label: 'FP', selectedVerdict: 'Unknown' })]);
  const human = await f.store.appendReviewFeedback({ ...f.feedback, id: 'selected-human', source: 'local-human-declared', actor: 'declared-reviewer', label: 'FP' });
  const selectedRequest = await request(f, 'selected-human-request', [f.feedback.id, human.id]);
  const selectedCandidate = await candidate(f, 'selected-human-candidate', selectedRequest.digest);
  await f.store.appendReviewFeedback({ ...human, id: 'later-human', label: 'TP', reason: 'LATER_FEEDBACK_MUST_NOT_APPEAR', createdAt: '2026-10-03T00:00:00Z' });
  const graph = await f.store.getRevisionGenerationEvidence(selectedRequest.digest);
  const before = structuredClone({ selectedCandidate, graph }), calls = [...f.calls];
  const inspection = revisionInspection(selectedCandidate, graph);
  expect(inspection.selectedFeedback.map(value => value.id).sort()).toEqual([f.feedback.id, human.id].sort());
  expect(inspection.selectedFeedback).toContainEqual(expect.objectContaining({ id: human.id, source: 'local-human-declared', actor: 'declared-reviewer', label: 'FP', selectedVerdict: 'FP' }));
  expect(inspection.trust).toMatchObject({ identityVerification: 'caller-declared-unverified', verdictScope: 'frozen-selected-feedback-only', certification: 'none', diagnosis: 'proposal-not-established-fact', reviewRepair: 'not_performed' });
  expect(JSON.stringify(inspection)).not.toContain('LATER_FEEDBACK_MUST_NOT_APPEAR');
  expect(revisionInspection(saved, await f.store.getRevisionGenerationEvidence(f.request.digest)).selectedFeedback[0].selectedVerdict).toBe('Unknown');
  expect({ selectedCandidate, graph }).toEqual(before);
  expect(f.calls).toEqual(calls);
  expect(await f.store.getRevisionCandidate(selectedCandidate.digest)).toEqual(selectedCandidate);
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
}, 30_000);

it('projects no-mutation next steps and selected context links without a rule or comparison link', async () => {
  const f = await fixture(true), generated = await outcome(f, 'context-outcome');
  const graph = await f.store.getRevisionGenerationEvidence(f.request.digest), before = structuredClone({ generated, graph });
  const inspection = revisionInspection(generated, graph);
  expect(inspection).toMatchObject({ kind: 'rule-revision-no-mutation', operator: 'request_context', status: 'no_rule_change',
    policyVersion: 'diagnosis-operators-v1', evidencePolicyVersion: 'selected-context-evidence-v1',
    ruleDigest: null, nextStep: 'Obtain the applicable guard policy for the selected anchor', missingEvidence: ['Applicable guard policy'],
    source: 'fixture', modelExecution: 'not_run', activation: 'not_performed', certification: 'none' });
  expect(inspection.links.rule).toBeNull();
  expect(inspection.links.comparisons).toBeNull();
  expect(inspection.links.repositoryContexts).toEqual(f.repositoryContexts!.map(context => ['contexts', 'show', '--digest', context.digest]));
  expect(inspection.repositoryContextBindings).toEqual('repositoryContextBindings' in generated.outcome ? generated.outcome.repositoryContextBindings : []);
  expect(inspection.execution).toMatchObject({ outputContract: 'rule-revision-v3', boundary: 'authored-test-no-isolation', modelIdentity: 'requested-configuration-not-provider-attested' });
  expect({ generated, graph }).toEqual(before);
  expect(await f.store.listRuleVersions()).toEqual([f.baseRule]);
  expect(await f.store.listRevisionCandidates({})).toEqual([]);
}, 30_000);

it('filters and pages comparisons by the exact request and candidate pair while revalidating selected rows', async () => {
  const f = await revisionComparisonFixture(); cleanup.push(() => f.store.close());
  const first = await f.store.createRevisionComparison(f.input);
  const second = await f.store.createRevisionComparison({ ...f.input, id: 'second-comparison' });
  const otherRequest = await f.store.createRevisionRequest({ id: 'other-request', baseRuleDigest: f.baseRule.digest, requestedRuleVersion: f.candidateInput.version,
    feedbackIds: [f.feedback.id], requestedChange: 'Another frozen request for the same candidate', actor: 'fixture', source: 'fixture', createdAt: comparisonDate });
  const other = await f.store.createRevisionComparison({ ...f.input, id: 'other-request-comparison', requestDigest: otherRequest.digest });
  const otherRule = await f.store.importRuleVersion({ ...f.candidateInput, version: 'other-candidate' });
  const otherReview = await f.store.runSemanticReview({ ruleDigest: otherRule.digest, snapshotDigest: f.snapshot.digest, fixtures: f.fixtures(otherRule, 'candidate') });
  const candidateRequest = await f.store.createRevisionRequest({ id: 'other-candidate-request', baseRuleDigest: f.baseRule.digest, requestedRuleVersion: 'other-candidate',
    feedbackIds: [f.feedback.id], requestedChange: 'A separate candidate version', actor: 'fixture', source: 'fixture', createdAt: comparisonDate });
  const otherCandidate = await f.store.createRevisionComparison({ ...f.input, id: 'other-candidate-comparison', requestDigest: candidateRequest.digest,
    candidateRuleDigest: otherRule.digest, reviewPairs: [{ baseReviewId: f.baseReview.id, candidateReviewId: otherReview.id }] });
  const pair = { requestDigest: f.request.digest, candidateRuleDigest: f.candidateRule.digest }, sorted = digestOrder([first, second]);
  expect(await f.store.listRevisionComparisons(pair)).toEqual(sorted);
  expect(await f.store.listRevisionComparisons({ ...pair, limit: 1 })).toEqual(sorted.slice(0, 1));
  expect(await f.store.listRevisionComparisons({ ...pair, after: sorted[0].digest, limit: 1 })).toEqual(sorted.slice(1));
  expect(await f.store.listRevisionComparisons({ ...pair, after: sorted[1].digest })).toEqual([]);
  expect(await f.store.listRevisionComparisons({ ...pair, candidateRuleDigest: otherRule.digest })).toEqual([]);
  expect(await f.store.listRevisionComparisons({ candidateRuleDigest: f.candidateRule.digest })).toEqual(digestOrder([first, second, other]));
  expect(await f.store.listRevisionComparisons({ requestDigest: candidateRequest.digest })).toEqual([otherCandidate]);
  expect(await f.store.listRevisionComparisons({ after: 'f'.repeat(64) })).toEqual([]);
  await f.database.exec('ALTER TABLE qe_rule_revision_comparisons DISABLE TRIGGER qe_rule_revision_comparisons_immutable');
  await f.database.query('UPDATE qe_rule_revision_comparisons SET candidate_rule_digest=$1 WHERE digest=$2', [otherRule.digest, other.digest]);
  await expect(f.store.listRevisionComparisons({ requestDigest: otherRequest.digest, candidateRuleDigest: otherRule.digest })).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  expect(await f.store.listRevisionComparisons(pair)).toEqual(sorted);
}, 30_000);

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import type { ProblemCase, RuleBundle } from '../src/core/model.js';
import type { SemanticRuleVersion } from '../src/core/semantic-rule.js';
import { RevisionComparisonInputSchema, type RevisionComparison } from '../src/core/revision-comparison.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { QualEvoStore } from '../src/storage/store.js';
import {
  comparisonDate, dangerAsset, defaultComparisonCases, revisionComparisonFixture, revisionDecision,
  type ComparisonCaseSpec, type ComparisonFixtureOptions,
} from './helpers/revision-comparison-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(options: ComparisonFixtureOptions = {}) {
  const database = options.database ?? await openPGliteDatabase();
  cleanup.push(() => database.close());
  return revisionComparisonFixture({ ...options, database });
}
const positiveCase = (overrides: Partial<ComparisonCaseSpec> = {}): ComparisonCaseSpec => ({ ...defaultComparisonCases[0], ...overrides });
const safeCase = (overrides: Partial<ComparisonCaseSpec> = {}): ComparisonCaseSpec => ({ ...defaultComparisonCases[1], ...overrides });
const assertNoActivation = async (store: QualEvoStore, ruleId: string) => expect(await store.getActive(ruleId)).toBeNull();

it('derives exact case and cross-rule anchor results, hashes the full report, and leaves trust boundaries explicit', async () => {
  const f = await fixture();
  const saved = await f.store.createRevisionComparison(f.input);
  expect(saved.digest).toBe(digestOf(saved.comparison));
  expect(saved.comparison).toMatchObject({
    input: f.input, baseRuleDigest: f.baseRule.digest, ruleId: f.baseInput.ruleId, baseVersion: 'base', candidateVersion: 'candidate',
    synthesis: 'not_run', activation: 'not_performed',
    trust: { semanticEvidence: 'offline-fixture-declarations', identity: 'caller-declared-unverified', snapshot: 'package-integrity-only', scope: 'declared-cases-and-selected-feedback-only', certification: 'none' },
    summary: { status: 'compatible', preserved: 1, corrected: 2, regressed: 0, stillFailing: 0, inconclusive: 0 },
  });
  expect(saved.comparison.reviewBindings).toEqual([{ baseReviewId: f.baseReview.id, candidateReviewId: f.candidateReview.id, snapshotDigest: f.snapshot.digest, baseReviewDigest: digestOf(f.baseReview), candidateReviewDigest: digestOf(f.candidateReview) }]);
  expect(saved.comparison.cases.map(row => [row.caseId, row.baseRole, row.candidateRole, row.outcome])).toEqual([
    ['positive-case', 'positive', 'positive', 'preserved'], ['safe-case', 'negative', 'fixed', 'corrected'],
  ]);
  for (const row of saved.comparison.cases) expect(row.caseDigest).toBe(digestOf(f.cases.find(value => value.id === row.caseId)));
  expect(saved.comparison.feedback).toEqual([expect.objectContaining({ feedbackId: f.feedback.id, feedbackDigest: digestOf(f.feedback), anchor: f.finding.anchor, expected: 'safe', outcome: 'corrected', base: { state: 'violation', reason: 'explicit_semantic_judgment' }, candidate: { state: 'safe', reason: 'explicit_semantic_judgment' } })]);
  const matching = f.candidateReview.findings.find(value => digestOf(value.anchor) === digestOf(f.finding.anchor))!;
  expect(matching.id).not.toBe(f.finding.id);
  expect(matching.targetId).not.toBe(f.finding.targetId);
  expect(await f.store.getRevisionComparison(saved.digest)).toEqual(saved);
  expect(await f.store.listRevisionComparisons(f.request.digest)).toEqual([saved]);
  expect(await f.store.listRevisionComparisons('f'.repeat(64))).toEqual([]);
  await assertNoActivation(f.store, f.baseInput.ruleId);
}, 30_000);

it('freezes selected feedback, cases and reviews despite later feedback and return-object mutation', async () => {
  const f = await fixture();
  const first = await f.store.createRevisionComparison(f.input), original = structuredClone(first);
  await f.store.appendReviewFeedback({ ...f.feedback, id: 'late-human-disagreement', source: 'local-human-declared', label: 'TP' });
  await f.store.appendReviewFeedback({ ...f.feedback, id: 'late-human-unknown', source: 'local-human-declared', label: 'Unknown' });
  first.comparison.summary.corrected = 999;
  first.comparison.cases[0].base.state = 'unknown';
  expect(await f.store.getRevisionComparison(original.digest)).toEqual(original);
  expect(await f.store.createRevisionComparison(f.input)).toEqual(original);
  expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
  expect(original.comparison.feedback).toHaveLength(1);
  expect(original.comparison.feedback[0].label).toBe('FP');
}, 30_000);

it('records local accept/reject/defer history without activation, synthesis, or changing a pending request', async () => {
  const f = await fixture();
  const comparison = await f.store.createRevisionComparison(f.input), originalRules = await f.store.listRuleVersions();
  const first = await f.store.recordRevisionDecision(revisionDecision(comparison.digest));
  expect(first.digest).toBe(digestOf(first.decision));
  expect(first.decision).toMatchObject({ schemaVersion: 1, kind: 'local-rule-revision-decision', comparisonDigest: comparison.digest,
    requestDigest: f.request.digest, candidateRuleDigest: f.candidateRule.digest, comparisonStatus: 'compatible', choice: 'accept',
    identityVerification: 'caller-declared-unverified', activation: 'not_performed', certification: 'none' });
  expect(await f.store.recordRevisionDecision(revisionDecision(comparison.digest))).toEqual(first);
  expect(await f.store.getRevisionDecision(first.digest)).toEqual(first);
  for (const choice of ['reject', 'defer'] as const) await f.store.recordRevisionDecision(revisionDecision(comparison.digest, { id: `decision-${choice}`, choice, source: 'local-human-declared' }));
  expect(await f.store.listRevisionDecisions(comparison.digest)).toHaveLength(3);
  expect(await f.store.listRevisionDecisions('f'.repeat(64))).toEqual([]);
  expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
  expect((await f.store.getRevisionRequest(f.request.digest)).request).toMatchObject({ status: 'pending', synthesis: 'not_run' });
  expect(await f.store.listRuleVersions()).toEqual(originalRules);
  expect(await f.store.getRevisionComparison(comparison.digest)).toEqual(comparison);
  await assertNoActivation(f.store, f.baseInput.ruleId);
}, 30_000);

describe('both sides and explicit expectations are required', () => {
  it.each([
    ['violation', 'violation', 'preserved', 'compatible'],
    ['safe', 'violation', 'corrected', 'compatible'],
    ['violation', 'safe', 'regressed', 'regressed'],
    ['safe', 'safe', 'still_failing', 'regressed'],
    ['unknown', 'violation', 'inconclusive', 'inconclusive'],
    ['not_run', 'violation', 'inconclusive', 'inconclusive'],
    ['violation', 'unknown', 'inconclusive', 'inconclusive'],
  ] as const)('classifies baseline %s and candidate %s as %s', async (baseJudgment, candidateJudgment, outcome, status) => {
    const f = await fixture({ cases: [positiveCase({ baseJudgment, candidateJudgment })] });
    const saved = await f.store.createRevisionComparison(f.input);
    expect(saved.comparison.cases[0].outcome).toBe(outcome);
    expect(saved.comparison.feedback[0].outcome).toBe(outcome);
    expect(saved.comparison.summary.status).toBe(status);
    if (status !== 'compatible') {
      await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
      expect(await f.store.listRevisionDecisions()).toEqual([]);
      for (const choice of ['reject', 'defer'] as const) expect((await f.store.recordRevisionDecision(revisionDecision(saved.digest, { id: `${choice}-decision`, choice }))).decision.choice).toBe(choice);
      await assertNoActivation(f.store, f.baseInput.ruleId);
    }
  }, 30_000);

  it('does not manufacture an expectation from a role when the immutable case expectation is unknown', async () => {
    const f = await fixture({ cases: [positiveCase({ expected: 'unknown' })] });
    const saved = await f.store.createRevisionComparison(f.input);
    expect(saved.comparison.cases[0]).toMatchObject({ expected: 'unknown', baseRole: 'positive', base: { state: 'violation' }, candidate: { state: 'violation' }, outcome: 'inconclusive' });
    expect(saved.comparison.summary.status).toBe('inconclusive');
    await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  }, 30_000);

  it.each([
    { kind: 'note' as const, label: null }, { kind: 'resolve' as const, label: null },
    { kind: 'merge' as const, label: null }, { kind: 'label' as const, label: 'Unknown' as const },
    { kind: 'label' as const, label: 'Disputed' as const },
  ])('does not score selected feedback $kind/$label as a correctness expectation', async feedback => {
    const f = await fixture({ feedback });
    const saved = await f.store.createRevisionComparison(f.input);
    expect(saved.comparison.feedback[0]).toMatchObject({ expected: 'unknown', outcome: 'inconclusive' });
    expect(saved.comparison.summary.status).toBe('inconclusive');
    await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  }, 30_000);
});

it('retains the full union of declared regressions, including removed and newly added cases and missing bindings', async () => {
  const f = await fixture({ cases: [positiveCase({ candidateRole: null }), safeCase({ baseRole: null })] });
  const saved = await f.store.createRevisionComparison({ ...f.input, caseBindings: f.input.caseBindings.filter(binding => binding.caseId !== 'positive-case') });
  expect(saved.comparison.cases).toHaveLength(2);
  expect(saved.comparison.cases[0]).toMatchObject({ caseId: 'positive-case', baseRole: 'positive', candidateRole: null, baseReviewId: null, snapshotDigest: null, base: { state: 'unscored', reason: 'missing_case_binding' }, candidate: { state: 'unscored', reason: 'missing_case_binding' }, outcome: 'inconclusive' });
  expect(saved.comparison.cases[1]).toMatchObject({ caseId: 'safe-case', baseRole: null, candidateRole: 'fixed', outcome: 'corrected' });
  expect(saved.comparison.summary.status).toBe('inconclusive');
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
}, 30_000);

it('does not substitute another review attempt for the exact selected feedback review', async () => {
  const f = await fixture();
  const otherBase = await f.store.runSemanticReview({ ruleDigest: f.baseRule.digest, snapshotDigest: f.snapshot.digest, fixtures: f.fixtures(f.baseRule, 'base'), attempt: 'other-base-attempt' });
  const saved = await f.store.createRevisionComparison({ ...f.input, reviewPairs: [{ baseReviewId: otherBase.id, candidateReviewId: f.candidateReview.id }], caseBindings: f.input.caseBindings.map(binding => ({ ...binding, baseReviewId: otherBase.id })) });
  expect(saved.comparison.cases.map(row => row.outcome)).toEqual(['preserved', 'corrected']);
  expect(saved.comparison.feedback[0]).toMatchObject({ base: { state: 'unscored', reason: 'missing_pair' }, candidate: { state: 'unscored', reason: 'missing_pair' }, outcome: 'inconclusive' });
  expect(saved.comparison.summary.status).toBe('inconclusive');
}, 30_000);

it('rejects duplicate, swapped, absent and undeclared input bindings without persisting a comparison', async () => {
  const f = await fixture();
  const invalid = [
    { ...f.input, reviewPairs: [...f.input.reviewPairs, ...f.input.reviewPairs] },
    { ...f.input, caseBindings: [...f.input.caseBindings, f.input.caseBindings[0]] },
    { ...f.input, reviewPairs: [{ baseReviewId: f.candidateReview.id, candidateReviewId: f.baseReview.id }] },
    { ...f.input, caseBindings: [{ caseId: 'undeclared', baseReviewId: f.baseReview.id }] },
    { ...f.input, caseBindings: [{ caseId: 'positive-case', baseReviewId: f.candidateReview.id }] },
    { ...f.input, reviewPairs: [{ baseReviewId: `review_${'f'.repeat(64)}`, candidateReviewId: f.candidateReview.id }] },
    { ...f.input, reviewPairs: [] },
    { ...f.input, summary: { status: 'compatible' } },
  ];
  for (const input of invalid) await expect(f.store.createRevisionComparison(input)).rejects.toThrow();
  expect(await f.store.listRevisionComparisons()).toEqual([]);
}, 30_000);

it('requires each pair to use the same immutable snapshot, not merely identical captured bytes', async () => {
  const f = await fixture();
  const different = await f.store.importChangeSnapshot({ ...f.snapshot.snapshot, head: '3'.repeat(40) });
  const review = await f.store.runSemanticReview({ ruleDigest: f.candidateRule.digest, snapshotDigest: different.digest, fixtures: f.fixtures(f.candidateRule, 'candidate', different) });
  await expect(f.store.createRevisionComparison({ ...f.input, reviewPairs: [{ baseReviewId: f.baseReview.id, candidateReviewId: review.id }] })).rejects.toMatchObject({ code: 'COMPARISON_BINDING_MISMATCH' });
  expect(await f.store.listRevisionComparisons()).toEqual([]);
}, 30_000);

it('requires semantic schema 2, the same rule, the exact requested label and the direct pinned parent', async () => {
  const f = await fixture();
  const otherRoot = await f.store.importRuleVersion({ ...f.baseInput, ruleId: 'other-rule', version: 'candidate' });
  const wrongLabel = await f.store.importRuleVersion({ ...f.candidateInput, version: 'wrong-label' });
  const grandchild = await f.store.importRuleVersion({ ...f.candidateInput, version: 'grandchild', provenance: { ...f.candidateInput.provenance, parentDigest: f.candidateRule.digest } });
  const request = await f.store.createRevisionRequest({ id: 'grandchild-request', baseRuleDigest: f.baseRule.digest, requestedRuleVersion: 'grandchild', feedbackIds: [f.feedback.id], requestedChange: 'Must still use direct pinned parent', actor: 'fixture', source: 'fixture', createdAt: comparisonDate });
  for (const candidateRuleDigest of [otherRoot.digest, wrongLabel.digest, f.baseRule.digest]) {
    await expect(f.store.createRevisionComparison({ ...f.input, candidateRuleDigest })).rejects.toMatchObject({ code: 'INVALID_REVISION_CANDIDATE' });
  }
  await expect(f.store.createRevisionComparison({ ...f.input, requestDigest: request.digest, candidateRuleDigest: grandchild.digest })).rejects.toMatchObject({ code: 'INVALID_REVISION_CANDIDATE' });
  const legacy: RuleBundle = { schemaVersion: 1, ruleId: 'legacy-rule', version: 'candidate', skill: { title: 'Legacy', invariant: 'Legacy', applicability: ['Calls'], exceptions: [], requiredContext: [] }, detector: dangerAsset.detector,
    regressionCases: [{ caseId: f.cases[0].id, role: 'positive' }], provenance: { sourceCaseIds: [f.cases[0].id], parentDigest: null, author: 'fixture', createdAt: comparisonDate, rationale: 'Explicit legacy fixture', evidenceRefs: ['fixture'] } };
  const v1 = await f.store.importBundle(legacy);
  await expect(f.store.createRevisionComparison({ ...f.input, candidateRuleDigest: v1.digest })).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
  expect(await f.store.listRevisionComparisons()).toEqual([]);
}, 30_000);

it.each([
  { repository: 'fixture:other-repository' }, { commit: '3'.repeat(40) }, { commit: '2222222' },
  { path: 'src/not-this-file.ts' }, { sourceDigest: 'e'.repeat(64) },
])('requires exact repository/full head/after path/source digest case binding: %j', async caseOverrides => {
  const f = await fixture({ cases: [positiveCase(), safeCase({ caseOverrides })] });
  await expect(f.store.createRevisionComparison(f.input)).rejects.toMatchObject({ code: 'COMPARISON_BINDING_MISMATCH' });
  expect(await f.store.listRevisionComparisons()).toEqual([]);
}, 30_000);

it.each([
  [positiveCase(), safeCase({ candidateRole: 'positive' })],
  [positiveCase({ expected: 'safe' }), safeCase()],
  [positiveCase(), safeCase({ expected: 'violation' })],
])('rejects conflicting regression role meanings and known expected-role mismatches', async (...cases) => {
  const f = await fixture({ cases });
  await expect(f.store.createRevisionComparison(f.input)).rejects.toMatchObject({ code: 'REGRESSION_EXPECTATION_MISMATCH' });
}, 30_000);

describe('coverage gaps cannot become fixes', () => {
  const unsupported = { id: 'unsupported', detector: { kind: 'semgrep' as const, language: 'typescript', yaml: 'rules: []' } };
  const zero = { id: 'zero', detector: { kind: 'ast-grep' as const, language: 'typescript', pattern: 'neverCalled($ARG)' } };
  it.each([
    { name: 'unsupported engine', candidateAssets: [unsupported], reason: 'incomplete_scans' },
    { name: 'partially covered assets', candidateAssets: [dangerAsset, unsupported], reason: 'incomplete_scans' },
    { name: 'language mismatch', candidateAssets: [{ id: 'python', detector: { kind: 'ast-grep' as const, language: 'python', pattern: 'danger($ARG)' } }], reason: 'incomplete_scans' },
    { name: 'unsupported language', candidateAssets: [{ id: 'unknown-language', detector: { kind: 'ast-grep' as const, language: 'unknown-language', pattern: 'danger($ARG)' } }], reason: 'incomplete_scans' },
  ])('keeps $name inconclusive even with an explicit safe fixture', async ({ candidateAssets, reason }) => {
    const f = await fixture({ candidateAssets });
    const saved = await f.store.createRevisionComparison(f.input);
    expect(saved.comparison.cases.every(row => row.candidate.state === 'unscored' && row.candidate.reason === reason && row.outcome === 'inconclusive')).toBe(true);
    expect(saved.comparison.feedback[0]).toMatchObject({ candidate: { state: 'unscored', reason }, outcome: 'inconclusive' });
    expect(saved.comparison.summary.status).toBe('inconclusive');
    await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  }, 30_000);

  it('allows a detectorless baseline with explicit judgments and exact feedback anchors', async () => {
    const f = await fixture({ baseAssets: [] });
    const saved = await f.store.createRevisionComparison(f.input);
    expect(saved.comparison.cases.every(row => row.base.reason === 'explicit_semantic_judgment')).toBe(true);
    expect(saved.comparison.summary.status).toBe('compatible');
  }, 30_000);

  it('allows zero-hit hint assets alongside fully scanned assets and explicit judgments', async () => {
    const f = await fixture({ candidateAssets: [dangerAsset, zero] });
    expect(f.candidateReview.coverage.targets[0].scans.map(scan => scan.candidateCount)).toEqual([2, 0]);
    expect((await f.store.createRevisionComparison(f.input)).comparison.summary.status).toBe('compatible');
  }, 30_000);

  it('keeps an out-of-scope target inconclusive rather than calling the removed detection a fix', async () => {
    const f = await fixture({ candidateScope: { repositories: ['fixture:revision-comparison'], paths: { include: ['elsewhere'], exclude: [] } } });
    const saved = await f.store.createRevisionComparison(f.input);
    expect(saved.comparison.cases.every(row => row.candidate.reason === 'target_not_captured' && row.outcome === 'inconclusive')).toBe(true);
    expect(saved.comparison.feedback[0].candidate.reason).toBe('target_not_captured');
  }, 30_000);
});

it('never treats a different violation anchor as fixing the exact selected FP anchor', async () => {
  const f = await fixture({ cases: [positiveCase(), safeCase({ candidateJudgment: 'violation', candidateAnchorIndex: 1 })] });
  const saved = await f.store.createRevisionComparison(f.input);
  expect(saved.comparison.feedback[0]).toMatchObject({ anchor: f.finding.anchor, expected: 'safe', candidate: { state: 'unscored', reason: 'anchor_unscored' }, outcome: 'inconclusive' });
  expect(saved.comparison.cases.find(row => row.caseId === 'safe-case')?.outcome).toBe('still_failing');
  expect(saved.comparison.summary.status).toBe('regressed');
}, 30_000);

it('uses an explicitly safe exact anchor even when it is not a detector match', async () => {
  const f = await fixture({ cases: [safeCase()], candidateAssets: [{ id: 'second-only', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'danger(two)' } }] });
  expect(f.candidateReview.findings.find(value => digestOf(value.anchor) === digestOf(f.finding.anchor))).toMatchObject({ status: 'safe', occurrenceIds: [] });
  const saved = await f.store.createRevisionComparison(f.input);
  expect(saved.comparison.feedback[0]).toMatchObject({ candidate: { state: 'safe', reason: 'explicit_semantic_judgment' }, outcome: 'corrected' });
  expect(saved.comparison.summary.status).toBe('compatible');
}, 30_000);

it('does not score a baseline structural match that was never adjudicated at its exact anchor', async () => {
  const f = await fixture({ cases: [safeCase({ baseAnchorIndex: 1 })] });
  expect(f.finding.status).toBe('not_verified');
  const saved = await f.store.createRevisionComparison(f.input);
  expect(saved.comparison.feedback[0]).toMatchObject({ base: { state: 'unscored', reason: 'anchor_unscored' }, candidate: { state: 'safe' }, outcome: 'inconclusive' });
  expect(saved.comparison.summary.status).toBe('inconclusive');
}, 30_000);

it('keeps comparison and decision IDs immutable under idempotent and competing concurrent writes', async () => {
  const f = await fixture();
  const [first, same] = await Promise.all([f.store.createRevisionComparison(f.input), f.store.createRevisionComparison(f.input)]);
  expect(same).toEqual(first);
  await expect(f.store.createRevisionComparison({ ...f.input, caseBindings: [] })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  const competing = await Promise.allSettled([
    f.store.createRevisionComparison({ ...f.input, id: 'competing-comparison' }),
    f.store.createRevisionComparison({ ...f.input, id: 'competing-comparison', caseBindings: [] }),
  ]);
  expect(competing.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(competing.filter(value => value.status === 'rejected')).toHaveLength(1);
  expect(await f.store.listRevisionComparisons()).toHaveLength(2);
  const decisions = await Promise.allSettled([
    f.store.recordRevisionDecision(revisionDecision(first.digest, { reason: 'First authored reason' })),
    f.store.recordRevisionDecision(revisionDecision(first.digest, { reason: 'Competing authored reason' })),
  ]);
  expect(decisions.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(decisions.filter(value => value.status === 'rejected')).toHaveLength(1);
  const decision = (await f.store.listRevisionDecisions(first.digest))[0];
  const { id, comparisonDigest, choice, actor, source, reason, createdAt } = decision.decision;
  expect(await f.store.recordRevisionDecision({ id, comparisonDigest, choice, actor, source, reason, createdAt })).toEqual(decision);
  await expect(f.store.recordRevisionDecision(revisionDecision(first.digest, { choice: 'reject' }))).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  expect(await f.store.getRevisionComparison(first.digest)).toEqual(first);
}, 30_000);

it('enforces append-only SQL and foreign keys for comparison and decision records', async () => {
  const f = await fixture();
  const comparison = await f.store.createRevisionComparison(f.input);
  await f.store.recordRevisionDecision(revisionDecision(comparison.digest));
  for (const table of ['qe_rule_revision_comparisons', 'qe_rule_revision_decisions']) {
    await expect(f.database.query(`UPDATE ${table} SET payload=payload`)).rejects.toThrow('append-only');
    await expect(f.database.query(`DELETE FROM ${table}`)).rejects.toThrow('append-only');
  }
  await expect(f.database.query('INSERT INTO qe_rule_revision_comparisons(digest,id,request_digest,candidate_rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)', ['f'.repeat(64), 'bad-request', 'f'.repeat(64), f.candidateRule.digest, '{}'])).rejects.toThrow();
  await expect(f.database.query('INSERT INTO qe_rule_revision_comparisons(digest,id,request_digest,candidate_rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)', ['f'.repeat(64), 'bad-candidate', f.request.digest, 'f'.repeat(64), '{}'])).rejects.toThrow();
  await expect(f.database.query('INSERT INTO qe_rule_revision_decisions(digest,id,comparison_digest,payload) VALUES($1,$2,$3,$4::jsonb)', ['f'.repeat(64), 'bad-decision', 'f'.repeat(64), '{}'])).rejects.toThrow();
  await expect(f.store.getRevisionComparison('f'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(f.store.getRevisionDecision('f'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  for (const operation of [() => f.store.getRevisionComparison('bad-digest'), () => f.store.listRevisionComparisons('bad-digest'), () => f.store.getRevisionDecision('bad-digest'), () => f.store.listRevisionDecisions('bad-digest')]) await expect(operation()).rejects.toThrow();
}, 30_000);

it('rolls back a comparison or decision inserted before a simulated late write failure, and permits a clean retry', async () => {
  const actual = await openPGliteDatabase();
  let failTable: 'qe_rule_revision_comparisons' | 'qe_rule_revision_decisions' | null = null;
  const wrapped: Database = { ...actual, transaction: callback => actual.transaction(tx => callback({
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await tx.query<T>(sql, params);
      if (failTable && sql.startsWith(`INSERT INTO ${failTable}(`)) throw new Error('Injected post-insert failure');
      return result;
    },
  })) };
  const f = await fixture({ database: wrapped });
  failTable = 'qe_rule_revision_comparisons';
  await expect(f.store.createRevisionComparison(f.input)).rejects.toThrow('Injected post-insert failure');
  expect((await actual.query('SELECT digest FROM qe_rule_revision_comparisons')).rows).toEqual([]);
  expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
  failTable = null;
  const comparison = await f.store.createRevisionComparison(f.input);
  failTable = 'qe_rule_revision_decisions';
  await expect(f.store.recordRevisionDecision(revisionDecision(comparison.digest))).rejects.toThrow('Injected post-insert failure');
  expect((await actual.query('SELECT digest FROM qe_rule_revision_decisions')).rows).toEqual([]);
  expect(await f.store.getRevisionComparison(comparison.digest)).toEqual(comparison);
  failTable = null;
  expect((await f.store.recordRevisionDecision(revisionDecision(comparison.digest))).decision.choice).toBe('accept');
}, 30_000);

it('reopens a disk database with exact comparisons, decisions and all frozen dependencies intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revision-comparison-db-'));
  let store: QualEvoStore | undefined;
  try {
    const database = await openPGliteDatabase(directory);
    const f = await revisionComparisonFixture({ database }); store = f.store;
    const comparison = await store.createRevisionComparison(f.input), decision = await store.recordRevisionDecision(revisionDecision(comparison.digest));
    await store.close(); store = undefined;
    store = await QualEvoStore.openPGlite(directory);
    expect(await store.getRevisionComparison(comparison.digest)).toEqual(comparison);
    expect(await store.getRevisionDecision(decision.digest)).toEqual(decision);
    expect(await store.listRevisionComparisons()).toEqual([comparison]);
    expect(await store.listRevisionDecisions()).toEqual([decision]);
    expect(await store.createRevisionComparison(f.input)).toEqual(comparison);
    expect(await store.recordRevisionDecision(revisionDecision(comparison.digest))).toEqual(decision);
    expect(await store.getRevisionRequest(f.request.digest)).toEqual(f.request);
    await assertNoActivation(store, f.baseInput.ruleId);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('rejects tampered outer hashes and indexed identities on get/list/decision paths', async () => {
  const f = await fixture();
  const comparison = await f.store.createRevisionComparison(f.input);
  const decision = await f.store.recordRevisionDecision(revisionDecision(comparison.digest));
  await f.database.exec('ALTER TABLE qe_rule_revision_comparisons DISABLE TRIGGER qe_rule_revision_comparisons_immutable');
  const changed = { ...comparison.comparison, summary: { ...comparison.comparison.summary, corrected: 100 } };
  await f.database.query('UPDATE qe_rule_revision_comparisons SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify(changed), comparison.digest]);
  for (const operation of [() => f.store.getRevisionComparison(comparison.digest), () => f.store.listRevisionComparisons(), () => f.store.getRevisionDecision(decision.digest), () => f.store.listRevisionDecisions(), () => f.store.recordRevisionDecision(revisionDecision(comparison.digest, { id: 'must-not-write' }))]) await expect(operation()).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.database.query('UPDATE qe_rule_revision_comparisons SET payload=$1::jsonb,id=$2 WHERE digest=$3', [JSON.stringify(comparison.comparison), 'wrong-index-id', comparison.digest]);
  await expect(f.store.getRevisionComparison(comparison.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.database.query('UPDATE qe_rule_revision_comparisons SET id=$1 WHERE digest=$2', [f.input.id, comparison.digest]);
  await f.database.exec('ALTER TABLE qe_rule_revision_decisions DISABLE TRIGGER qe_rule_revision_decisions_immutable');
  await f.database.query('UPDATE qe_rule_revision_decisions SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify({ ...decision.decision, reason: 'Forged reason' }), decision.digest]);
  await expect(f.store.getRevisionDecision(decision.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.listRevisionDecisions()).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
}, 30_000);

it('rederives the entire report and rejects forged conclusions and frozen bindings even with a recomputed outer digest', async () => {
  const f = await fixture();
  const saved = await f.store.createRevisionComparison(f.input);
  await f.database.exec('ALTER TABLE qe_rule_revision_comparisons DISABLE TRIGGER qe_rule_revision_comparisons_immutable');
  const mutations: ((report: RevisionComparison) => void)[] = [
    report => { report.summary.corrected += 1; },
    report => { report.summary.status = 'regressed'; },
    report => { report.cases[0].outcome = 'corrected'; },
    report => { report.cases[0].base.state = 'safe'; },
    report => { report.cases.pop(); },
    report => { report.feedback[0].expected = 'violation'; },
    report => { report.reviewBindings[0].candidateReviewDigest = 'f'.repeat(64); },
    report => { report.problemCaseBindings[0].digest = 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const report = structuredClone(saved.comparison); mutate(report);
    const forgedDigest = digestOf(report);
    await f.database.query('UPDATE qe_rule_revision_comparisons SET payload=$1::jsonb,digest=$2 WHERE id=$3', [JSON.stringify(report), forgedDigest, f.input.id]);
    await expect(f.store.getRevisionComparison(forgedDigest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await expect(f.store.listRevisionComparisons()).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await expect(f.store.recordRevisionDecision(revisionDecision(forgedDigest))).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  }
  expect((await f.database.query('SELECT digest FROM qe_rule_revision_decisions')).rows).toEqual([]);
}, 30_000);

it('rejects recomputed decision hashes whose derived request, candidate or status differs from the comparison', async () => {
  const f = await fixture();
  const comparison = await f.store.createRevisionComparison(f.input), saved = await f.store.recordRevisionDecision(revisionDecision(comparison.digest));
  await f.database.exec('ALTER TABLE qe_rule_revision_decisions DISABLE TRIGGER qe_rule_revision_decisions_immutable');
  for (const overrides of [{ requestDigest: 'f'.repeat(64) }, { candidateRuleDigest: f.baseRule.digest }, { comparisonStatus: 'regressed' as const }]) {
    const decision = { ...saved.decision, ...overrides }, forgedDigest = digestOf(decision);
    await f.database.query('UPDATE qe_rule_revision_decisions SET payload=$1::jsonb,digest=$2 WHERE id=$3', [JSON.stringify(decision), forgedDigest, saved.decision.id]);
    await expect(f.store.getRevisionDecision(forgedDigest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await expect(f.store.listRevisionDecisions()).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  }
}, 30_000);

it('detects changed frozen ProblemCase content even when its own storage digest is recomputed', async () => {
  const f = await fixture();
  const saved = await f.store.createRevisionComparison(f.input);
  const original = f.cases.find(value => value.id === 'safe-case')!, forged = { ...original, title: 'Changed after comparison' };
  await f.database.exec('ALTER TABLE qe_problem_cases DISABLE TRIGGER qe_problem_cases_immutable');
  await f.database.query('UPDATE qe_problem_cases SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(forged), digestOf(forged), forged.id]);
  expect(await f.store.getProblemCase(forged.id)).toEqual(forged);
  await expect(f.store.getRevisionComparison(saved.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.listRevisionComparisons()).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
}, 30_000);

it('revalidates frozen feedback, review indices and snapshots before reading or accepting a comparison', async () => {
  const f = await fixture();
  const saved = await f.store.createRevisionComparison(f.input);
  await f.database.exec('ALTER TABLE qe_semantic_review_feedback DISABLE TRIGGER qe_semantic_review_feedback_immutable');
  const forged = { ...f.feedback, label: 'TP' as const };
  await f.database.query('UPDATE qe_semantic_review_feedback SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(forged), digestOf(forged), f.feedback.id]);
  await expect(f.store.getRevisionComparison(saved.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.database.query('UPDATE qe_semantic_review_feedback SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(f.feedback), digestOf(f.feedback), f.feedback.id]);
  await f.database.exec('ALTER TABLE qe_semantic_review_findings DISABLE TRIGGER qe_semantic_review_findings_immutable');
  const changedFinding = { ...f.finding, reasoning: 'Changed index member' };
  await f.database.query('UPDATE qe_semantic_review_findings SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(changedFinding), digestOf(changedFinding), f.finding.id]);
  await expect(f.store.getRevisionComparison(saved.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.database.query('UPDATE qe_semantic_review_findings SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(f.finding), digestOf(f.finding), f.finding.id]);
  await f.database.exec('ALTER TABLE qe_change_snapshots DISABLE TRIGGER qe_change_snapshots_immutable');
  await f.database.query('UPDATE qe_change_snapshots SET repository_id=$1 WHERE digest=$2', ['wrong-repository', f.snapshot.digest]);
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  expect(await f.store.listRevisionDecisions()).toEqual([]);
}, 30_000);

it('rejects registered holdout bytes anywhere in a selected snapshot, even outside declared regressions', async () => {
  const f = await fixture({ cases: [positiveCase(), safeCase(), { id: 'zz-holdout', expected: 'unknown', baseRole: null, candidateRole: null, caseOverrides: { split: 'holdout' } }] });
  expect(f.baseInput.regressionCases.some(value => value.caseId === 'zz-holdout')).toBe(false);
  expect(f.candidateInput.regressionCases.some(value => value.caseId === 'zz-holdout')).toBe(false);
  await expect(f.store.createRevisionComparison(f.input)).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  expect(await f.store.listRevisionComparisons()).toEqual([]);
}, 30_000);

it('cannot smuggle holdout sources or regressions into a candidate and keeps split checks unchanged', async () => {
  const f = await fixture();
  const heldout: ProblemCase = { ...f.cases[0], id: 'heldout', lineageId: 'heldout-lineage', split: 'holdout', sourceDigest: 'a'.repeat(64) };
  const regressionCandidate: SemanticRuleVersion = { ...f.candidateInput, version: 'holdout-regression', regressionCases: [{ caseId: heldout.id, role: 'positive' }] };
  await expect(f.store.importRuleVersion(regressionCandidate, [heldout])).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  await expect(f.store.getProblemCase(heldout.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const sourceCandidate: SemanticRuleVersion = { ...f.candidateInput, version: 'holdout-source', provenance: { ...f.candidateInput.provenance, sourceCases: [{ caseId: heldout.id, repository: heldout.repository, commit: heldout.commit, path: heldout.path, sourceDigest: heldout.sourceDigest }] } };
  await expect(f.store.importRuleVersion(sourceCandidate, [heldout])).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  await expect(f.store.importProblemCase({ ...f.cases[0], id: 'cross-split-source', lineageId: 'new-lineage', split: 'holdout' })).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
  await expect(f.store.importProblemCase({ ...f.cases[0], id: 'cross-split-lineage', sourceDigest: 'a'.repeat(64), split: 'validation' })).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
  expect((await f.store.listRuleVersions()).map(value => value.digest).sort()).toEqual([f.baseRule.digest, f.candidateRule.digest].sort());
}, 30_000);

it('bounds selections and rejects caller-supplied conclusions before deriving anything', () => {
  const pair = { baseReviewId: `review_${'a'.repeat(64)}`, candidateReviewId: `review_${'b'.repeat(64)}` };
  const input = { id: 'input-only', requestDigest: 'a'.repeat(64), candidateRuleDigest: 'b'.repeat(64), reviewPairs: [pair], caseBindings: [] };
  expect(() => RevisionComparisonInputSchema.parse({ ...input, summary: { status: 'compatible' } })).toThrow();
  expect(() => RevisionComparisonInputSchema.parse({ ...input, reviewPairs: Array.from({ length: 17 }, (_, i) => ({ baseReviewId: `review_${i.toString(16).padStart(64, '0')}`, candidateReviewId: `review_${(i + 17).toString(16).padStart(64, '0')}` })) })).toThrow();
  expect(() => RevisionComparisonInputSchema.parse({ ...input, caseBindings: Array.from({ length: 201 }, (_, i) => ({ caseId: `case-${i}`, baseReviewId: pair.baseReviewId })) })).toThrow();
});

it('fails closed before returning truncated comparison or decision lists above 100 records', async () => {
  const f = await fixture();
  const saved = await f.store.createRevisionComparison(f.input);
  // Only list cardinality is under test; foreign-key-valid payloads must not be decoded after the limit guard.
  for (let i = 0; i < 100; i++) await f.database.query('INSERT INTO qe_rule_revision_comparisons(digest,id,request_digest,candidate_rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)', [(i + 1).toString(16).padStart(64, '0'), `over-limit-${i}`, f.request.digest, f.candidateRule.digest, '{}']);
  await expect(f.store.listRevisionComparisons()).rejects.toMatchObject({ code: 'LIST_LIMIT' });
  await expect(f.store.listRevisionComparisons(f.request.digest)).rejects.toMatchObject({ code: 'LIST_LIMIT' });
  expect(await f.store.listRevisionComparisons('f'.repeat(64))).toEqual([]);
  for (let i = 0; i < 101; i++) await f.database.query('INSERT INTO qe_rule_revision_decisions(digest,id,comparison_digest,payload) VALUES($1,$2,$3,$4::jsonb)', [(i + 1).toString(16).padStart(64, '0'), `over-limit-${i}`, saved.digest, '{}']);
  await expect(f.store.listRevisionDecisions()).rejects.toMatchObject({ code: 'LIST_LIMIT' });
  await expect(f.store.listRevisionDecisions(saved.digest)).rejects.toMatchObject({ code: 'LIST_LIMIT' });
  expect(await f.store.listRevisionDecisions('f'.repeat(64))).toEqual([]);
  expect(await f.store.getRevisionComparison(saved.digest)).toEqual(saved);
}, 30_000);

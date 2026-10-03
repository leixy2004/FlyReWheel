import { afterEach, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { ComparisonApplicabilityFixtureSchema, type ComparisonApplicabilityFixture } from '../src/core/comparison-applicability-model.js';
import { RevisionComparisonInputSchema } from '../src/core/revision-comparison.js';
import { buildComparisonApplicabilityInput, validateComparisonApplicabilityResponse } from '../src/comparison-applicability.js';
import { makeReviewEvidence } from '../src/adapters/semantic-review-fixture.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { acceptedGovernanceEvidence, semanticGovernanceBinding } from '../src/semantic-governance.js';
import { revisionComparisonFixture, revisionDecision, defaultComparisonCases, type ComparisonFixtureOptions } from './helpers/revision-comparison-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const scope = (exclude = ['src/safe-case.ts']) => ({ repositories: ['fixture:revision-comparison'], paths: { include: ['src'], exclude } });
async function fixture(options: ComparisonFixtureOptions = {}) {
  const f = await revisionComparisonFixture({ cases: [defaultComparisonCases[0], { ...defaultComparisonCases[1], baseRole: null, candidateRole: null }], candidateScope: scope(), ...options });
  cleanup.push(() => f.database.close()); return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const context = (f: Fixture) => ({ request: f.request, baseRule: f.baseRule, candidateRule: f.candidateRule,
  pair: { base: f.baseReview, candidate: f.candidateReview, snapshot: f.snapshot }, feedback: { feedback: f.feedback, finding: f.finding, review: f.baseReview } });
function claim(f: Fixture): ComparisonApplicabilityFixture {
  const binding = buildComparisonApplicabilityInput(context(f)).binding;
  const evidence = makeReviewEvidence(f.snapshot, f.finding.anchor, 'fixture-context');
  return { kind: 'comparison-applicability-offline-fixture', binding, response: { bindingDigest: digestOf(binding), decision: 'NOT_APPLICABLE',
    reasoning: 'Authored fixture claims that this exact file belongs to an unrelated policy domain; this is unverified evidence, not proof from exclusion.',
    evidence: [evidence], evidenceRefs: [evidence.id], missingContext: [] } };
}
const policy = (adjudications: ComparisonApplicabilityFixture[] = []) => ({ policyVersion: 'selected-finding-applicability-v1' as const, adjudications });

it('corrects an exact excluded FP through explicit applicability, retaining positive regression, coverage and unverified trust', async () => {
  const f = await fixture(), adjudication = claim(f);
  const old = await f.store.createRevisionComparison(f.input);
  expect(old.comparison).toMatchObject({ scorer: 'per-anchor-semantic-v3', summary: { status: 'inconclusive' } });
  expect(old.comparison.feedback[0].candidate).toEqual({ state: 'unscored', reason: 'target_not_captured' });
  const saved = await f.store.createRevisionComparison({ ...f.input, id: 'scope-aware', applicability: policy([adjudication]) });
  expect(saved.comparison).toMatchObject({ scorer: 'scope-applicability-v5', summary: { status: 'compatible', preserved: 1, corrected: 1 },
    coverage: { base: { captured: 2, out_of_scope: 0 }, candidate: { captured: 1, out_of_scope: 1 }, lostPositiveObligations: 0 },
    trust: { semanticEvidence: 'offline-fixture-declarations', identity: 'caller-declared-unverified', certification: 'none' } });
  expect(saved.comparison.feedback[0]).toMatchObject({ candidate: { state: 'not_applicable', reason: 'explicit_not_applicable' }, outcome: 'corrected' });
  expect(await f.store.getRevisionComparison(saved.digest)).toEqual(saved);
  expect(await f.store.getRevisionComparison(old.digest)).toEqual(old);
  expect((await f.store.getSemanticReview(f.candidateReview.id)).coverage.targets.find(value => value.path === f.finding.anchor.path)?.semantic.state).toBe('not_run');
  const decision = await f.store.recordRevisionDecision(revisionDecision(saved.digest));
  expect(acceptedGovernanceEvidence(decision, saved, semanticGovernanceBinding(f.candidateRule))).toMatchObject({ scorer: 'scope-applicability-v5', comparisonStatus: 'compatible' });
}, 30_000);

it('does not silently bypass normal review scope for applicability claims', async () => {
  const f = await fixture();
  const baseFixtures = f.fixtures(f.baseRule, 'base');
  const forged = { ...baseFixtures, ruleDigest: f.candidateRule.digest,
    judgments: baseFixtures.judgments.map(value => ({ ...value,
      targetId: f.candidateReview.coverage.targets.find(target => target.path === f.finding.anchor.path)!.id })) };
  expect(() => buildSemanticReview({ rule: f.candidateRule, snapshot: f.snapshot, fixtures: forged })).toThrow();
}, 30_000);

it('silence and an empty v5 adjudication selection remain unscored, never corrected', async () => {
  const f = await fixture();
  const saved = await f.store.createRevisionComparison({ ...f.input, applicability: policy() });
  expect(saved.comparison.feedback[0]).toMatchObject({ candidate: { state: 'unscored', reason: 'target_not_captured' }, outcome: 'inconclusive' });
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
}, 30_000);

it.each(['UNKNOWN', 'APPLICABLE'] as const)('%s is not a NOT_APPLICABLE correction', async decision => {
  const f = await fixture(), value = claim(f); value.response.decision = decision;
  const saved = await f.store.createRevisionComparison({ ...f.input, applicability: policy([value]) });
  expect(saved.comparison.summary.status).toBe('inconclusive');
  expect(saved.comparison.feedback[0].candidate.state).toBe(decision === 'UNKNOWN' ? 'unknown' : 'unscored');
}, 30_000);

it.each(['declared-missing', 'uncited-kind'] as const)('gates NOT_APPLICABLE on its own %s context', async mode => {
  const f = await fixture(), value = claim(f);
  if (mode === 'declared-missing') value.response.missingContext = ['Unresolved domain ownership'];
  else {
    const evidence = makeReviewEvidence(f.snapshot, f.finding.anchor, 'wrong-kind');
    value.response.evidence.push(evidence); value.response.evidenceRefs = [evidence.id];
  }
  const saved = await f.store.createRevisionComparison({ ...f.input, applicability: policy([value]) });
  expect(saved.comparison.feedback[0]).toMatchObject({ candidate: { state: 'unknown', reason: 'applicability_unknown' }, outcome: 'inconclusive' });
}, 30_000);

it('never promotes one excluded finding into a whole-file negative/fixed regression pass', async () => {
  const f = await fixture({ cases: defaultComparisonCases });
  const saved = await f.store.createRevisionComparison({ ...f.input, applicability: policy([claim(f)]) });
  expect(saved.comparison.feedback[0].outcome).toBe('corrected');
  expect(saved.comparison.cases.find(value => value.caseId === 'safe-case')).toMatchObject({ candidate: { state: 'unscored' }, outcome: 'inconclusive' });
  expect(saved.comparison.summary.status).toBe('inconclusive');
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
}, 30_000);

it.each([false, true])('exclusion cannot hide an established positive even when candidate drops its declaration (%s)', async dropped => {
  const f = await fixture({ cases: [{ ...defaultComparisonCases[0], candidateRole: dropped ? null : 'positive' }, { ...defaultComparisonCases[1], baseRole: null, candidateRole: null }],
    candidateScope: scope(['src/positive-case.ts', 'src/safe-case.ts']) });
  const saved = await f.store.createRevisionComparison({ ...f.input, applicability: policy([claim(f)]) });
  expect(saved.comparison.feedback[0].outcome).toBe('corrected');
  expect(saved.comparison.cases[0]).toMatchObject({ caseId: 'positive-case', outcome: 'regressed', candidate: { state: 'unscored' } });
  expect(saved.comparison.coverage?.lostPositiveObligations).toBe(1);
  expect(saved.comparison.summary.status).toBe('regressed');
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
}, 30_000);

it('a NOT_APPLICABLE claim on selected TP feedback remains a rejected loss of positive coverage', async () => {
  const f = await fixture({ cases: [defaultComparisonCases[0]], candidateScope: scope(['src/positive-case.ts']) });
  const saved = await f.store.createRevisionComparison({ ...f.input, applicability: policy([claim(f)]) });
  expect(saved.comparison.feedback[0]).toMatchObject({ expected: 'violation', candidate: { state: 'not_applicable' }, outcome: 'regressed' });
  expect(saved.comparison.coverage?.lostPositiveObligations).toBe(2);
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
}, 30_000);

it('omitting a positive case binding never grants acceptance', async () => {
  const f = await fixture();
  const saved = await f.store.createRevisionComparison({ ...f.input, caseBindings: [], applicability: policy([claim(f)]) });
  expect(saved.comparison.cases[0].outcome).toBe('inconclusive');
  await expect(f.store.recordRevisionDecision(revisionDecision(saved.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
}, 30_000);

it('binds every exact identity and validates even unused evidence bytes', async () => {
  const f = await fixture(), original = claim(f);
  for (const field of ['requestDigest', 'baseRuleDigest', 'candidateRuleDigest', 'baseReviewDigest', 'candidateReviewDigest', 'snapshotDigest', 'feedbackDigest', 'findingDigest'] as const) {
    const value = structuredClone(original); value.binding[field] = 'f'.repeat(64); value.response.bindingDigest = digestOf(value.binding);
    await expect(f.store.createRevisionComparison({ ...f.input, id: field, applicability: policy([value]) })).rejects.toThrow(/binding|inputs/i);
  }
  const badHead = structuredClone(original); badHead.binding.head = 'f'.repeat(40); badHead.response.bindingDigest = digestOf(badHead.binding);
  await expect(f.store.createRevisionComparison({ ...f.input, id: 'wrong-head', applicability: policy([badHead]) })).rejects.toThrow(/inputs/i);
  const badVersion = structuredClone(original); badVersion.binding.candidateVersion = 'unselected'; badVersion.response.bindingDigest = digestOf(badVersion.binding);
  await expect(f.store.createRevisionComparison({ ...f.input, id: 'wrong-version', applicability: policy([badVersion]) })).rejects.toThrow(/inputs/i);
  const badEvidence = structuredClone(original), item = { ...badEvidence.response.evidence[0], kind: 'unused', content: 'forged bytes' };
  item.id = digestOf({ kind: item.kind, content: item.content, anchor: item.anchor }); badEvidence.response.evidence.push(item);
  expect(() => validateComparisonApplicabilityResponse(context(f), badEvidence.response)).toThrow(/excerpt/);
}, 30_000);

it('requires own target evidence, refuses dangling references and rejects duplicate claims', async () => {
  const f = await fixture(), original = claim(f);
  const empty = structuredClone(original); empty.response.evidenceRefs = [];
  expect(() => validateComparisonApplicabilityResponse(context(f), empty.response)).toThrow(/own after-side/);
  const wrongTarget = structuredClone(original), other = f.baseReview.findings.find(value => value.anchor.path !== f.finding.anchor.path)!;
  const evidence = makeReviewEvidence(f.snapshot, other.anchor, 'fixture-context');
  wrongTarget.response.evidence = [evidence]; wrongTarget.response.evidenceRefs = [evidence.id];
  expect(() => validateComparisonApplicabilityResponse(context(f), wrongTarget.response)).toThrow(/own after-side/);
  const dangling = structuredClone(original); dangling.response.evidenceRefs = ['f'.repeat(64)];
  expect(() => validateComparisonApplicabilityResponse(context(f), dangling.response)).toThrow(/unavailable/);
  expect(() => RevisionComparisonInputSchema.parse({ ...f.input, applicability: policy([original, original]) })).toThrow(/Duplicate/);
  expect(() => ComparisonApplicabilityFixtureSchema.parse({ ...original, humanVerified: true })).toThrow();
}, 30_000);

it('does not admit an in-scope target through the comparison-only channel', async () => {
  const f = await fixture({ candidateScope: scope([]) });
  expect(() => buildComparisonApplicabilityInput(context(f))).toThrow(/excluded by a literal/);
}, 30_000);

it('binds selected candidate-context packages and independently gates uncited, before-only and unselected context', async () => {
  const { contextComparisonFixture, downstreamContext, downstreamContextEvidence } = await import('./helpers/context-downstream-fixture.js');
  const { ruleVersionDigest } = await import('../src/core/identity.js');
  const { deriveRevisionComparison } = await import('../src/revision-comparison.js');
  const c = contextComparisonFixture(), rule = structuredClone(c.candidateRule.rule);
  const finding = c.graph.feedback[0].finding; rule.scope.paths.exclude.push(finding.anchor.path);
  const candidateRule = { digest: ruleVersionDigest(rule), rule };
  const candidateReview = buildSemanticReview({ rule: candidateRule, snapshot: c.snapshot, repositoryContexts: [c.context] });
  const pair = { base: c.baseReview, candidate: candidateReview, snapshot: c.snapshot };
  const selected = { request: c.graph.request, baseRule: c.baseRule, candidateRule, pair, feedback: c.graph.feedback[0] };
  const binding = buildComparisonApplicabilityInput(selected).binding;
  const own = makeReviewEvidence(c.snapshot, finding.anchor, 'changed-source');
  const value: ComparisonApplicabilityFixture = { kind: 'comparison-applicability-offline-fixture', binding,
    response: { bindingDigest: digestOf(binding), decision: 'NOT_APPLICABLE', reasoning: 'Authored selected-context applicability declaration only', evidence: [own, c.evidence], evidenceRefs: [own.id, c.evidence.id], missingContext: [] } };
  const input = { ...c.input, candidateRuleDigest: candidateRule.digest, reviewPairs: [{ baseReviewId: c.baseReview.id, candidateReviewId: candidateReview.id }], applicability: policy([value]) };
  const graph = { ...c.graph, candidateRule, pairs: [pair] };
  expect(deriveRevisionComparison(input, graph)).toMatchObject({ scorer: 'scope-applicability-v5', summary: { status: 'compatible' } });
  expect(binding.repositoryContextDigests).toEqual([c.context.digest]);
  const uncited = structuredClone(value); uncited.response.evidenceRefs = [own.id];
  expect(deriveRevisionComparison({ ...input, applicability: policy([uncited]) }, graph).feedback[0].candidate.state).toBe('unknown');
  const contextOnly = structuredClone(value); contextOnly.response.evidenceRefs = [c.evidence.id];
  expect(() => validateComparisonApplicabilityResponse(selected, contextOnly.response)).toThrow(/own after-side/);
  const { makeSnapshotAnchor } = await import('../src/adapters/semantic-review-fixture.js');
  const before = makeReviewEvidence(c.snapshot, makeSnapshotAnchor(c.snapshot, 'before', finding.anchor.path, 0, 5), 'changed-source');
  const beforeOnly = structuredClone(value); beforeOnly.response.evidence = [before, c.evidence]; beforeOnly.response.evidenceRefs = [before.id, c.evidence.id];
  expect(() => validateComparisonApplicabilityResponse(selected, beforeOnly.response)).toThrow(/own after-side/);
  const other = downstreamContext(c.snapshot, 'unselected.md', 'A different authored policy\n'), foreign = downstreamContextEvidence(other, 'local-policy');
  const unselected = structuredClone(value); unselected.response.evidence.push(foreign);
  expect(() => validateComparisonApplicabilityResponse(selected, unselected.response)).toThrow(/unselected/);
  const mismatched = buildSemanticReview({ rule: candidateRule, snapshot: c.snapshot, repositoryContexts: [other] });
  expect(() => buildComparisonApplicabilityInput({ ...selected, pair: { ...pair, candidate: mismatched } })).toThrow(/identical pinned/);
});

it('an excluded FP cannot hide a separately established TP at another anchor in the same file', async () => {
  const f = await fixture(), fixtures = f.fixtures(f.baseRule, 'base');
  const target = f.baseReview.coverage.targets.find(value => value.path === f.finding.anchor.path)!;
  const anchors = f.baseReview.occurrences.filter(value => value.targetId === target.id).map(value => value.anchor);
  fixtures.judgments.find(value => value.targetId === target.id)!.findingAnchors = anchors;
  const baseReview = await f.store.runSemanticReview({ ruleDigest: f.baseRule.digest, snapshotDigest: f.snapshot.digest, fixtures });
  const findings = baseReview.findings.filter(value => value.anchor.path === f.finding.anchor.path).sort((a, b) => a.anchor.span.start.offset - b.anchor.span.start.offset);
  const fp = await f.store.appendReviewFeedback({ ...f.feedback, id: 'mixed-fp', reviewId: baseReview.id, findingId: findings[0].id });
  const tp = await f.store.appendReviewFeedback({ ...fp, id: 'mixed-tp', label: 'TP', findingId: findings[1].id });
  const request = await f.store.createRevisionRequest({ id: 'mixed-request', baseRuleDigest: f.baseRule.digest, requestedRuleVersion: f.candidateInput.version,
    feedbackIds: [fp.id, tp.id], requestedChange: 'Preserve separately established same-file positive', actor: 'fixture-author', source: 'fixture', createdAt: f.feedback.createdAt });
  const updated = { ...f, baseReview, feedback: fp, finding: findings[0], request }, value = claim(updated);
  const saved = await f.store.createRevisionComparison({ ...f.input, id: 'mixed-comparison', requestDigest: request.digest,
    reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: f.candidateReview.id }],
    caseBindings: f.input.caseBindings.map(binding => ({ ...binding, baseReviewId: baseReview.id })), applicability: policy([value]) });
  expect(saved.comparison.feedback.map(item => item.outcome)).toEqual(['corrected', 'regressed']);
  expect(saved.comparison.coverage?.lostPositiveObligations).toBe(1);
  expect(saved.comparison.summary.status).toBe('regressed');
  const unrelated = makeReviewEvidence(f.snapshot, findings[1].anchor, 'fixture-context');
  expect(() => validateComparisonApplicabilityResponse(context(updated), { ...value.response, evidence: [unrelated], evidenceRefs: [unrelated.id] })).toThrow(/own after-side/);
}, 30_000);

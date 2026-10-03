import { buildComparisonApplicabilityInput, validateComparisonApplicabilityResponse, comparisonApplicabilityHasCompleteContext } from './comparison-applicability.js';
import { validateComparisonApplicabilityExecution } from './comparison-applicability-execution.js';
import { digestOf, ruleVersionDigest } from './core/identity.js';
import { RepositoryContextDigestSetSchema, ReviewRepositoryContextsSchema } from './core/semantic-review-context.js';
import { ProblemCaseSchema, type ProblemCase } from './core/model.js';
import { SemanticRuleVersionSchema, type StoredRuleVersion } from './core/semantic-rule.js';
import { type StoredChangeSnapshot } from './change-snapshot.js';
import { type LocalReviewFeedback, type ReviewFinding, type ReviewTarget, type SemanticReview, type SnapshotAnchor, type StoredRevisionRequest } from './core/semantic-review.js';
import { COMPARISON_LIMITS, RevisionComparisonInputSchema, RevisionComparisonSchema, type ComparisonObservation, type ComparisonOutcome, type RevisionComparisonInput, type RevisionComparison } from './core/revision-comparison.js';

export class RevisionComparisonError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RevisionComparisonError'; }
}
const fail = (code: string, message: string): never => { throw new RevisionComparisonError(code, message); };
/** Count unique resolved records incrementally; readers stop before loading more of an oversized graph. */
export function comparisonInputBudget(): (value: unknown) => void {
  let bytes = 0;
  return value => {
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > COMPARISON_LIMITS.inputBytes) fail('COMPARISON_LIMIT', 'Aggregate comparison input graph exceeds 16MB');
  };
}
export type ComparisonPair = { base: SemanticReview; candidate: SemanticReview; snapshot: StoredChangeSnapshot };
export type ComparisonFeedback = { feedback: LocalReviewFeedback; finding: ReviewFinding; review: SemanticReview };
export type RevisionComparisonContext = {
  request: StoredRevisionRequest; baseRule: StoredRuleVersion; candidateRule: StoredRuleVersion;
  cases: ProblemCase[]; feedback: ComparisonFeedback[]; pairs: ComparisonPair[];
};
const unscored = (reason: ComparisonObservation['reason']): ComparisonObservation => ({ state: 'unscored', reason });
const expectedForRole = (role: 'positive' | 'negative' | 'fixed') => role === 'positive' ? 'violation' : 'safe';

/** Stable identity deliberately excludes rule-specific target and finding IDs. */
function targetFor(review: SemanticReview, path: string, sourceDigest: string): ReviewTarget | undefined {
  return review.coverage.targets.find(target => target.path === path && target.sourceDigest === sourceDigest);
}
function observeLegacy(review: SemanticReview, path: string, sourceDigest: string, anchor?: SnapshotAnchor): ComparisonObservation {
  const target = targetFor(review, path, sourceDigest);
  if (!target || target.disposition !== 'captured') return unscored('target_not_captured');
  if (!target.scans.length) return unscored('no_assets');
  if (target.scans.some(scan => scan.state !== 'scanned')) return unscored('incomplete_scans');
  if (!target.scans.some(scan => (scan.candidateCount ?? 0) > 0)) return unscored('zero_hits');
  if (target.semantic.state === 'not_run') return unscored('semantic_not_run');
  if (target.semantic.state === 'unknown') return { state: 'unknown', reason: 'semantic_unknown' };
  if (!anchor || target.semantic.state === 'safe') return { state: target.semantic.state, reason: 'explicit_semantic_judgment' };
  const finding = review.findings.find(value => digestOf(value.anchor) === digestOf(anchor));
  if (finding?.status === 'violation' || finding?.status === 'safe') return { state: finding.status, reason: 'explicit_semantic_judgment' };
  // No finding at an old FP anchor is not proof of safety, even if another anchor was adjudicated.
  return unscored('anchor_unscored');
}
/** Static coverage is independent of semantic evidence. A file case declares its
 * file scope; feedback instead requires an explicit same-anchor adjudication. */
function observeSemantic(review: SemanticReview, path: string, sourceDigest: string, anchor?: SnapshotAnchor): ComparisonObservation {
  const target = targetFor(review, path, sourceDigest);
  if (!target || target.disposition !== 'captured') return unscored('target_not_captured');
  if (target.scans.some(scan => scan.state !== 'scanned')) return unscored('incomplete_scans');
  if (target.semantic.state === 'not_run') {
    if (!target.scans.length) return unscored('no_assets');
    if (!target.scans.some(scan => (scan.candidateCount ?? 0) > 0)) return unscored('zero_hits');
    return unscored('semantic_not_run');
  }
  if (target.semantic.state === 'unknown') return { state: 'unknown', reason: 'semantic_unknown' };
  if (!anchor) return { state: target.semantic.state, reason: 'explicit_semantic_judgment' };
  const judgments = review.executionReceipt?.workerResult.value.judgments ?? review.fixtures?.judgments ?? [];
  const judgment = judgments.find(value => value.targetId === target.id);
  // A cited context excerpt or an inherited file-wide safe finding is not an
  // explicit declaration about the selected feedback anchor.
  if (!judgment || !('findingAnchors' in judgment) || !judgment.findingAnchors.some(value => digestOf(value) === digestOf(anchor))) return unscored('anchor_unscored');
  const finding = review.findings.find(value => value.targetId === target.id && digestOf(value.anchor) === digestOf(anchor));
  return finding?.status === 'violation' || finding?.status === 'safe'
    ? { state: finding.status, reason: 'explicit_semantic_judgment' } : unscored('anchor_unscored');
}
/** Per-anchor outcomes remain independent of target completeness. Findings have
 * already applied the anchor's own required/reported context gates; evidence
 * citations and target-wide decisions are never substitutes for explicit claims. */
function observePerAnchor(review: SemanticReview, path: string, sourceDigest: string, anchor?: SnapshotAnchor): ComparisonObservation {
  if (!anchor) return observeSemantic(review, path, sourceDigest);
  const target = targetFor(review, path, sourceDigest);
  if (!target || target.disposition !== 'captured') return unscored('target_not_captured');
  if (target.scans.some(scan => scan.state !== 'scanned')) return unscored('incomplete_scans');
  const judgments = review.executionReceipt?.workerResult.value.judgments ?? review.fixtures?.judgments ?? [];
  const judgment = judgments.find(value => value.targetId === target.id);
  if (!judgment || !('anchorJudgments' in judgment)) return observeSemantic(review, path, sourceDigest, anchor);
  const explicit = judgment.anchorJudgments.find(value => digestOf(value.anchor) === digestOf(anchor));
  if (!explicit) return unscored('anchor_unscored');
  const finding = review.findings.find(value => value.targetId === target.id && digestOf(value.anchor) === digestOf(anchor));
  if (finding?.status === 'unknown') return { state: 'unknown', reason: 'semantic_unknown' };
  return finding?.status === 'violation' || finding?.status === 'safe'
    ? { state: finding.status, reason: 'explicit_semantic_judgment' } : unscored('anchor_unscored');
}
export type RevisionComparisonScorer = 'legacy-detector-v1' | 'explicit-semantic-v2' | 'per-anchor-semantic-v3' | 'per-anchor-context-v4' | 'scope-applicability-v5';
/** Detect the versioned contract itself, including malformed attempts to omit its selection. */
export function reviewUsesRepositoryContext(review: SemanticReview): boolean {
  return review.config.runtime === 'semantic-snapshot-review-v3' || review.repositoryContexts !== undefined
    || review.config.repositoryContextDigests !== undefined || review.fixtures?.schemaVersion === 3
    || review.executionReceipt?.judgmentContract === 'per-anchor-context-v4'
    || review.executionReceipt?.workerResult.outputContract === 'semantic-review-v3'
    || (review.fixtures?.evidence ?? review.executionReceipt?.workerResult.value.evidence ?? [])
      .some(item => 'kind' in item.anchor && item.anchor.kind === 'repository-context');
}
export function comparisonReviewContextDigests(review: SemanticReview): string[] | undefined {
  if (!reviewUsesRepositoryContext(review)) return undefined;
  const digests = RepositoryContextDigestSetSchema.parse(review.config.repositoryContextDigests);
  const contexts = ReviewRepositoryContextsSchema.parse(review.repositoryContexts);
  if (review.config.runtime !== 'semantic-snapshot-review-v3'
    || digestOf(contexts.map(item => item.digest).sort()) !== digestOf(digests)) {
    fail('COMPARISON_CONTEXT_MISMATCH', 'Context review requires its exact immutable selected repository context packages');
  }
  return digests;
}
export function defaultRevisionComparisonScorer(context: RevisionComparisonContext): RevisionComparisonScorer {
  return [...context.pairs.flatMap(pair => [pair.base, pair.candidate]), ...context.feedback.map(item => item.review)]
    .some(reviewUsesRepositoryContext) ? 'per-anchor-context-v4' : 'per-anchor-semantic-v3';
}
function outcome(expected: ProblemCase['expected'], base: ComparisonObservation, candidate: ComparisonObservation): ComparisonOutcome {
  const known = (value: ComparisonObservation) => value.state === 'violation' || value.state === 'safe' || value.state === 'not_applicable';
  if (expected === 'unknown' || !known(base) || !known(candidate)) return 'inconclusive';
  if (candidate.state === expected || (candidate.state === 'not_applicable' && expected === 'safe')) return base.state === expected ? 'preserved' : 'corrected';
  return base.state === expected ? 'regressed' : 'still_failing';
}

/** Derives a report from already validated, pinned storage inputs; never runs a detector or model. */
export function deriveRevisionComparison(input: RevisionComparisonInput, context: RevisionComparisonContext, scorer: RevisionComparisonScorer = input.applicability === undefined ? defaultRevisionComparisonScorer(context) : 'scope-applicability-v5'): RevisionComparison {
  const options = RevisionComparisonInputSchema.parse(input), { request, baseRule, candidateRule } = context;
  const applicabilityScorer = scorer === 'scope-applicability-v5';
  if (applicabilityScorer !== (options.applicability !== undefined)) fail('COMPARISON_APPLICABILITY_MISMATCH', 'Dedicated applicability policy requires the v5 scorer');
  const contextScorer = defaultRevisionComparisonScorer(context) === 'per-anchor-context-v4';
  if (contextScorer && scorer !== 'per-anchor-context-v4' && !applicabilityScorer) fail('UNSUPPORTED_COMPARISON_CONTEXT', 'Repository context evidence requires the per-anchor-context-v4 scorer');
  if (!contextScorer && scorer === 'per-anchor-context-v4') fail('COMPARISON_CONTEXT_MISMATCH', 'Context scorer requires a selected context-enabled review');
  const observe = scorer === 'legacy-detector-v1' ? observeLegacy : scorer === 'explicit-semantic-v2' ? observeSemantic : observePerAnchor;
  const base = SemanticRuleVersionSchema.parse(baseRule.rule), candidate = SemanticRuleVersionSchema.parse(candidateRule.rule);
  if (ruleVersionDigest(base) !== baseRule.digest || ruleVersionDigest(candidate) !== candidateRule.digest
    || digestOf(request.request) !== request.digest || request.digest !== options.requestDigest
    || candidateRule.digest !== options.candidateRuleDigest || baseRule.digest !== request.request.baseRuleDigest) fail('INTEGRITY_FAILURE', 'Comparison parent digest mismatch');
  if (candidate.ruleId !== base.ruleId || candidate.provenance.parentDigest !== baseRule.digest || candidate.version !== request.request.requestedRuleVersion) {
    fail('INVALID_REVISION_CANDIDATE', 'Candidate must have the same ruleId, exact requested version and direct base parent digest');
  }
  if (context.pairs.length !== options.reviewPairs.length || context.feedback.length !== request.request.feedbackIds.length) fail('INTEGRITY_FAILURE', 'Incomplete comparison input selection');
  const pairMap = new Map<string, ComparisonPair>();
  const reviewBindings = context.pairs.map((pair, index) => {
    const selected = options.reviewPairs[index];
    if (pair.base.id !== selected.baseReviewId || pair.candidate.id !== selected.candidateReviewId
      || pair.base.ruleDigest !== baseRule.digest || pair.candidate.ruleDigest !== candidateRule.digest
      || pair.base.snapshotDigest !== pair.candidate.snapshotDigest || pair.snapshot.digest !== pair.base.snapshotDigest) {
      fail('COMPARISON_BINDING_MISMATCH', 'Each pair requires exact base/candidate rule reviews of the same snapshot');
    }
    const baseContexts = comparisonReviewContextDigests(pair.base), candidateContexts = comparisonReviewContextDigests(pair.candidate);
    if (digestOf(baseContexts ?? []) !== digestOf(candidateContexts ?? [])) fail('COMPARISON_CONTEXT_MISMATCH', 'Paired reviews must use the exact same selected repository context digest set');
    pairMap.set(pair.base.id, pair);
    return { ...selected, snapshotDigest: pair.snapshot.digest, baseReviewDigest: digestOf(pair.base), candidateReviewDigest: digestOf(pair.candidate),
      ...(baseContexts ? { repositoryContextDigests: baseContexts } : {}) };
  });
  const applicabilityObservations = new Map<string, ComparisonObservation>();
  for (const adjudication of options.applicability?.adjudications ?? []) {
    const entry = context.feedback.find(value => value.feedback.id === adjudication.binding.feedbackId);
    const pair = entry ? pairMap.get(entry.feedback.reviewId) : undefined;
    if (!entry || !pair) fail('COMPARISON_APPLICABILITY_MISMATCH', 'Applicability must name selected feedback with its exact selected review pair');
    const selected = { request, baseRule, candidateRule, pair: pair!, feedback: entry! };
    const prepared = buildComparisonApplicabilityInput(selected);
    if (digestOf(adjudication.binding) !== digestOf(prepared.binding)) fail('COMPARISON_APPLICABILITY_MISMATCH', 'Applicability evidence differs from exact frozen comparison inputs');
    const response = adjudication.kind === 'comparison-applicability-offline-fixture'
      ? validateComparisonApplicabilityResponse(selected, adjudication.response)
      : validateComparisonApplicabilityExecution(adjudication.receipt, selected);
    const observation: ComparisonObservation = !comparisonApplicabilityHasCompleteContext(selected, response) || response.decision === 'UNKNOWN'
      ? { state: 'unknown', reason: 'applicability_unknown' }
      : response.decision === 'NOT_APPLICABLE' ? { state: 'not_applicable', reason: 'explicit_not_applicable' }
      : { state: 'unscored', reason: 'scope_still_applicable' };
    applicabilityObservations.set(entry!.feedback.id, observation);
  }
  let lostPositiveObligations = 0;
  const losesPositive = (expected: string, baseObservation: ComparisonObservation, pair: ComparisonPair | undefined, path: string, sourceDigest: string) =>
    applicabilityScorer && expected === 'violation' && baseObservation.state === 'violation' && pair !== undefined
      && targetFor(pair.base, path, sourceDigest)?.disposition === 'captured' && targetFor(pair.candidate, path, sourceDigest)?.disposition === 'out_of_scope';
  const cases = new Map(context.cases.map(value => [value.id, ProblemCaseSchema.parse(value)]));
  if (cases.size !== context.cases.length || cases.size > COMPARISON_LIMITS.cases) fail('COMPARISON_LIMIT', 'Comparison source/regression cases must be unique and bounded');
  for (const rule of [base, candidate]) {
    for (const id of new Set([...rule.regressionCases.map(value => value.caseId), ...rule.provenance.sourceCases.map(value => value.caseId)])) {
      const problemCase = cases.get(id) ?? fail('NOT_FOUND', `Missing declared problem case ${id}`);
      if (problemCase.split === 'holdout') fail('HOLDOUT_CONTAMINATION', 'Heldout cases cannot author or regress a local candidate');
    }
    for (const source of rule.provenance.sourceCases) {
      const problemCase = cases.get(source.caseId)!;
      if (source.repository !== problemCase.repository || source.commit !== problemCase.commit || source.path !== problemCase.path || source.sourceDigest !== problemCase.sourceDigest) fail('SOURCE_MISMATCH', 'Rule source reference differs from its immutable ProblemCase');
    }
  }
  const caseIds = [...new Set([...base.regressionCases, ...candidate.regressionCases].map(value => value.caseId))].sort();
  const caseBindings = new Map(options.caseBindings.map(value => [value.caseId, value.baseReviewId]));
  for (const binding of options.caseBindings) {
    if (!caseIds.includes(binding.caseId) || !pairMap.has(binding.baseReviewId)) fail('COMPARISON_BINDING_MISMATCH', 'Case bindings must name declared regression cases and selected base review pairs');
  }
  const results = caseIds.map(caseId => {
    const problemCase = cases.get(caseId)!;
    const baseRole = base.regressionCases.find(value => value.caseId === caseId)?.role ?? null;
    const candidateRole = candidate.regressionCases.find(value => value.caseId === caseId)?.role ?? null;
    if (baseRole && candidateRole && expectedForRole(baseRole) !== expectedForRole(candidateRole)) fail('REGRESSION_EXPECTATION_MISMATCH', 'Candidate cannot relabel a positive regression into a negative or vice versa');
    const role = baseRole ?? candidateRole!;
    if (problemCase.expected !== 'unknown' && problemCase.expected !== expectedForRole(role)) fail('REGRESSION_EXPECTATION_MISMATCH', 'Regression role contradicts the stored ProblemCase expectation');
    const baseReviewId = caseBindings.get(caseId) ?? null, pair = baseReviewId ? pairMap.get(baseReviewId)! : undefined;
    if (pair) {
      const snapshot = pair.snapshot.snapshot;
      const side = snapshot.changes.find(change => change.after.state !== 'absent' && change.after.path === problemCase.path)?.after;
      if (snapshot.repository.id !== problemCase.repository || snapshot.head !== problemCase.commit || side?.state !== 'captured' || side.sha256 !== problemCase.sourceDigest) {
        fail('COMPARISON_BINDING_MISMATCH', 'ProblemCase must match snapshot repository, full head commit, captured after path and source digest');
      }
    }
    const baseObservation = pair ? observe(pair.base, problemCase.path, problemCase.sourceDigest) : unscored('missing_case_binding');
    const candidateObservation = pair ? observe(pair.candidate, problemCase.path, problemCase.sourceDigest) : unscored('missing_case_binding');
    const positiveLost = losesPositive(problemCase.expected, baseObservation, pair, problemCase.path, problemCase.sourceDigest);
    if (positiveLost) lostPositiveObligations++;
    return { caseId, caseDigest: digestOf(problemCase), baseRole, candidateRole, expected: problemCase.expected,
      repository: problemCase.repository, commit: problemCase.commit, path: problemCase.path, sourceDigest: problemCase.sourceDigest,
      baseReviewId, snapshotDigest: pair?.snapshot.digest ?? null, base: baseObservation, candidate: candidateObservation,
      outcome: positiveLost ? 'regressed' as const : outcome(problemCase.expected, baseObservation, candidateObservation) };
  });
  const feedback = context.feedback.map((entry, index) => {
    const { feedback, finding, review } = entry, selected = request.request.feedbackBindings[index];
    if (feedback.id !== request.request.feedbackIds[index] || selected.id !== feedback.id || selected.digest !== digestOf(feedback)
      || feedback.ruleDigest !== baseRule.digest || finding.id !== feedback.findingId || finding.reviewId !== feedback.reviewId
      || finding.ruleDigest !== baseRule.digest || finding.ruleVersion !== feedback.ruleVersion || finding.anchor.side !== 'after'
      || review.id !== feedback.reviewId || !review.findings.some(value => digestOf(value) === digestOf(finding))) fail('COMPARISON_BINDING_MISMATCH', 'Selected feedback must bind to its exact base finding and after anchor');
    const expected = feedback.kind === 'label' && feedback.label === 'TP' ? 'violation' : feedback.kind === 'label' && feedback.label === 'FP' ? 'safe' : 'unknown';
    const pair = pairMap.get(feedback.reviewId), anchor = finding.anchor;
    if (pair && (anchor.snapshotDigest !== pair.snapshot.digest || !pair.base.findings.some(value => digestOf(value) === digestOf(finding)))) fail('COMPARISON_BINDING_MISMATCH', 'Feedback finding is not an exact member of the selected base review');
    const baseObservation = pair ? observe(pair.base, anchor.path, anchor.sourceDigest, anchor) : unscored('missing_pair');
    const candidateObservation = applicabilityObservations.get(feedback.id) ?? (pair ? observe(pair.candidate, anchor.path, anchor.sourceDigest, anchor) : unscored('missing_pair'));
    const positiveLost = losesPositive(expected, baseObservation, pair, anchor.path, anchor.sourceDigest);
    if (positiveLost) lostPositiveObligations++;
    return { feedbackId: feedback.id, feedbackDigest: digestOf(feedback), findingId: finding.id, anchor,
      baseReviewId: review.id, baseReviewDigest: digestOf(review), source: feedback.source, label: feedback.label, expected,
      ...(reviewUsesRepositoryContext(review) ? { repositoryContextDigests: comparisonReviewContextDigests(review) } : {}), base: baseObservation, candidate: candidateObservation,
      outcome: positiveLost ? 'regressed' as const : outcome(expected, baseObservation, candidateObservation) };
  });
  const outcomes = [...results, ...feedback].map(value => value.outcome);
  const count = (value: ComparisonOutcome) => outcomes.filter(item => item === value).length;
  const summary = { status: (outcomes.some(value => value === 'regressed' || value === 'still_failing') ? 'regressed' : outcomes.includes('inconclusive') ? 'inconclusive' : 'compatible') as RevisionComparison['summary']['status'],
    preserved: count('preserved'), corrected: count('corrected'), regressed: count('regressed'), stillFailing: count('still_failing'), inconclusive: count('inconclusive') };
  const coverageCount = (side: 'base' | 'candidate') => {
    const counts = { captured: 0, out_of_scope: 0, unsupported_scope: 0, deleted: 0, excluded: 0 };
    for (const pair of context.pairs) for (const target of pair[side].coverage.targets) counts[target.disposition]++;
    return counts;
  };
  const result = RevisionComparisonSchema.parse({ schemaVersion: 1, kind: 'rule-revision-comparison', input: options,
    ...(scorer === 'legacy-detector-v1' ? {} : { scorer }),
    baseRuleDigest: baseRule.digest, ruleId: base.ruleId, baseVersion: base.version, candidateVersion: candidate.version,
    reviewBindings, problemCaseBindings: [...cases.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(value => ({ caseId: value.id, digest: digestOf(value) })), cases: results, feedback, summary, ...(applicabilityScorer ? { coverage: { base: coverageCount('base'), candidate: coverageCount('candidate'), lostPositiveObligations } } : {}), synthesis: 'not_run', activation: 'not_performed',
    trust: { semanticEvidence: context.pairs.some(pair => pair.base.executionReceipt || pair.candidate.executionReceipt)
      || context.feedback.some(entry => entry.review.executionReceipt) || options.applicability?.adjudications.some(value => value.kind === 'comparison-applicability-workspace-execution') ? 'includes-workspace-execution-receipts' : 'offline-fixture-declarations',
      identity: 'caller-declared-unverified', snapshot: 'package-integrity-only', scope: 'declared-cases-and-selected-feedback-only', certification: 'none' } });
  if (Buffer.byteLength(JSON.stringify(result)) > COMPARISON_LIMITS.resultBytes) fail('COMPARISON_LIMIT', 'Comparison exceeds bounded result bytes');
  return result;
}

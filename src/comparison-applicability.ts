import { digestOf, ruleVersionDigest } from './core/identity.js';
import { SemanticRuleVersionSchema, matchesRuleScope } from './core/semantic-rule.js';
import { RevisionRequestSchema, LocalReviewFeedbackSchema } from './core/semantic-review.js';
import { ComparisonApplicabilityBindingSchema, ComparisonApplicabilityModelResponseSchema } from './core/comparison-applicability-model.js';
import { validateSemanticReview } from './semantic-review.js';
import { validateSnapshotAnchor } from './adapters/semantic-review-fixture.js';
import { validateRepositoryContextEvidence } from './repository-context.js';
import { validateReviewRepositoryContexts } from './semantic-review-context.js';
import { boundedJson, freeze } from './workspace/execution-receipt.js';
import type { ComparisonFeedback, ComparisonPair, RevisionComparisonContext } from './revision-comparison.js';
import type { SnapshotAnchor } from './core/semantic-review-evidence.js';

export type ComparisonApplicabilityContext = Pick<RevisionComparisonContext, 'request' | 'baseRule' | 'candidateRule'> & {
  pair: ComparisonPair; feedback: ComparisonFeedback;
};
/** Dedicated, selected-finding comparison channel. Normal review scope is unchanged. */
export function buildComparisonApplicabilityInput(input: ComparisonApplicabilityContext) {
  boundedJson(input, 16_000_000, 'Comparison applicability input');
  const { request, baseRule, candidateRule, pair, feedback: selected } = input;
  const base = SemanticRuleVersionSchema.parse(baseRule.rule), candidate = SemanticRuleVersionSchema.parse(candidateRule.rule);
  const requestValue = RevisionRequestSchema.parse(request.request), feedback = LocalReviewFeedbackSchema.parse(selected.feedback);
  const { finding } = selected;
  if (ruleVersionDigest(base) !== baseRule.digest || ruleVersionDigest(candidate) !== candidateRule.digest || digestOf(requestValue) !== request.digest
    || requestValue.baseRuleDigest !== baseRule.digest || candidate.provenance.parentDigest !== baseRule.digest
    || candidate.ruleId !== base.ruleId || candidate.version !== requestValue.requestedRuleVersion) throw new Error('Applicability rule/request binding mismatch');
  const baseReview = validateSemanticReview(pair.base, baseRule, pair.snapshot);
  const candidateReview = validateSemanticReview(pair.candidate, candidateRule, pair.snapshot);
  if (digestOf(selected.review) !== digestOf(baseReview)
    || feedback.reviewId !== baseReview.id || feedback.ruleDigest !== baseRule.digest || feedback.ruleVersion !== base.version
    || finding.id !== feedback.findingId || finding.reviewId !== baseReview.id || finding.ruleDigest !== baseRule.digest || finding.ruleVersion !== base.version
    || !baseReview.findings.some(value => digestOf(value) === digestOf(finding))
    || !requestValue.feedbackIds.includes(feedback.id) || !requestValue.feedbackBindings.some(value => value.id === feedback.id && value.digest === digestOf(feedback))) {
    throw new Error('Applicability requires an exact selected base feedback finding');
  }
  const anchor = finding.anchor;
  validateSnapshotAnchor(anchor, pair.snapshot);
  const baseTarget = baseReview.coverage.targets.find(value => value.id === finding.targetId);
  const candidateTarget = candidateReview.coverage.targets.find(value => value.path === anchor.path && value.sourceDigest === anchor.sourceDigest);
  if (anchor.side !== 'after' || baseTarget?.disposition !== 'captured' || candidateTarget?.disposition !== 'out_of_scope'
    || digestOf(base.scope.repositories) !== digestOf(candidate.scope.repositories)
    || digestOf(base.scope.paths) === digestOf(candidate.scope.paths)
    || !matchesRuleScope(base.scope, pair.snapshot.snapshot.repository.id, anchor.path)
    || matchesRuleScope(candidate.scope, pair.snapshot.snapshot.repository.id, anchor.path)) {
    throw new Error('Applicability requires a captured base target excluded by a literal candidate path change');
  }
  const contexts = baseReview.repositoryContexts === undefined ? [] : validateReviewRepositoryContexts(baseReview.repositoryContexts, pair.snapshot);
  if (digestOf(contexts) !== digestOf(candidateReview.repositoryContexts ?? [])
    || digestOf(baseReview.config.repositoryContextDigests ?? []) !== digestOf(candidateReview.config.repositoryContextDigests ?? [])) {
    throw new Error('Applicability requires identical pinned review context selections');
  }
  const binding = ComparisonApplicabilityBindingSchema.parse({ policy: 'selected-finding-applicability-v1', requestDigest: request.digest,
    baseRuleDigest: baseRule.digest, candidateRuleDigest: candidateRule.digest, baseVersion: base.version, candidateVersion: candidate.version,
    baseReviewId: baseReview.id, baseReviewDigest: digestOf(baseReview), candidateReviewId: candidateReview.id, candidateReviewDigest: digestOf(candidateReview),
    snapshotDigest: pair.snapshot.digest, repository: pair.snapshot.snapshot.repository.id, head: pair.snapshot.snapshot.head,
    feedbackId: feedback.id, feedbackDigest: digestOf(feedback), findingId: finding.id, findingDigest: digestOf(finding), anchor,
    repositoryContextDigests: contexts.map(value => value.digest).sort() });
  // Clone before freezing: never freeze caller-owned storage results or mutable input graphs.
  return freeze(structuredClone({ binding, baseRule, candidateRule, snapshot: pair.snapshot, repositoryContexts: contexts, feedback, finding }));
}

/** Verify byte identity and ownership, never the semantic truth of a declared context kind. */
export function validateComparisonApplicabilityResponse(input: ComparisonApplicabilityContext, raw: unknown) {
  const prepared = buildComparisonApplicabilityInput(input);
  const response = ComparisonApplicabilityModelResponseSchema.parse(raw);
  boundedJson(response, 1_000_000, 'Comparison applicability response');
  if (response.bindingDigest !== digestOf(prepared.binding)) throw new Error('Applicability response binding mismatch');
  const evidence = new Map(response.evidence.map(value => [value.id, value]));
  for (const item of response.evidence) {
    if ('kind' in item.anchor && item.anchor.kind === 'repository-context') {
      const contextDigest = item.anchor.contextDigest;
      const context = prepared.repositoryContexts.find(value => value.digest === contextDigest);
      if (!context) throw new Error('Applicability cites an unselected repository context');
      validateRepositoryContextEvidence(item as import('./repository-context.js').RepositoryContextEvidence, context);
    } else {
      const content = validateSnapshotAnchor(item.anchor as SnapshotAnchor, prepared.snapshot);
      if (content !== item.content || item.id !== digestOf({ kind: item.kind, anchor: item.anchor, content: item.content })) throw new Error('Applicability evidence identity/excerpt mismatch');
    }
  }
  if (response.evidenceRefs.some(ref => !evidence.has(ref))) throw new Error('Applicability cites unavailable evidence');
  if (response.decision !== 'UNKNOWN' && !response.evidenceRefs.some(ref => {
    const item = evidence.get(ref)!;
    return 'side' in item.anchor && item.anchor.side === 'after' && item.anchor.path === prepared.binding.anchor.path
      && item.anchor.sourceDigest === prepared.binding.anchor.sourceDigest
      && item.anchor.span.start.offset <= prepared.binding.anchor.span.start.offset
      && item.anchor.span.end.offset >= prepared.binding.anchor.span.end.offset;
  })) throw new Error('Decisive applicability requires its own after-side target evidence');
  return response;
}
/** Required/reported context is per claim, never borrowed from another adjudication. */
export function comparisonApplicabilityHasCompleteContext(input: ComparisonApplicabilityContext, response: ReturnType<typeof validateComparisonApplicabilityResponse>) {
  const base = SemanticRuleVersionSchema.parse(input.baseRule.rule), candidate = SemanticRuleVersionSchema.parse(input.candidateRule.rule);
  const kinds = new Set(response.evidence.filter(value => response.evidenceRefs.includes(value.id)).map(value => value.kind));
  return response.missingContext.length === 0 && [...base.semantics.requiredContext, ...candidate.semantics.requiredContext].every(kind => kinds.has(kind));
}

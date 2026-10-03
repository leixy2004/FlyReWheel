import { digestOf, ruleVersionDigest } from '../../src/core/identity.js';
import { LocalReviewFeedbackSchema, RevisionRequestSchema, reviewTargetId, type ContextReviewFixture } from '../../src/core/semantic-review.js';
import { buildSemanticReview } from '../../src/semantic-review.js';
import { type StoredChangeSnapshot } from '../../src/change-snapshot.js';
import { DEFAULT_REPOSITORY_CONTEXT_LIMITS, validateRepositoryContext, makeRepositoryContextAnchor, makeRepositoryContextEvidence } from '../../src/repository-context.js';
import { makeReviewEvidence, makeSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { capturedSide, semanticInputs } from './semantic-review-fixture.js';

export function downstreamContext(snapshot: StoredChangeSnapshot, path = 'src/unchanged-contract.ts', source = '// Authored supporting contract; not independently verified truth\n') {
  const entry = capturedSide(path, source);
  return validateRepositoryContext({ schemaVersion: 1, kind: 'git-repository-context', repository: snapshot.snapshot.repository,
    head: snapshot.snapshot.head, selection: 'explicit-paths-at-head', limits: DEFAULT_REPOSITORY_CONTEXT_LIMITS, entries: [entry],
    coverage: { selectedPaths: 1, capturedPaths: 1, excludedPaths: 0, missingPaths: 0, capturedBytes: entry.byteLength,
      scope: 'selected-paths-only', historicalAvailability: 'unproven' } });
}
export function downstreamContextEvidence(context: ReturnType<typeof downstreamContext>, kind: string) {
  const entry = context.context.entries[0];
  if (entry.state !== 'captured') throw new Error('Expected captured synthetic context');
  const length = Buffer.from(entry.bytesBase64, 'base64').toString().length;
  return makeRepositoryContextEvidence(context, makeRepositoryContextAnchor(context, entry.path, 0, length), kind);
}
export function contextComparisonFixture() {
  const { rule: baseRule, snapshot, problemCase } = semanticInputs();
  const candidate = { ...baseRule.rule, version: 'context-candidate', provenance: { ...baseRule.rule.provenance, parentDigest: baseRule.digest } };
  const candidateRule = { rule: candidate, digest: ruleVersionDigest(candidate) };
  const context = downstreamContext(snapshot), evidence = downstreamContextEvidence(context, 'local-policy');
  const side = snapshot.snapshot.changes[0].after;
  if (side.state !== 'captured') throw new Error('Expected captured synthetic target');
  const { path, sha256 } = side, source = Buffer.from(side.bytesBase64, 'base64').toString();
  const start = source.indexOf('dangerousRead()');
  const anchor = makeSnapshotAnchor(snapshot, 'after', path, start, start + 'dangerousRead()'.length);
  const sourceEvidence = makeReviewEvidence(snapshot, anchor, 'changed-source');
  function review(rule: typeof baseRule, decision: 'violation' | 'safe', selectedContext = context) {
    const proof = downstreamContextEvidence(selectedContext, 'local-policy');
    const fixtures: ContextReviewFixture = { schemaVersion: 3, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest,
      snapshotDigest: snapshot.digest, repositoryContextDigests: [selectedContext.digest], evidence: [sourceEvidence, proof], judgments: [{
        targetId: reviewTargetId(rule.digest, snapshot.digest, 0, path, sha256), decision, reasoning: 'Authored context-gated target declaration', evidenceRefs: [sourceEvidence.id, proof.id], missingContext: [],
        anchorJudgments: [{ anchor, decision, reasoning: 'Authored exact target declaration', evidenceRefs: [sourceEvidence.id, proof.id], missingContext: [] }],
      }] };
    return buildSemanticReview({ rule, snapshot, fixtures, repositoryContexts: [selectedContext] });
  }
  const baseReview = review(baseRule, 'violation'), candidateReview = review(candidateRule, 'safe'), finding = baseReview.findings[0];
  const feedback = LocalReviewFeedbackSchema.parse({ id: 'context-feedback', findingId: finding.id, reviewId: baseReview.id, ruleDigest: baseRule.digest,
    ruleVersion: baseRule.rule.version, source: 'fixture', actor: 'fixture-author', kind: 'label', label: 'FP', reason: 'Authored exact finding declaration only', createdAt: '2026-10-02T00:00:00Z' });
  const requestValue = RevisionRequestSchema.parse({ schemaVersion: 1, kind: 'rule-revision-request', status: 'pending', synthesis: 'not_run', id: 'context-request',
    baseRuleDigest: baseRule.digest, requestedRuleVersion: candidateRule.rule.version, feedbackIds: [feedback.id], feedbackBindings: [{ id: feedback.id, digest: digestOf(feedback) }],
    requestedChange: 'Compare exact context-gated findings', actor: 'fixture-author', source: 'fixture', createdAt: '2026-10-02T00:00:00Z' });
  const request = { digest: digestOf(requestValue), request: requestValue };
  const graph = { request, baseRule, candidateRule, cases: [problemCase], feedback: [{ feedback, finding, review: baseReview }],
    pairs: [{ base: baseReview, candidate: candidateReview, snapshot }] };
  const input = { id: 'context-comparison', requestDigest: request.digest, candidateRuleDigest: candidateRule.digest,
    reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: candidateReview.id }], caseBindings: [] };
  return { input, graph, context, evidence, snapshot, baseRule, candidateRule, baseReview, candidateReview, review };
}

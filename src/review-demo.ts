import { createHash } from 'node:crypto';
import { type QualEvoStore } from './storage/store.js';
import { DEFAULT_SNAPSHOT_LIMITS, validateChangeSnapshot } from './change-snapshot.js';
import { sourceDigest } from './adapters/candidates.js';
import { makeReviewEvidence, makeSnapshotAnchor } from './adapters/semantic-review-fixture.js';
import { type SemanticRuleVersion } from './core/semantic-rule.js';
import { type ProblemCase } from './core/model.js';
import { type ReviewFixture } from './core/semantic-review.js';

/** Synthetic local plumbing demonstration. It never creates a human approval or correctness label. */
export async function runSemanticReviewDemo(store: QualEvoStore) {
  const before = 'export function load() { return null; }\n';
  const after = '// Synthetic policy fixture: a guard is required\nexport function load() { return dangerousRead(); }\n';
  const path = 'src/demo.ts', repository = 'synthetic:semantic-review-demo', createdAt = '2026-10-01T00:00:00Z';
  const side = (source: string) => {
    const bytes = Buffer.from(source);
    return { state: 'captured' as const, path, mode: '100644' as const,
      objectId: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), byteLength: bytes.length,
      sha256: sourceDigest(source), bytesBase64: bytes.toString('base64') };
  };
  const problemCase: ProblemCase = { id: 'semantic-review-demo-source', lineageId: 'semantic-review-demo-source', split: 'training', expected: 'unknown',
    title: 'Synthetic review demonstration; not human-assessed', repository, commit: '1'.repeat(40), path, sourceDigest: sourceDigest(before),
    provenance: { kind: 'synthetic', reference: 'fixture:semantic-review-demo', reviewedBy: null, derivedFromCaseId: null } };
  const rule: SemanticRuleVersion = { schemaVersion: 2, ruleId: 'semantic-review-demo', version: 'draft-1',
    semantics: { title: 'Check guarded reads', mechanism: 'An unguarded read may violate local access policy.', invariant: 'Follow the read policy.',
      applicability: ['Policy-governed reads'], exceptions: ['Explicit public access'], requiredContext: ['local-policy'], expectedBehavior: 'Require policy evidence; abstain when it is unavailable.' },
    scope: { repositories: [repository], paths: { include: ['src'], exclude: [] } },
    detectionAssets: ['first-hint', 'overlapping-hint'].map(id => ({ id, detector: { kind: 'ast-grep' as const, language: 'typescript', pattern: 'dangerousRead()' } })),
    regressionCases: [], provenance: { sourceCases: [{ caseId: problemCase.id, repository, commit: problemCase.commit, path, sourceDigest: problemCase.sourceDigest }],
      parentDigest: null, author: 'synthetic-fixture', createdAt, rationale: 'Demonstrate immutable review, duplicate aggregation, fixture feedback and a pending request only.' } };
  const storedRule = await store.importRuleVersion(rule, [problemCase]);
  const snapshot = await store.importChangeSnapshot(validateChangeSnapshot({ schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: repository, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' }, baseTip: '1'.repeat(40), mergeBase: '1'.repeat(40), head: '2'.repeat(40),
    comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    changes: [{ status: 'M', before: side(before), after: side(after) }],
    coverage: { changedPaths: 1, capturedSides: 2, excludedSides: 0, capturedBytes: Buffer.byteLength(before) + Buffer.byteLength(after), scope: 'changed-entries-only' },
  }).snapshot);
  const structural = await store.runSemanticReview({ ruleDigest: storedRule.digest, snapshotDigest: snapshot.digest });
  const anchor = makeSnapshotAnchor(snapshot, 'after', path, after.indexOf('dangerousRead()'), after.indexOf('dangerousRead()') + 'dangerousRead()'.length);
  const evidence = makeReviewEvidence(snapshot, makeSnapshotAnchor(snapshot, 'after', path, 0, after.indexOf('\n')), 'local-policy');
  const fixtures: ReviewFixture = { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: storedRule.digest, snapshotDigest: snapshot.digest, evidence: [evidence],
    judgments: [{ targetId: structural.coverage.targets[0].id, decision: 'violation', reasoning: 'Explicit synthetic fixture judgment; no model adjudication occurred.', evidenceRefs: [evidence.id], findingAnchors: [anchor] }] };
  const review = await store.runSemanticReview({ ruleDigest: storedRule.digest, snapshotDigest: snapshot.digest, fixtures });
  const finding = review.findings[0];
  const feedback = await store.appendReviewFeedback({ id: 'semantic-review-demo-note', findingId: finding.id, reviewId: review.id, ruleDigest: storedRule.digest,
    ruleVersion: rule.version, source: 'fixture', actor: 'synthetic-fixture', kind: 'note', label: null,
    reason: 'Synthetic workflow note: clarify which policy evidence the rule requires. This is not human feedback.', createdAt });
  const request = await store.createRevisionRequest({ id: 'semantic-review-demo-request', baseRuleDigest: storedRule.digest, requestedRuleVersion: 'draft-2-requested',
    feedbackIds: [feedback.id], requestedChange: 'Consider clarifying the required local-policy evidence using this explicitly synthetic note.', actor: 'synthetic-fixture', source: 'fixture', createdAt });
  return { mode: 'synthetic_offline_demo' as const, ruleDigest: storedRule.digest, snapshotDigest: snapshot.digest,
    structuralReviewId: structural.id, review, finding: await store.getReviewFinding(finding.id), feedback, revisionRequest: request,
    limitations: ['Synthetic snapshot declarations are package-integrity-only, not verified Git history.', 'Fixture judgments demonstrate plumbing, not model quality or human approval.',
      'Changed-file evidence is incomplete repository context; introduction and notification eligibility remain unverified.', 'The revision request is pending; no rule version was generated, reserved or activated.'] };
}

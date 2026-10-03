import { createHash } from 'node:crypto';
import { type QualEvoStore } from './storage/store.js';
import { DEFAULT_SNAPSHOT_LIMITS, validateChangeSnapshot } from './change-snapshot.js';
import { sourceDigest } from './adapters/candidates.js';
import { makeReviewEvidence, makeSnapshotAnchor } from './adapters/semantic-review-fixture.js';
import { type SemanticRuleVersion } from './core/semantic-rule.js';
import { type ProblemCase } from './core/model.js';
import { type ReviewFixture } from './core/semantic-review.js';

/** Authored offline examples only. An accepted fixture decision is never a human approval. */
export async function runRevisionComparisonDemo(store: QualEvoStore) {
  const repository = 'synthetic:revision-comparison-demo', createdAt = '2026-10-01T00:00:00Z';
  const before = 'export function load() { return null; }\n';
  const examples = [
    { id: 'revision-demo-positive', path: 'src/positive.ts', role: 'positive' as const, expected: 'violation' as const,
      source: '// Synthetic policy: protected reads require isAuthorized().\nexport function load() { return dangerousRead(); }\n' },
    { id: 'revision-demo-negative', path: 'src/negative.ts', role: 'negative' as const, expected: 'safe' as const,
      source: '// Synthetic policy: protected reads require isAuthorized().\nexport function load() { if (isAuthorized()) return dangerousRead(); return null; }\n' },
  ];
  const side = (path: string, source: string) => {
    const bytes = Buffer.from(source);
    return { state: 'captured' as const, path, mode: '100644' as const,
      objectId: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), byteLength: bytes.length,
      sha256: sourceDigest(source), bytesBase64: bytes.toString('base64') };
  };
  const cases: ProblemCase[] = examples.map(example => ({ id: example.id, lineageId: example.id, split: 'training', expected: example.expected,
    title: `Authored synthetic ${example.role} regression fixture; not human-assessed`, repository, commit: '2'.repeat(40),
    path: example.path, sourceDigest: sourceDigest(example.source),
    provenance: { kind: 'synthetic', reference: `fixture:${example.id}`, reviewedBy: null, derivedFromCaseId: null } }));
  const base: SemanticRuleVersion = { schemaVersion: 2, ruleId: 'revision-comparison-demo', version: 'draft-base',
    semantics: { title: 'Protected read policy', mechanism: 'Unguarded protected reads violate the declared local policy.',
      invariant: 'Protected reads require authorization.', applicability: ['Protected reads'], exceptions: [], requiredContext: ['local-policy'],
      expectedBehavior: 'Base fixture deliberately over-reports the guarded negative example.' },
    scope: { repositories: [repository], paths: { include: ['src'], exclude: [] } },
    detectionAssets: [{ id: 'protected-read-hint', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'dangerousRead()' } }],
    regressionCases: examples.map(example => ({ caseId: example.id, role: example.role })),
    provenance: { sourceCases: cases.map(value => ({ caseId: value.id, repository, commit: value.commit, path: value.path, sourceDigest: value.sourceDigest })),
      parentDigest: null, author: 'synthetic-fixture', createdAt, rationale: 'Authored base for local revision comparison plumbing, not measured model quality.' } };
  const storedBase = await store.importRuleVersion(base, cases);
  const snapshot = await store.importChangeSnapshot(validateChangeSnapshot({ schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: repository, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: '1'.repeat(40), mergeBase: '1'.repeat(40), head: '2'.repeat(40), comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    changes: examples.map(example => ({ status: 'M' as const, before: side(example.path, before), after: side(example.path, example.source) }))
      .sort((a, b) => a.after.path.localeCompare(b.after.path)),
    coverage: { changedPaths: examples.length, capturedSides: examples.length * 2, excludedSides: 0,
      capturedBytes: examples.reduce((total, example) => total + Buffer.byteLength(before) + Buffer.byteLength(example.source), 0), scope: 'changed-entries-only' },
  }).snapshot);
  const review = async (ruleDigest: string, decisions: ('violation' | 'safe')[]) => {
    // This structural run both executes real ast-grep and exposes the exact target identities.
    const structural = await store.runSemanticReview({ ruleDigest, snapshotDigest: snapshot.digest });
    const evidence = examples.map(example => makeReviewEvidence(snapshot,
      makeSnapshotAnchor(snapshot, 'after', example.path, 0, example.source.indexOf('\n')), 'local-policy'));
    const fixtures: ReviewFixture = { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest, snapshotDigest: snapshot.digest, evidence,
      judgments: examples.map((example, index) => ({ targetId: structural.coverage.targets.find(target => target.path === example.path)!.id,
        decision: decisions[index], reasoning: `Explicit authored synthetic ${decisions[index]} judgment; no model or human assessment occurred.`,
        evidenceRefs: [evidence[index].id], findingAnchors:
          [makeSnapshotAnchor(snapshot, 'after', example.path, example.source.indexOf('dangerousRead()'), example.source.indexOf('dangerousRead()') + 'dangerousRead()'.length)] })) };
    return store.runSemanticReview({ ruleDigest, snapshotDigest: snapshot.digest, fixtures });
  };
  const baseReview = await review(storedBase.digest, ['violation', 'violation']);
  const feedback = await Promise.all(examples.map(async (example, index) => {
    const finding = baseReview.findings.find(value => value.anchor.path === example.path)!;
    return store.appendReviewFeedback({ id: `revision-demo-${example.role}-label`, findingId: finding.id, reviewId: baseReview.id,
      ruleDigest: storedBase.digest, ruleVersion: base.version, source: 'fixture', actor: 'synthetic-fixture', kind: 'label', label: index === 0 ? 'TP' : 'FP',
      reason: `Explicit authored fixture ${index === 0 ? 'TP' : 'FP'} expectation at this exact anchor; not human feedback or file-wide ground truth.`, createdAt });
  }));
  const candidate = async (name: 'compatible' | 'regressed') => {
    const version = name === 'compatible' ? 'draft-guard-aware' : 'draft-lost-positive';
    const request = await store.createRevisionRequest({ id: `revision-demo-${name}-request`, baseRuleDigest: storedBase.digest,
      requestedRuleVersion: version, feedbackIds: feedback.map(value => value.id),
      requestedChange: name === 'compatible' ? 'Fixture request: recognize the explicit guard without losing the unguarded positive.' : 'Fixture request: demonstrate a candidate that loses the unguarded positive.',
      actor: 'synthetic-fixture', source: 'fixture', createdAt });
    const rule: SemanticRuleVersion = { ...base, version, semantics: { ...base.semantics,
      exceptions: name === 'compatible' ? ['Explicit isAuthorized() guard'] : ['Fixture-only deliberately overbroad exception'],
      expectedBehavior: name === 'compatible' ? 'Preserve unguarded violations while treating the explicitly guarded fixture as safe.' : 'Deliberately misclassify the positive as safe to demonstrate regression refusal.' },
      provenance: { ...base.provenance, parentDigest: storedBase.digest,
        rationale: `Manually authored ${name} synthetic candidate, not generated from the request or synthesized by a model.` } };
    const stored = await store.importRuleVersion(rule);
    const candidateReview = await review(stored.digest, [name === 'compatible' ? 'violation' : 'safe', 'safe']);
    const comparison = await store.createRevisionComparison({ id: `revision-demo-${name}-comparison`, requestDigest: request.digest, candidateRuleDigest: stored.digest,
      reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: candidateReview.id }],
      caseBindings: examples.map(example => ({ caseId: example.id, baseReviewId: baseReview.id })) });
    const decision = await store.recordRevisionDecision({ id: `revision-demo-${name}-decision`, comparisonDigest: comparison.digest,
      choice: name === 'compatible' ? 'accept' : 'reject', actor: 'synthetic-fixture', source: 'fixture',
      reason: name === 'compatible' ? 'Fixture-only acceptance: preserved positive and corrected safe negative under authored judgments.' : 'Fixture-only rejection: the explicitly safe positive loses the expected violation.', createdAt });
    return { candidateRuleDigest: stored.digest, candidateReviewId: candidateReview.id, request, comparison, decision };
  };
  const compatible = await candidate('compatible'), regressed = await candidate('regressed');
  return { mode: 'synthetic_offline_revision_demo' as const, baseRuleDigest: storedBase.digest, snapshotDigest: snapshot.digest, baseReviewId: baseReview.id,
    feedback, findingVerdicts: await Promise.all(feedback.map(async value => ({ findingId: value.findingId, verdict: (await store.getReviewFinding(value.findingId)).verdict }))),
    compatible, regressed,
    limitations: ['All semantic judgments, case expectations, feedback labels and decisions are authored synthetic fixtures, not model results or human approval.',
      'Snapshots and synthetic Git commit declarations have package-integrity-only trust, not verified repository history.',
      'Comparisons cover only declared regression cases and exact selected feedback anchors; they are not full-repository safety or quality certification.',
      'Both immutable requests remain pending with synthesis not_run; candidates were imported explicitly, and neither decision activates or promotes a rule.'] };
}

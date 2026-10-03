import { createHash } from 'node:crypto';
import { DEFAULT_SNAPSHOT_LIMITS, validateChangeSnapshot, type StoredChangeSnapshot } from '../../src/change-snapshot.js';
import type { ProblemCase } from '../../src/core/model.js';
import type { SemanticRuleVersion, StoredRuleVersion } from '../../src/core/semantic-rule.js';
import type { RevisionComparisonInput, RevisionDecisionInput } from '../../src/core/revision-comparison.js';
import { reviewTargetId, type LocalReviewFeedback, type LegacyReviewFixture } from '../../src/core/semantic-review.js';
import { makeReviewEvidence, makeSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { matchesRuleScope } from '../../src/core/semantic-rule.js';
import { openPGliteDatabase, type Database } from '../../src/storage/database.js';
import { QualEvoStore } from '../../src/storage/store.js';
import { capturedSide } from './semantic-review-fixture.js';

export const comparisonDate = '2026-10-01T00:00:00Z';
export const dangerAsset = { id: 'danger', detector: { kind: 'ast-grep' as const, language: 'typescript', pattern: 'danger($ARG)' } };
type Role = 'positive' | 'negative' | 'fixed';
type Judgment = 'violation' | 'safe' | 'unknown' | 'not_run';
export type ComparisonCaseSpec = {
  id: string; expected: ProblemCase['expected']; baseRole: Role | null; candidateRole: Role | null;
  baseJudgment?: Judgment; candidateJudgment?: Judgment; source?: string; path?: string;
  baseAnchorIndex?: number; candidateAnchorIndex?: number; caseOverrides?: Partial<ProblemCase>;
  baseTargetOnlySafe?: boolean; candidateTargetOnlySafe?: boolean; contextKind?: string;
};
export const defaultComparisonCases: ComparisonCaseSpec[] = [
  { id: 'positive-case', expected: 'violation', baseRole: 'positive', candidateRole: 'positive', baseJudgment: 'violation', candidateJudgment: 'violation' },
  { id: 'safe-case', expected: 'safe', baseRole: 'negative', candidateRole: 'fixed', baseJudgment: 'violation', candidateJudgment: 'safe' },
];
export type ComparisonFixtureOptions = {
  database?: Database; cases?: ComparisonCaseSpec[]; baseAssets?: SemanticRuleVersion['detectionAssets']; candidateAssets?: SemanticRuleVersion['detectionAssets'];
  baseScope?: SemanticRuleVersion['scope']; candidateScope?: SemanticRuleVersion['scope']; feedbackCaseId?: string;
  feedback?: Partial<LocalReviewFeedback>;
};

export async function revisionComparisonFixture(options: ComparisonFixtureOptions = {}) {
  const database = options.database ?? await openPGliteDatabase();
  const store = await QualEvoStore.initialize(database);
  const specs = (options.cases ?? structuredClone(defaultComparisonCases)).slice().sort((a, b) => (a.path ?? `src/${a.id}.ts`).localeCompare(b.path ?? `src/${b.id}.ts`));
  const repository = 'fixture:revision-comparison', head = '2'.repeat(40), base = '1'.repeat(40);
  const sources = specs.map(spec => ({ path: spec.path ?? `src/${spec.id}.ts`, source: spec.source ?? `// ${spec.id}\ndanger(one); danger(two);\n` }));
  const sides = sources.map(source => capturedSide(source.path, source.source));
  const snapshot = await store.importChangeSnapshot(validateChangeSnapshot({
    schemaVersion: 1, kind: 'git-change-snapshot', repository: { id: repository, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: base, mergeBase: base, head, comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    changes: sides.map(after => ({ status: 'A', before: { state: 'absent' }, after })),
    coverage: { changedPaths: sides.length, capturedSides: sides.length, excludedSides: 0, capturedBytes: sides.reduce((sum, side) => sum + side.byteLength, 0), scope: 'changed-entries-only' },
  }).snapshot);
  const cases: ProblemCase[] = specs.map((spec, index) => ({
    id: spec.id, lineageId: `${spec.id}-lineage`, split: 'training', expected: spec.expected, title: `Synthetic ${spec.id}`,
    repository, commit: head, path: sources[index].path, sourceDigest: sides[index].sha256,
    provenance: { kind: 'synthetic', reference: 'fixture:local-revision-comparison', reviewedBy: null, derivedFromCaseId: null },
    ...spec.caseOverrides,
  }));
  const baseInput: SemanticRuleVersion = {
    schemaVersion: 2, ruleId: 'fixture-danger-rule', version: 'base',
    semantics: { title: 'Locally authored danger-call rule', mechanism: 'A call may lack its guard', invariant: 'Danger calls need guards', applicability: ['Danger calls'], exceptions: [], requiredContext: ['fixture-context'], expectedBehavior: 'Use explicit fixture evidence; abstain otherwise' },
    scope: options.baseScope ?? { repositories: [repository], paths: { include: ['src'], exclude: [] } },
    detectionAssets: options.baseAssets ?? [dangerAsset],
    regressionCases: specs.flatMap(spec => spec.baseRole ? [{ caseId: spec.id, role: spec.baseRole }] : []),
    provenance: { sourceCases: [{ caseId: cases[0].id, repository: cases[0].repository, commit: cases[0].commit, path: cases[0].path, sourceDigest: cases[0].sourceDigest }], parentDigest: null, author: 'fixture-author', createdAt: comparisonDate, rationale: 'Authored offline fixture; no correctness certification' },
  };
  const baseRule = await store.importRuleVersion(baseInput, cases);
  const candidateInput: SemanticRuleVersion = { ...baseInput, version: 'candidate',
    scope: options.candidateScope ?? baseInput.scope,
    detectionAssets: options.candidateAssets ?? [dangerAsset],
    regressionCases: specs.flatMap(spec => spec.candidateRole ? [{ caseId: spec.id, role: spec.candidateRole }] : []),
    provenance: { ...baseInput.provenance, parentDigest: baseRule.digest },
  };
  const candidateRule = await store.importRuleVersion(candidateInput);

  function fixtures(rule: StoredRuleVersion, side: 'base' | 'candidate', selectedSnapshot: StoredChangeSnapshot = snapshot): LegacyReviewFixture {
    if (rule.rule.schemaVersion !== 2) throw new Error('Fixture requires semantic rule v2');
    const evidence: LegacyReviewFixture['evidence'] = [], judgments: LegacyReviewFixture['judgments'] = [];
    for (const [index, source] of sources.entries()) {
      if (!matchesRuleScope(rule.rule.scope, selectedSnapshot.snapshot.repository.id, source.path)) continue;
      const state = (side === 'base' ? specs[index].baseJudgment : specs[index].candidateJudgment) ?? 'violation';
      if (state === 'not_run') continue;
      const callIndex = (side === 'base' ? specs[index].baseAnchorIndex : specs[index].candidateAnchorIndex) ?? 0;
      const starts = [...source.source.matchAll(/danger\([^)]*\)/g)];
      const selected = starts[callIndex];
      const start = selected?.index ?? 0, end = selected ? start + selected[0].length : source.source.length;
      const anchor = makeSnapshotAnchor(selectedSnapshot, 'after', source.path, start, end);
      const item = makeReviewEvidence(selectedSnapshot, anchor, specs[index].contextKind ?? 'fixture-context');
      evidence.push(item);
      judgments.push({ targetId: reviewTargetId(rule.digest, selectedSnapshot.digest, index, source.path, sides[index].sha256), decision: state,
        reasoning: 'Explicit authored target and selected-anchor declaration only', evidenceRefs: [item.id],
        findingAnchors: state === 'unknown' || (state === 'safe' && (side === 'base' ? specs[index].baseTargetOnlySafe : specs[index].candidateTargetOnlySafe)) ? [] : [anchor] });
    }
    return { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest, snapshotDigest: selectedSnapshot.digest, evidence, judgments };
  }
  const baseReview = await store.runSemanticReview({ ruleDigest: baseRule.digest, snapshotDigest: snapshot.digest, fixtures: fixtures(baseRule, 'base') });
  const candidateReview = await store.runSemanticReview({ ruleDigest: candidateRule.digest, snapshotDigest: snapshot.digest, fixtures: fixtures(candidateRule, 'candidate') });
  const feedbackCaseId = options.feedbackCaseId ?? (specs.some(spec => spec.id === 'safe-case') ? 'safe-case' : specs[0].id);
  const feedbackIndex = specs.findIndex(spec => spec.id === feedbackCaseId);
  const finding = baseReview.findings.filter(item => item.anchor.path === sources[feedbackIndex].path).sort((a, b) => a.anchor.span.start.offset - b.anchor.span.start.offset)[0];
  if (!finding) throw new Error('Fixture needs at least one baseline finding for feedback');
  const feedback = await store.appendReviewFeedback({ id: 'selected-feedback', findingId: finding.id, reviewId: baseReview.id, ruleDigest: baseRule.digest, ruleVersion: baseInput.version,
    source: 'fixture', actor: 'fixture-author', kind: 'label', label: specs[feedbackIndex].expected === 'safe' ? 'FP' : 'TP', reason: 'Pinned local fixture label', createdAt: comparisonDate, ...options.feedback });
  const request = await store.createRevisionRequest({ id: 'revision-request', baseRuleDigest: baseRule.digest, requestedRuleVersion: candidateInput.version, feedbackIds: [feedback.id],
    requestedChange: 'Compare this separately authored candidate against all declared regressions and selected feedback', actor: 'fixture-author', source: 'fixture', createdAt: comparisonDate });
  const input: RevisionComparisonInput = { id: 'revision-comparison', requestDigest: request.digest, candidateRuleDigest: candidateRule.digest,
    reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: candidateReview.id }], caseBindings: cases.filter(problemCase => specs.some(spec => spec.id === problemCase.id && (spec.baseRole || spec.candidateRole))).map(problemCase => ({ caseId: problemCase.id, baseReviewId: baseReview.id })) };
  return { database, store, cases, specs, sources, snapshot, baseInput, candidateInput, baseRule, candidateRule, baseReview, candidateReview, feedback, finding, request, input, fixtures };
}
export function revisionDecision(comparisonDigest: string, overrides: Partial<RevisionDecisionInput> = {}): RevisionDecisionInput {
  return { id: 'local-decision', comparisonDigest, choice: 'accept', actor: 'fixture-author', source: 'fixture', reason: 'Caller-declared local decision only', createdAt: comparisonDate, ...overrides };
}
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

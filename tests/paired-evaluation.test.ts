import { describe, expect, it, vi } from 'vitest';
import { createPairedEvaluationDemo } from '../src/paired-evaluation-demo.js';
import { evaluatePairedReviews } from '../src/paired-evaluation.js';
import { digestOf, ruleVersionDigest } from '../src/core/identity.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { makeSnapshotAnchor } from '../src/adapters/semantic-review-fixture.js';
import { PAIRED_EVALUATION_LIMITS } from '../src/core/paired-evaluation.js';
import { authoredImportedReceiptReview } from './helpers/paired-evaluation-receipt.js';
import * as astGrep from '../src/adapters/ast-grep.js';

const fixture = createPairedEvaluationDemo;
type Inputs = ReturnType<typeof fixture>;
const score = (v: Inputs) => evaluatePairedReviews(v.dataset, v.annotations, v.runs);
function rebind(v: Inputs) { v.annotations.datasetDigest = v.runs.datasetDigest = digestOf(v.dataset); }
function rebuild(v: Inputs, arm = 0) {
  const u = v.runs.arms[arm].units[0], review = u.review!.value;
  u.rule.digest = ruleVersionDigest(u.rule.rule);
  review.fixtures!.ruleDigest = u.rule.digest;
  const structural = buildSemanticReview({ rule: u.rule, snapshot: v.dataset.prs[0].snapshot });
  review.fixtures!.judgments[0].targetId = structural.coverage.targets[0].id;
  const value = buildSemanticReview({ rule: u.rule, snapshot: v.dataset.prs[0].snapshot, fixtures: review.fixtures!, attempt: review.config.attempt });
  u.review = { digest: digestOf(value), value };
}

describe('offline exact-anchor paired evaluation', () => {
  it('deduplicates positive instances, retains alert burden and exposes gains and losses together', () => {
    const v = fixture(), report = score(v), [base, candidate] = report.arms;
    expect(base.counts).toMatchObject({ prs: 2, units: 2, positiveInstances: 5, negativeInstances: 1, usefulInstances: 2, usefulAlertAnchors: 3,
      redundantPositiveAlertAnchors: 1, falseAlertInstances: 1, falseAlertAnchors: 1, missedPositiveInstances: 3, uniqueAlerts: 7,
      unknownLabelAlertAnchors: 1, excludedLabelAlertAnchors: 1, unmatchedAlertAnchors: 1, unknownTargets: 1, notRunUnits: 1 });
    expect(candidate.counts).toMatchObject({ usefulInstances: 2, falseAlertInstances: 0, missedPositiveInstances: 3, disputedLabelAlertAnchors: 1, failedUnits: 1 });
    expect(report.comparisons[0]).toMatchObject({ status: 'declaration-matched-descriptive', deltas: { usefulInstances: 0, falseAlertInstances: -1, missedPositiveInstances: 0 },
      transitions: { positivesGained: 1, positivesLost: 1, positivesRetained: 1, positivesMissedByBoth: 2, falseAlertInstancesRemoved: 1 } });
    expect(base.perPr[1].counts).toMatchObject({ positiveInstances: 1, missedPositiveInstances: 1, notRunUnits: 1 });
    expect(base.perFamily[0].counts).toEqual(base.counts);
    expect(base.perSplit.find(s => s.split === 'synthetic')!.counts).toEqual(base.counts);
    expect(base.perSplit.find(s => s.split === 'holdout')!.counts.positiveInstances).toBe(0);
    expect(report.inputBindings.annotations.provenance).toMatchObject({ origin: 'synthetic', independentOfRuns: false, blindedToOutputs: false });
  });
  it('has deterministic content identity and never runs a scanner while importing', () => {
    const v = fixture(), spy = vi.spyOn(astGrep, 'detectAstGrep');
    try {
      const one = score(v), two = score(structuredClone(v));
      expect(one).toEqual(two); expect(spy).not.toHaveBeenCalled();
      const { id, digest, ...body } = one;
      expect(digest).toBe(digestOf(body)); expect(id).toBe(`paired_evaluation_${digest}`);
      v.annotations.version = 'v2'; expect(score(v).id).not.toBe(id);
    } finally { spy.mockRestore(); }
  });
  it('keeps missing runs visible and blocks paired deltas without shrinking the roster', () => {
    const v = fixture(); v.runs.arms[1].units.pop();
    const report = score(v);
    expect(report.arms[1].counts).toMatchObject({ units: 2, missingRunUnits: 1, positiveInstances: 5, missedPositiveInstances: 3 });
    expect(report.comparisons[0]).toMatchObject({ status: 'incomparable', deltas: null, transitions: null });
  });
  it.each(['abstained', 'failed', 'not-run'] as const)('retains known positives with %s execution', state => {
    const v = fixture(); v.runs.arms[0].units[0].state = state; v.runs.arms[0].units[0].review = null;
    expect(score(v).arms[0].counts).toMatchObject({ positiveInstances: 5, missedPositiveInstances: 5, usefulInstances: 0, falseAlertInstances: 0 });
  });
  it('leaves shifted or before-side exact anchors unmatched, without fuzzy matching', () => {
    const v = fixture(), pr = v.dataset.prs[0];
    const label = v.annotations.instances[0];
    label.anchors = [makeSnapshotAnchor(pr.snapshot, 'after', 'src/demo.ts', 0, 1)];
    const shifted = score(v).arms[0];
    expect(shifted.counts).toMatchObject({ usefulInstances: 1, unmatchedAlertAnchors: 3, falseAlertInstances: 1 });
    label.anchors = [makeSnapshotAnchor(pr.snapshot, 'before', 'src/demo.ts', 0, 1)];
    expect(score(v).arms[0].counts.usefulInstances).toBe(1);
  });
  it('does not count target-only legacy safe propagation as explicit anchor safety', () => {
    const v = fixture(), unit = v.runs.arms[0].units[0];
    unit.rule = structuredClone(unit.rule); unit.rule.rule.version = 'legacy-target-only';
    unit.rule.rule.detectionAssets = [{ id: 'hint', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'badA()' } }];
    const old = unit.review!.value.fixtures!;
    if (old.schemaVersion !== 2) throw new Error('Expected per-anchor legacy fixture');
    unit.review!.value.fixtures = { schemaVersion: 1, kind: old.kind, ruleDigest: old.ruleDigest, snapshotDigest: old.snapshotDigest, evidence: old.evidence,
      judgments: [{ targetId: old.judgments[0].targetId, decision: 'safe', reasoning: 'Authored legacy whole-target judgment only', evidenceRefs: old.judgments[0].evidenceRefs, findingAnchors: [] }] };
    rebuild(v);
    const base = score(v).arms[0];
    expect(base.counts).toMatchObject({ safePredictionAnchors: 1, explicitSafeInstances: 0, usefulInstances: 0, missedPositiveInstances: 5 });
    expect(base.units[0].predictions[0].explicitAnchor).toBe(false);
  });
  it('retains structural not-verified and incomplete target coverage without manufacturing negatives', () => {
    const v = fixture(), unit = v.runs.arms[0].units[0];
    unit.rule = structuredClone(unit.rule); unit.rule.rule.version = 'structural';
    unit.rule.rule.detectionAssets = [{ id: 'hint', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'badA()' } }, { id: 'unsupported', detector: { kind: 'semgrep', language: 'typescript', yaml: 'rules: []' } }];
    unit.rule.digest = ruleVersionDigest(unit.rule.rule);
    const value = buildSemanticReview({ rule: unit.rule, snapshot: v.dataset.prs[0].snapshot }); unit.review = { digest: digestOf(value), value };
    expect(score(v).arms[0].counts).toMatchObject({ usefulInstances: 0, missedPositiveInstances: 5, notVerifiedAnchors: 1, incompleteScanTargets: 1, notRunTargets: 1 });
  });
  it('reports zero-label units and unmatched alerts without treating any as false positives', () => {
    const v = fixture(); v.annotations.instances = []; v.annotations.coverage.forEach(c => { c.state = 'unassessed'; });
    expect(score(v).arms[0].counts).toMatchObject({ positiveInstances: 0, negativeInstances: 0, falseAlertInstances: 0, unmatchedAlertAnchors: 7, annotationUnassessedUnits: 2 });
  });
  it.each(['model', 'information', 'budget'] as const)('blocks deltas when %s bindings differ', dimension => {
    const v = fixture();
    if (dimension === 'model') v.runs.arms[1].conditions.model.version = 'another-version';
    else v.runs.arms[1].conditions[dimension].manifestDigest = 'f'.repeat(64);
    expect(score(v).comparisons[0]).toMatchObject({ status: 'incomparable', deltas: null, reasons: [`Mismatched declared ${dimension}`] });
  });
  it('preserves policy/version differences as the intervention while matching common conditions', () => {
    const v = fixture(); v.runs.arms[1].policy = { id: 'new-method', version: 'new-version', digest: 'f'.repeat(64) };
    expect(score(v).comparisons[0].status).toBe('declaration-matched-descriptive');
  });
  it('keeps unmeasured cost explicit and blocks comparisons with declared budget overruns', () => {
    const v = fixture(); expect(score(v).arms[0].budgetStatus.state).toBe('unmeasured');
    v.runs.arms[1].totalUsage = { modelCalls: 1, inputTokens: 0, outputTokens: 0, wallTimeMs: 0, costMicros: 0 };
    expect(score(v).comparisons[0].status).toBe('incomparable');
    expect(score(v).arms[1].budgetStatus).toEqual({ state: 'declared-over-budget', exceeded: ['modelCalls'] });
  });
  it('preserves declared human/adjudicated origin without claiming authenticated humans', () => {
    const v = fixture(); v.dataset.sampling.kind = 'purposive'; rebind(v);
    v.annotations.provenance.origin = 'local-human-declared';
    expect(score(v).inputBindings.annotations.provenance.verification).toBe('locally-declared-unverified');
    v.annotations.provenance.origin = 'adjudicated'; expect(() => score(v)).toThrow('at least two');
    v.annotations.provenance.authors.push('declared-second-author'); v.annotations.provenance.evidenceDigests.push('f'.repeat(64));
    expect(score(v).sourceAttestation).toBe('package-integrity-and-local-declarations-only');
  });
  it('surfaces historical exposure, missing independence, incomplete frame and out-of-window checkpoints', () => {
    const v = fixture(); v.dataset.temporal.historyExposure = 'all-local-refs-v1'; v.dataset.sampling.frameUnknownCount = 2;
    v.dataset.temporal.historyCutoff = '2026-10-02T00:00:00Z'; v.dataset.temporal.targetWindowStart = '2026-10-03T00:00:00Z';
    v.dataset.prs[0].checkpointAt = '2026-10-01T00:00:00Z'; rebind(v);
    const warnings = score(v).auditWarnings.join(' ');
    expect(warnings).toContain('future information'); expect(warnings).toContain('not strictly after'); expect(warnings).toContain('outside declared');
    expect(warnings).toContain('independence'); expect(warnings).toContain('unplaced or unknown');
  });
  it.each([
    ['dataset digest', (v: Inputs) => { v.runs.datasetDigest = 'f'.repeat(64); }, /Dataset digest/],
    ['review digest', (v: Inputs) => { v.runs.arms[0].units[0].review!.digest = 'f'.repeat(64); }, /review digest/],
    ['rule digest', (v: Inputs) => { v.runs.arms[0].units[0].rule.digest = 'f'.repeat(64); }, /Rule digest/],
    ['duplicate issue', (v: Inputs) => { v.annotations.instances.push({ ...v.annotations.instances[0], id: 'alias' }); }, /Duplicate issue/],
    ['anchor collision', (v: Inputs) => { v.annotations.instances[1].anchors = v.annotations.instances[0].anchors; }, /multiple issue/],
    ['duplicate anchor', (v: Inputs) => { v.annotations.instances[0].anchors.push(v.annotations.instances[0].anchors[0]); }, /Duplicate annotation anchor/],
    ['PR alias', (v: Inputs) => { v.dataset.prs.push({ ...v.dataset.prs[0], id: 'alias' }); rebind(v); }, /Duplicate PR alias/],
    ['orphan annotation', (v: Inputs) => { v.annotations.instances[0].prId = 'orphan'; }, /Orphan/],
    ['missing coverage', (v: Inputs) => { v.annotations.coverage.pop(); }, /full PR/],
    ['duplicate run', (v: Inputs) => { v.runs.arms[0].units.push(v.runs.arms[0].units[0]); }, /Duplicate arm/],
    ['missing baseline', (v: Inputs) => { v.runs.baselineArmId = 'orphan'; }, /Baseline/],
    ['hidden predictions', (v: Inputs) => { v.runs.arms[0].units[0].state = 'failed'; }, /noncompleted/],
    ['missing completed review', (v: Inputs) => { v.runs.arms[0].units[0].review = null; }, /Completed unit/],
    ['fabricated model execution', (v: Inputs) => { v.runs.arms[0].conditions.model.execution = 'declared-model'; }, /contradicts frozen/],
    ['family rule mapping', (v: Inputs) => { v.dataset.families[0].ruleIds = ['wrong']; rebind(v); }, /family mapping/],
    ['unassessed with labels', (v: Inputs) => { v.annotations.coverage[0].state = 'unassessed'; }, /contradicts unit coverage/],
    ['synthetic labels relabeled human', (v: Inputs) => { v.annotations.provenance.origin = 'local-human-declared'; }, /Synthetic sampling/],
    ['probability without frame', (v: Inputs) => { v.dataset.sampling.kind = 'probability-declared'; rebind(v); }, /Probability sampling/],
  ])('rejects %s', (_name, mutate, error) => { const v = fixture(); mutate(v); expect(() => score(v)).toThrow(error); });
  it.each(['snapshotDigest', 'sourceDigest'] as const)('rejects an annotation with incorrect %s', field => {
    const v = fixture(); v.annotations.instances[0].anchors[0][field] = 'f'.repeat(64); expect(() => score(v)).toThrow();
  });
  it('rejects invalid source positions, invalid UTF-16 spans and forged review semantics despite recomputed package hash', () => {
    const v = fixture(); v.annotations.instances[0].anchors[0].span.start.line = 999; expect(() => score(v)).toThrow();
    const q = fixture(); q.annotations.instances[0].anchors[0].span.end.offset = 1_000_000; expect(() => score(q)).toThrow();
    const r = fixture(), review = r.runs.arms[0].units[0].review!; review.value.findings[0].status = 'safe'; review.digest = digestOf(review.value);
    expect(() => score(r)).toThrow('Finding aggregation');
  });
  it.each(['access', 'historyPolicy'] as const)('rejects receipt contradictions in %s even when both arms declare the same conditions', field => {
    const v = fixture();
    for (const arm of v.runs.arms) {
      arm.units[0].review = authoredImportedReceiptReview(arm.units[0], v.dataset.prs[0].snapshot);
      arm.conditions.model.execution = 'declared-model'; arm.conditions.model.name = 'synthetic-audit-model';
      arm.conditions.information.access = 'full-repository'; arm.conditions.information.historyPolicy = 'all-local-refs-v1';
      if (field === 'access') arm.conditions.information.access = 'diff-only'; else arm.conditions.information.historyPolicy = 'as-of-allowlist-declared';
    }
    expect(() => score(v)).toThrow('contradicts validated workspace');
  });
  it('rejects total usage below receipt tokens/calls and keeps receipt-only overruns visible', () => {
    const v = fixture();
    for (const arm of v.runs.arms) {
      arm.units[0].review = authoredImportedReceiptReview(arm.units[0], v.dataset.prs[0].snapshot);
      arm.conditions.model.execution = 'declared-model'; arm.conditions.model.name = 'synthetic-audit-model';
      arm.conditions.information.access = 'full-repository'; arm.conditions.information.historyPolicy = 'all-local-refs-v1';
    }
    const report = score(v);
    expect(report.arms[0].receiptUsageLowerBound).toEqual({ uniqueWorkspaceReceipts: 1, modelCalls: 1, inputTokens: 100, outputTokens: 10 });
    expect(report.arms[0].budgetStatus.state).toBe('receipt-lower-bound-over-budget');
    expect(report.comparisons[0].status).toBe('incomparable');
    for (const arm of v.runs.arms) {
      arm.conditions.budget.maxModelCalls = 1; arm.conditions.budget.maxInputTokens = 100; arm.conditions.budget.maxOutputTokens = 10;
      arm.totalUsage = { modelCalls: 1, inputTokens: 100, outputTokens: 10, wallTimeMs: 0, costMicros: 0 };
    }
    expect(score(v).comparisons[0].status).toBe('declaration-matched-descriptive');
    for (const field of ['modelCalls', 'inputTokens', 'outputTokens'] as const) {
      const q = structuredClone(v); q.runs.arms[0].totalUsage![field] = 0; expect(() => score(q)).toThrow('below the frozen review receipt lower bound');
    }
  });
  it('does not upgrade authored workspace receipts to model execution or authenticated source evidence', () => {
    const v = fixture();
    for (const arm of v.runs.arms) {
      arm.units[0].review = authoredImportedReceiptReview(arm.units[0], v.dataset.prs[0].snapshot, { boundary: 'authored-test-no-isolation', inputTokens: 0, outputTokens: 0 });
      arm.conditions.information.access = 'full-repository'; arm.conditions.information.historyPolicy = 'all-local-refs-v1';
    }
    const report = score(v); expect(report.sourceAttestation).toBe('package-integrity-and-local-declarations-only');
    expect(report.arms[0].workspaceReceiptBindings[0].modelExecution).toBe('not_run');
    expect(report.arms[0].receiptUsageLowerBound.modelCalls).toBe(0);
  });
  it('preserves the exact legacy paired report identity when evaluation bindings are absent', () => {
    const v = fixture();
    for (const arm of v.runs.arms) {
      arm.units[0].review = authoredImportedReceiptReview(arm.units[0], v.dataset.prs[0].snapshot,
        { boundary: 'authored-test-no-isolation', inputTokens: 0, outputTokens: 0 });
      arm.conditions.information.access = 'full-repository'; arm.conditions.information.historyPolicy = 'all-local-refs-v1';
    }
    // Pinned from the pre-evaluation source with these deterministic authored imports.
    expect(score(v).digest).toBe('422add541d4264b32e2a4b063a01cd344979d8b2a057ea8b151a006558ca665d');
  });
  it.each(['authored-test-no-isolation', 'isolated-runtime'] as const)(
    'preserves exact-closure receipt policy without upgrading %s provenance or historical visibility', boundary => {
      const v = fixture(), snapshot = v.dataset.prs[0].snapshot;
      const evaluation = { schemaVersion: 1 as const, exportId: 'authored-export', requestDigest: 'a'.repeat(64), recordDigest: 'b'.repeat(64),
        repositoryId: snapshot.snapshot.repository.id, checkoutSha: snapshot.snapshot.head, allowedHeads: [snapshot.snapshot.head],
        inventory: { count: 1, expandedBytes: 1, digest: 'c'.repeat(64) } };
      for (const arm of v.runs.arms) {
        arm.units[0].review = authoredImportedReceiptReview(arm.units[0], snapshot, { boundary, evaluation, inputTokens: 0, outputTokens: 0 });
        arm.conditions.information.access = 'full-repository'; arm.conditions.information.historyPolicy = 'exact-allowed-head-closure-v1';
        if (boundary === 'isolated-runtime') {
          arm.conditions.model.execution = 'declared-model'; arm.conditions.model.name = 'synthetic-audit-model';
        }
      }
      const report = score(v);
      expect(report.sourceAttestation).toBe('package-integrity-and-local-declarations-only');
      expect(report.temporal).toEqual(v.dataset.temporal);
      expect(report.auditWarnings).toContain('As-of visibility is not declared');
      expect(report.limitations.join(' ')).toContain('temporal isolation are unverified declarations');
      for (const arm of report.arms) {
        expect(arm.conditions.information.historyPolicy).toBe('exact-allowed-head-closure-v1');
        expect(arm.workspaceReceiptBindings[0]).toMatchObject({ historyPolicy: 'exact-allowed-head-closure-v1', context: { evaluation },
          modelExecution: boundary === 'isolated-runtime' ? 'completed' : 'not_run' });
        expect(arm.receiptUsageLowerBound.modelCalls).toBe(boundary === 'isolated-runtime' ? 1 : 0);
      }
      for (const arm of v.runs.arms) arm.conditions.information.historyPolicy = 'all-local-refs-v1';
      expect(() => score(v)).toThrow('contradicts validated workspace');
    });
  it('rejects conflicting immutable rule versions, unsupported schema and inferred source feedback fields', () => {
    const v = fixture(); v.runs.arms[1].units[0].rule = structuredClone(v.runs.arms[1].units[0].rule); v.runs.arms[1].units[0].rule.rule.semantics.title = 'changed'; rebuild(v, 1);
    expect(() => score(v)).toThrow('immutable rule/version');
    const q = fixture(); expect(() => evaluatePairedReviews(q.dataset, { ...q.annotations, schemaVersion: 2 }, q.runs)).toThrow();
    expect(() => evaluatePairedReviews(q.dataset, { ...q.annotations, merged: true }, q.runs)).toThrow();
  });
  it('enforces byte, roster and annotation bounds before producing a report', () => {
    const v = fixture(); expect(() => evaluatePairedReviews({ huge: 'x'.repeat(PAIRED_EVALUATION_LIMITS.datasetBytes) }, v.annotations, v.runs)).toThrow('exceeds');
    expect(() => evaluatePairedReviews(v.dataset, { huge: 'x'.repeat(PAIRED_EVALUATION_LIMITS.annotationBytes) }, v.runs)).toThrow('exceeds');
    v.dataset.prs = Array.from({ length: 26 }, () => v.dataset.prs[0]); rebind(v); expect(() => score(v)).toThrow();
    const q = fixture(); q.annotations.instances = Array.from({ length: 2001 }, () => q.annotations.instances[0]); expect(() => score(q)).toThrow();
  });
});

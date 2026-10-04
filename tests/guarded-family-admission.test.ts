import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digestOf, ruleVersionDigest } from '../src/core/identity.js';
import { createGuardedFamilyFixture } from '../experiments/annotation/guarded-family-fixture.js';
import { validateGuardedFamily, inspectGuardedLabelRoute } from '../experiments/annotation/guarded-family.js';
import { EvaluationAnnotationSchema } from '../src/core/paired-evaluation.js';
import { makeSnapshotAnchor } from '../src/adapters/semantic-review-fixture.js';
function annotations(f: ReturnType<typeof createGuardedFamilyFixture>, labels: ('positive' | 'negative' | 'unknown' | 'disputed' | 'excluded' | null)[]) {
  return EvaluationAnnotationSchema.parse({ schemaVersion: 1, kind: 'paired-review-evaluation-annotations', id: 'authored-route', version: 'v1',
    datasetDigest: digestOf(f.plan.dataset), rubricDigest: digestOf(f.plan.rubrics),
    provenance: { origin: 'synthetic', verification: 'locally-declared-unverified', authors: ['authored-fixture'],
      independentOfRuns: false, blindedToOutputs: false, procedure: 'Authored structural test, not human annotation', evidenceDigests: [] },
    coverage: f.plan.dataset.prs.map((p, i) => ({ prId: p.id, familyId: 'fixture-family', state: labels[i] === null ? 'unassessed' : labels[i] === 'excluded' ? 'excluded' : 'complete-declared', reason: 'Authored test' })),
    instances: f.plan.opportunities.flatMap((o, i) => labels[i] === null ? [] : [{ ...o, label: labels[i], reason: 'Authored test', evidenceDigests: o.anchors.map(a => a.sourceDigest) }]) });
}
describe('guarded development family measurement admission', () => {
  it('binds the existing rule, rubric, complete annotation plan and target source identities', () => {
    const f = createGuardedFamilyFixture(); expect(validateGuardedFamily(f.spec, f.plan).spec.admission).toBe('authored-development-only-not-httpx-or-h2');
    const report = inspectGuardedLabelRoute(f.spec, f.plan, annotations(f, ['positive', 'negative', 'unknown']), f.targets);
    expect(report.rows.map(r => r.proposedLabel)).toEqual(['violation', null, 'unknown']);
    expect(report.rows.every(r => r.repeatedFeedbackMechanism === null && r.state === 'blocked')).toBe(true);
    expect(report.rows[1].reasons).toContain('negative-needs-independent-legal-neighbor-vs-safe-applicable-judgment');
    expect(report.matchedFuture).toBeNull(); expect(report.independentHumanLabels).toBe(0);
  });
  it('preserves excluded, missing and disputed without making an incomplete scored roster', () => {
    const f = createGuardedFamilyFixture(); const report = inspectGuardedLabelRoute(f.spec, f.plan, annotations(f, ['excluded', null, 'disputed']), f.targets);
    expect(report.rows).toHaveLength(3); expect(report.rows.map(r => r.sourceLabel)).toEqual(['excluded', null, 'disputed']);
    expect(report.rows[0].reasons).toContain('excluded-not-representable-as-a-scored-future-label');
    expect(report.rows[1].reasons).toContain('missing-assessment-not-an-unknown-label');
    expect(report.matchedFuture).toBeNull();
  });
  it('rejects changed rule, family, plan, target bytes, target scope, labels and missing targets', () => {
    for (const change of ['rule', 'semantics-rehashed', 'provenance-rehashed', 'family', 'scope', 'plan', 'bytes', 'target-scope', 'label-identity', 'target-missing']) {
      const f = createGuardedFamilyFixture(), a = annotations(f, ['positive', 'negative', 'unknown']);
      if (change === 'rule') f.spec.rule.semantics.invariant = 'A substituted invariant';
      if (change === 'semantics-rehashed') { f.spec.rule.semantics.applicability = ['Unrelated operations']; Object.assign(f.spec, { ruleDigest: ruleVersionDigest(f.spec.rule) }); }
      if (change === 'provenance-rehashed') { f.spec.rule.provenance.author = 'replacement'; Object.assign(f.spec, { ruleDigest: ruleVersionDigest(f.spec.rule) }); }
      if (change === 'family') f.plan.dataset.families[0].ruleIds = ['substituted'];
      if (change === 'scope') { f.spec.rule.scope.paths.include = ['other']; Object.assign(f.spec, { ruleDigest: ruleVersionDigest(f.spec.rule) }); }
      if (change === 'plan') f.plan.sourceBindings[0].capturedAt = '2099-01-01T00:00:00Z';
      if (change === 'bytes') f.targets[0].source += 'substituted';
      if (change === 'target-scope') f.targets[0].issueScope.end--;
      if (change === 'label-identity') a.instances[0].issueId = 'substituted';
      if (change === 'target-missing') f.targets.pop();
      expect(() => inspectGuardedLabelRoute(f.spec, f.plan, a, f.targets), change).toThrow();
    }
  });
  it('retains multi-anchor and missing-context blocks rather than truncating or asserting a matched label', () => {
    const f = createGuardedFamilyFixture(), target = f.targets[0];
    f.plan.opportunities[0].anchors = [makeSnapshotAnchor(f.plan.dataset.prs[0].snapshot, 'after', target.path, 0, 3),
      makeSnapshotAnchor(f.plan.dataset.prs[0].snapshot, 'after', target.path, 3, target.source.length)];
    f.spec.planDigest = digestOf(f.plan); f.targets[1].missingEvidence = ['Guard contract absent'];
    const report = inspectGuardedLabelRoute(f.spec, f.plan, annotations(f, ['positive', 'negative', 'unknown']), f.targets);
    expect(report.rows[0].reasons).toContain('multiple-anchors-cannot-be-truncated-to-one-target');
    expect(report.rows[0].proposedLabel).toBeNull();
    expect(report.rows[1].reasons).toContain('matched-target-declares-missing-context');
    expect(report.matchedFuture).toBeNull();
    f.targets[0].source += 'substituted';
    expect(() => inspectGuardedLabelRoute(f.spec, f.plan, annotations(f, ['positive', 'negative', 'unknown']), f.targets)).toThrow('source bytes');
  });
  it('rejects promotion to human/HTTPX/holdout and never reads the original matched fixture labels', () => {
    const f = createGuardedFamilyFixture();
    expect(() => validateGuardedFamily({ ...f.spec, origin: 'local-human-declared' }, f.plan)).toThrow();
    f.plan.dataset.prs[0].split = 'holdout'; f.spec.planDigest = digestOf(f.plan);
    expect(() => validateGuardedFamily(f.spec, f.plan)).toThrow();
  });
  it('runs an offline retained-source audit and exports only blank authored annotation packets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guarded-family-test-'));
    try {
      const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/annotation/guarded-family-replay.ts', ...args]);
      const out = join(root, 'audit.json'); await cli('retained-admission', '--out', out);
      const report = JSON.parse(await readFile(out, 'utf8'));
      expect(report.rows).toHaveLength(3); expect(report.admittedEmpiricalFamilies).toBe(0); expect(report.h2EpisodeAdmission).toBe('blocked');
      const workspace = join(root, 'private'); await cli('init-authored', '--out', workspace);
      const blank = JSON.parse(await readFile(join(workspace, 'rater-1/response.blank.json'), 'utf8'));
      expect(blank.tasks.every((t: any) => t.rows.every((r: any) => r.label === null))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

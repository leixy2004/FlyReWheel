import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateChangeSnapshot, DEFAULT_SNAPSHOT_LIMITS } from './change-snapshot.js';
import { digestOf, ruleVersionDigest } from './core/identity.js';
import { type SemanticRuleVersion } from './core/semantic-rule.js';
import { type AnchorReviewFixture } from './core/semantic-review.js';
import { type EvaluationDataset, type EvaluationAnnotations, type EvaluationRuns, type EvaluationArm } from './core/paired-evaluation.js';
import { makeSnapshotAnchor, makeReviewEvidence } from './adapters/semantic-review-fixture.js';
import { buildSemanticReview } from './semantic-review.js';
import { evaluatePairedReviews, writeEvaluationJson } from './paired-evaluation.js';

/** Deterministically authored oracle and predictions. No live execution, human labels or efficacy evidence. */
export function createPairedEvaluationDemo() {
  const repository = 'synthetic:paired-evaluation', path = 'src/demo.ts';
  const after = 'badA();\nbadARepeat();\nlegal();\nlost();\ngained();\nunresolved();\nuncertain();\nexcluded();\nextra();\ndisputed();\n';
  const before = '// synthetic before checkpoint\n';
  const side = (text: string) => {
    const bytes = Buffer.from(text);
    return { state: 'captured' as const, path, mode: '100644' as const,
      objectId: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
  };
  const snapshot = (head: string, source: string) => validateChangeSnapshot({
    schemaVersion: 1, kind: 'git-change-snapshot', repository: { id: repository, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: '1'.repeat(40), mergeBase: '1'.repeat(40), head: head.repeat(40), comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    changes: [{ status: 'M', before: side(before), after: side(source) }],
    coverage: { changedPaths: 1, capturedSides: 2, excludedSides: 0, capturedBytes: Buffer.byteLength(before + source), scope: 'changed-entries-only' },
  });
  const first = snapshot('2', after), second = snapshot('3', 'missedInFailedRun();\n');
  const rule: SemanticRuleVersion = { schemaVersion: 2, ruleId: 'authored-call-rule', version: 'fixture-v1',
    semantics: { title: 'Authored synthetic oracle only', mechanism: 'Names stand for distinct authored issue instances.', invariant: 'Follow the separate authored labels for this structural test.',
      applicability: ['Synthetic calls'], exceptions: ['The authored legal call'], requiredContext: ['synthetic-oracle-context'], expectedBehavior: 'Exercise deterministic counts, uncertainty and exact-anchor matching.' },
    scope: { repositories: [repository], paths: { include: ['src'], exclude: [] } }, regressionCases: [],
    provenance: { sourceCases: [{ caseId: 'synthetic-source', repository, commit: '1'.repeat(40), path, sourceDigest: side(before).sha256 }], parentDigest: null,
      author: 'synthetic-fixture-author', createdAt: '2026-10-02T00:00:00Z', rationale: 'Authored test oracle, not a learned or human-validated rule.' } };
  const storedRule = { digest: ruleVersionDigest(rule), rule };
  const anchor = (name: string) => makeSnapshotAnchor(first, 'after', path, after.indexOf(`${name}()`), after.indexOf(`${name}()`) + name.length + 2);
  const dataset: EvaluationDataset = {
    schemaVersion: 1, kind: 'paired-review-evaluation-dataset', id: 'authored-demo', version: 'v1', protocolDigest: digestOf('authored demonstration protocol v1'),
    sampling: { kind: 'synthetic', population: 'Two authored PR declarations only', frameDigest: null, selectionProcedure: 'Hand-authored to exercise counting and integrity edge cases', frameUnknownCount: 0, limitations: ['No empirical sample or representative effect estimate'] },
    temporal: { historyCutoff: null, targetWindowStart: null, targetWindowEnd: null, annotationObservationCutoff: null, visibility: 'synthetic', historyExposure: 'synthetic', isolationManifestDigest: null, pretrainingExposure: 'synthetic', limitations: ['Synthetic chronology; no historical isolation experiment'] },
    sourceAttestation: 'locally-declared-unverified', families: [{ id: 'call-family', ruleIds: [rule.ruleId], definitionDigest: digestOf(rule.semantics), description: 'Frozen authored synthetic issue family' }],
    prs: [first, second].map((value, index) => ({ id: `pr-${index + 1}`, repository, number: index + 1, split: 'synthetic', lineageId: `synthetic-pr-${index + 1}`,
      inclusionProbability: null, checkpointAt: null, checkpointEvidenceDigest: null, snapshot: value })),
  };
  const datasetDigest = digestOf(dataset);
  const annotations: EvaluationAnnotations = {
    schemaVersion: 1, kind: 'paired-review-evaluation-annotations', id: 'authored-oracle', version: 'v1', datasetDigest, rubricDigest: digestOf('exact synthetic call anchors; repeated badA is one issue'),
    provenance: { origin: 'synthetic', verification: 'locally-declared-unverified', authors: ['synthetic-fixture-author'], independentOfRuns: false, blindedToOutputs: false,
      procedure: 'Labels and predicted outputs are separately serialized but deliberately co-authored to test a known counting oracle; no independent human annotation occurred.', evidenceDigests: [] },
    coverage: dataset.prs.map(pr => ({ prId: pr.id, familyId: 'call-family', state: 'complete-declared', reason: 'All authored test labels are enumerated, not a claim of real PR coverage.' })),
    instances: [
      { id: 'positive-repeated', label: 'positive' as const, names: ['badA', 'badARepeat'] },
      { id: 'negative-legal', label: 'negative' as const, names: ['legal'] },
      { id: 'positive-lost', label: 'positive' as const, names: ['lost'] },
      { id: 'positive-gained', label: 'positive' as const, names: ['gained'] },
      { id: 'positive-unresolved', label: 'positive' as const, names: ['unresolved'] },
      { id: 'unknown-label', label: 'unknown' as const, names: ['uncertain'] },
      { id: 'excluded-label', label: 'excluded' as const, names: ['excluded'] },
      { id: 'disputed-label', label: 'disputed' as const, names: ['disputed'] },
    ].map(({ id, label, names }) => ({ id, prId: 'pr-1', familyId: 'call-family', issueId: id, lineageId: id, label, anchors: names.map(anchor), reason: 'Explicitly authored synthetic oracle label', evidenceDigests: [] })),
  };
  annotations.instances.push({ id: 'positive-failed-run', prId: 'pr-2', familyId: 'call-family', issueId: 'positive-failed-run', lineageId: 'positive-failed-run', label: 'positive',
    anchors: [makeSnapshotAnchor(second, 'after', path, 0, 'missedInFailedRun()'.length)], reason: 'Known synthetic positive retained despite no completed review', evidenceDigests: [] });
  const statuses = {
    baseline: ['violation', 'violation', 'violation', 'violation', 'safe', 'unknown', 'violation', 'violation', 'violation', 'unknown'],
    candidate: ['violation', 'violation', 'safe', 'safe', 'violation', 'unknown', 'violation', 'violation', 'unknown', 'violation'],
  } as const;
  const runs: EvaluationRuns = { schemaVersion: 1, kind: 'paired-review-evaluation-runs', id: 'authored-runs', version: 'v1', datasetDigest, baselineArmId: 'baseline',
    arms: (['baseline', 'candidate'] as const).map(id => {
      const structural = buildSemanticReview({ rule: storedRule, snapshot: first });
      const evidence = makeReviewEvidence(first, makeSnapshotAnchor(first, 'after', path, 0, after.length), 'synthetic-oracle-context');
      const fixtures: AnchorReviewFixture = { schemaVersion: 2, kind: 'semantic-review-offline-fixtures', ruleDigest: storedRule.digest, snapshotDigest: first.digest, evidence: [evidence],
        judgments: [{ targetId: structural.coverage.targets[0].id, decision: 'unknown', reasoning: 'Unknown whole target; local anchors have independent authored states', evidenceRefs: [evidence.id], missingContext: [],
          anchorJudgments: ['badA', 'badARepeat', 'legal', 'lost', 'gained', 'unresolved', 'uncertain', 'excluded', 'extra', 'disputed'].map((name, index) => ({ anchor: anchor(name), decision: statuses[id][index], reasoning: 'Authored prediction; no model run', evidenceRefs: [evidence.id], missingContext: [] })) }] };
      const review = buildSemanticReview({ rule: storedRule, snapshot: first, fixtures, attempt: `authored-${id}` });
      const arm: EvaluationArm = { id, description: `Authored ${id} predictions for a counting oracle`, policy: { id: `authored-${id}`, version: 'v1', digest: digestOf(statuses[id]) },
        conditions: { model: { provider: 'none', name: 'none', version: 'not-run', configurationDigest: digestOf('no model'), execution: 'authored-fixture', attestation: 'locally-declared-unverified' },
          information: { manifestDigest: datasetDigest, access: 'changed-files', toolsDigest: digestOf([]), retrievalDigest: digestOf([]), historyPolicy: 'synthetic-only' },
          budget: { manifestDigest: digestOf('zero-model synthetic budget'), accounting: 'construction-maintenance-and-review', maxModelCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxWallTimeMs: 0, currency: 'USD', maxCostMicros: 0 } },
        totalUsage: null,
        units: [{ prId: 'pr-1', familyId: 'call-family', state: 'completed', reason: 'Frozen authored fixture review', rule: storedRule, review: { digest: digestOf(review), value: review } },
          { prId: 'pr-2', familyId: 'call-family', state: id === 'baseline' ? 'not-run' : 'failed', reason: 'Deliberately authored incomplete execution state; no model execution attempted', rule: storedRule, review: null }] };
      return arm;
    }) };
  return { dataset, annotations, runs };
}
export async function writePairedEvaluationDemo(directory: string) {
  const inputs = createPairedEvaluationDemo(), report = evaluatePairedReviews(inputs.dataset, inputs.annotations, inputs.runs);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const [name, value] of Object.entries({ ...inputs, report })) await writeEvaluationJson(join(directory, `${name}.json`), value);
  return { mode: 'authored-synthetic-no-model-no-human-annotation', directory, reportId: report.id, files: ['dataset.json', 'annotations.json', 'runs.json', 'report.json'], counts: report.arms.map(a => ({ id: a.id, counts: a.counts })), comparisons: report.comparisons };
}

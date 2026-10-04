import { createPairedEvaluationDemo } from '../../src/paired-evaluation-demo.js';
import { digestOf } from '../../src/core/identity.js';
import type { AnnotationPlan, Assignment } from './contracts.js';
/** Authored development inputs only. No human, empirical or historical labels. */
export function createAnnotationFixture() {
  const demo = createPairedEvaluationDemo(), timestamp = new Date(Date.now() - 1000).toISOString();
  const text = 'Authored fixture rubric: assess the fixed call spans using only the shown source. Positive means the frozen constraint is violated, negative requires assessed applicability and support, unknown means insufficient evidence, excluded means outside the frozen scope. Missing work must stay unassessed. This fixture tests bookkeeping only.';
  const dataset = structuredClone(demo.dataset);
  dataset.families.forEach(f => { f.definitionDigest = digestOf(text); });
  dataset.temporal.annotationObservationCutoff = timestamp;
  const selected = [...demo.annotations.instances.slice(0, 3), demo.annotations.instances.at(-1)!];
  const plan: AnnotationPlan = { schemaVersion: 1, kind: 'blinded-development-annotation-plan', origin: 'authored-fixture',
    dataset, frozenAt: timestamp, observationCutoff: timestamp,
    sourceBindings: dataset.prs.map(p => ({ prId: p.id, snapshotDigest: p.snapshot.digest, capturedAt: timestamp,
      captureEvidenceDigest: digestOf(['authored-capture', p.snapshot.digest]), historicalVisibility: 'not-established' })),
    rubrics: dataset.families.map(f => ({ familyId: f.id, text, definitionDigest: digestOf(text), scope: 'predefined-after-side-opportunities-only' })),
    opportunities: selected.map(({ id, prId, familyId, issueId, lineageId, anchors }) => ({ id, prId, familyId, issueId, lineageId, anchors })),
    sourceOnlyAudit: { evidenceDigest: digestOf('authored audit declaration, not human audit'), reviewerId: 'fixture-protocol-auditor',
      rubricAndScopeIndependentOfOutputs: true, noOutcomeMaterialInAllowedSources: true } };
  const rater = (id: string) => ({ id, expertise: 'Authored test identity; no real person', priorExposure: 'Synthetic fixture coauthored for tests',
    conflictDisclosure: 'Not an independent human judgment', noOutcomeOrArmExposureDeclared: true as const,
    notRuleOrSourceAuthorDeclared: true as const, independentWorkDeclared: true as const });
  const assignment: Assignment = { kind: 'independent-annotation-assignment', origin: 'authored-fixture',
    raters: [rater('fixture-rater-a'), rater('fixture-rater-b')],
    adjudicator: { id: 'fixture-adjudicator', expertise: 'Authored test identity', priorExposure: 'Synthetic fixture',
      conflictDisclosure: 'Not human adjudication', noOutcomeOrArmExposureDeclared: true, notRuleOrSourceAuthorDeclared: true } };
  return { plan, assignment };
}

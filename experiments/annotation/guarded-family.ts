import { z } from 'zod';
import { digestOf, ruleVersionDigest } from '../../src/core/identity.js';
import { DigestSchema } from '../../src/core/model.js';
import { SemanticRuleVersionSchema, matchesRuleScope } from '../../src/core/semantic-rule.js';
import { validateEvaluationAnnotations } from '../../src/paired-evaluation.js';
import { validatePlan } from './workflow.js';
import { TargetInputSchema } from '../matched-revision/contracts.js';

export const GUARDED_FAMILY_VERSION = 'authored-guarded-operation-measurement-v1' as const;
export const GUARDED_BASE_RULE_DIGEST = 'ea2166babb24b9230b675427c2f9f7cd1bb3327d8e4ebe7510d1841087306717';
const semantics = { title: 'Guarded operations', mechanism: 'Missing applicable guard',
  invariant: 'An applicable guard protects a danger call', applicability: ['Danger calls'],
  exceptions: [], requiredContext: [], expectedBehavior: 'Identify unguarded calls' };
export const GUARDED_RUBRIC = `Development fixture only: one opportunity is one frozen after-snapshot, family, danger-operation issue and exact code span. Multiple citations do not create extra observations. The invariant is that an applicable guard protects the dangerous operation on every feasible path, on the same value and before the operation, without invalidation. Establish the guard and operation contracts, value identity and relevant control flow from the common allowed packet. Positive requires a supported feasible unguarded operation. Negative requires supported applicability and protection, or separately supported non-applicability; these are not interchangeable H2 subclasses. Unknown means an assessor inspected the opportunity but cannot establish a premise or decisive context. Missing work has no label. A guard token alone, absence of an alert, tool success, a version bump or a later repair proves none of these. Two independent declared raters lock complete opportunity rosters before a distinct adjudicator accepts a source-supported judgment or retains Unknown/disputed; never force consensus. TP/FP additionally require an actual source-bound finding under the frozen rule; source labels alone are not feedback. No HTTPX rule, human participation, historical feedback or H2 eligibility is asserted.`;
export const GuardedFamilySchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('guarded-operation-development-measurement'),
  version: z.literal(GUARDED_FAMILY_VERSION), origin: z.literal('authored-fixture'),
  familyId: z.literal('fixture-family'), rule: SemanticRuleVersionSchema, ruleDigest: z.literal(GUARDED_BASE_RULE_DIGEST),
  rubric: z.literal(GUARDED_RUBRIC), rubricDigest: DigestSchema, planDigest: DigestSchema,
  admission: z.literal('authored-development-only-not-httpx-or-h2'),
  temporalBasis: z.literal('current-capture-declarations-not-historical-proof'),
}).strict();
export function validateGuardedFamily(raw: unknown, planInput: unknown) {
  const spec = GuardedFamilySchema.parse(raw), plan = validatePlan(planInput);
  if (plan.origin !== 'authored-fixture' || plan.dataset.sampling.kind !== 'synthetic'
    || spec.planDigest !== digestOf(plan) || spec.ruleDigest !== ruleVersionDigest(spec.rule)
    || spec.rubricDigest !== digestOf(GUARDED_RUBRIC)
    || digestOf(spec.rule.semantics) !== digestOf(semantics)) throw new Error('Guarded-family rule/plan binding mismatch');
  const family = plan.dataset.families.find(f => f.id === spec.familyId);
  if (plan.dataset.families.length !== 1 || !family || family.ruleIds.length !== 1 || family.ruleIds[0] !== spec.rule.ruleId
    || family.definitionDigest !== spec.rubricDigest || plan.rubrics[0].text !== spec.rubric) throw new Error('Exact single-family/rubric binding required');
  for (const opportunity of plan.opportunities) {
    const pr = plan.dataset.prs.find(p => p.id === opportunity.prId)!;
    if (opportunity.familyId !== spec.familyId || opportunity.anchors.some(a => !matchesRuleScope(spec.rule.scope, pr.repository, a.path))) throw new Error('Opportunity outside frozen rule scope');
  }
  return { spec, plan };
}
/** Audit a prospective label route, never fabricate a FrozenFuture from lossy
 * annotations. Inputs contain no evaluated arm output or feedback assertion. */
export function inspectGuardedLabelRoute(specInput: unknown, planInput: unknown, annotationInput: unknown, targetsInput: unknown) {
  const { spec, plan } = validateGuardedFamily(specInput, planInput);
  const { annotations } = validateEvaluationAnnotations(plan.dataset, annotationInput);
  if (annotations.rubricDigest !== digestOf(plan.rubrics)) throw new Error('Annotation rubric is not the frozen family rubric');
  const targets = z.array(TargetInputSchema).max(100).parse(targetsInput);
  if (new Set(targets.map(t => t.id)).size !== targets.length || targets.length !== plan.opportunities.length) throw new Error('Complete unique target roster required');
  if (annotations.instances.some(i => !plan.opportunities.some(o => o.id === i.id && o.prId === i.prId && o.familyId === i.familyId
    && o.issueId === i.issueId && o.lineageId === i.lineageId && digestOf(o.anchors) === digestOf(i.anchors)))) throw new Error('Annotation changes the frozen opportunity identity');
  const rows = plan.opportunities.map(opportunity => {
    const target = targets.find(t => t.id === opportunity.id);
    if (!target) throw new Error('Missing planned target identity');
    const pr = plan.dataset.prs.find(p => p.id === opportunity.prId)!;
    const instance = annotations.instances.find(i => i.id === opportunity.id);
    const coverage = annotations.coverage.find(c => c.prId === opportunity.prId && c.familyId === opportunity.familyId)!;
    if (target.prId !== pr.id || target.familyId !== spec.familyId || target.lineageId !== opportunity.lineageId
      || target.sourceSnapshotDigest !== pr.snapshot.digest) throw new Error('Matched target/source identity mismatch');
    const side = pr.snapshot.snapshot.changes.map(c => c.after).find(s => s.state === 'captured' && s.path === target.path);
    if (!side || side.state !== 'captured' || side.sha256 !== target.sourceDigest
      || Buffer.from(side.bytesBase64, 'base64').toString('utf8') !== target.source
      || target.issueScope.end > target.source.length) throw new Error('Matched source bytes mismatch');
    const reasons: string[] = [];
    if (opportunity.anchors.length !== 1) reasons.push('multiple-anchors-cannot-be-truncated-to-one-target');
    else {
      const anchor = opportunity.anchors[0];
      if (anchor.path !== target.path || anchor.sourceDigest !== target.sourceDigest
        || anchor.span.start.offset !== target.issueScope.start || anchor.span.end.offset !== target.issueScope.end) throw new Error('Matched target/anchor mismatch');
    }
    let proposedLabel: 'violation' | 'unknown' | 'disputed' | null = null;
    if (!instance) reasons.push('missing-assessment-not-an-unknown-label');
    else if (instance.label === 'positive') proposedLabel = 'violation';
    else if (instance.label === 'unknown' || instance.label === 'disputed') proposedLabel = instance.label;
    else if (instance.label === 'negative') reasons.push('negative-needs-independent-legal-neighbor-vs-safe-applicable-judgment');
    else reasons.push('excluded-not-representable-as-a-scored-future-label');
    if (opportunity.anchors.length !== 1) proposedLabel = null;
    if (target.missingEvidence.length) {
      reasons.push('matched-target-declares-missing-context'); proposedLabel = null;
    }
    // Even Unknown/disputed retain unknown mechanism membership rather than
    // encoding a guessed false boolean in the existing FutureCase schema.
    reasons.push('separate-locked-mechanism-membership-and-reference-adjudication-required');
    return { opportunityId: opportunity.id, coverage: coverage.state, sourceLabel: instance?.label ?? null,
      proposedLabel, repeatedFeedbackMechanism: null, state: 'blocked', reasons };
  });
  const body = { schemaVersion: 1, kind: 'guarded-family-label-route-audit', version: GUARDED_FAMILY_VERSION,
    specDigest: digestOf(spec), planDigest: digestOf(plan), annotationsDigest: digestOf(annotations), targetInputsDigest: digestOf(targets),
    origin: 'authored-fixture', empiricalAdmission: 'blocked', matchedFuture: null, rows,
    contractBoundary: 'No FrozenFuture or MatchedEvaluationContract created; no partial roster enters the matched runner',
    requiredNextLocks: ['actual frozen-rule W1 finding before independently judged TP/FP',
      'independent W2 positive and legal-neighbor lineages with full source/context admission',
      'negative subtype and L_mech membership independently adjudicated before arm outputs',
      'two original submissions plus distinct adjudication and actual exposure chronology'],
    modelCalls: 0, independentHumanLabels: 0 };
  return { ...body, digest: digestOf(body) };
}

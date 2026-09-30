import { digestOf } from './identity.js';
import { ProblemCaseSchema, FindingSchema, FeedbackSchema, PromotionPolicySchema, type Feedback, type Finding, type ProblemCase, type PromotionPolicy, type Verdict } from './model.js';

/** Ground truth is independent of execution and model decisions. Disagreement never silently wins by timestamp. */
export function deriveVerdict(feedback: readonly Feedback[]): Verdict {
  const labels = feedback.map(value => FeedbackSchema.parse(value)).filter(value => value.kind === 'label' && value.source === 'human').map(value => value.label!);
  if (labels.length === 0) return 'Unknown';
  const known = new Set(labels.filter(value => value !== 'Unknown'));
  if (known.has('Disputed') || (known.has('TP') && known.has('FP'))) return 'Disputed';
  if (labels.includes('Unknown')) return 'Unknown';
  return known.has('TP') ? 'TP' : known.has('FP') ? 'FP' : 'Unknown';
}

export type EvaluationEvidence = { problemCase: ProblemCase; finding: Finding; feedback: Feedback[] };
export type EvaluationMetrics = {
  totalCases: number; knownCases: number; unknownLabelCases: number;
  positiveCases: number; negativeCases: number; recalledCases: number; adjudicatedCases: number;
  truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number;
  alertDenominator: number; positiveDenominator: number;
  abstentions: number; notVerified: number; executionErrors: number; feedbackLabeledCases: number;
  precision: number | null; recall: number | null; abstentionRate: number;
};
export type EvaluationReport = {
  eligible: boolean;
  reasons: string[];
  metrics: EvaluationMetrics;
  evidenceDigest: string;
  evidenceKind: 'synthetic_only' | 'mixed_synthetic' | 'reviewed_cases';
};

/** Explicit denominators include known positives that were missed, not verified, or abstained. */
export function evaluateEvidence(evidence: readonly EvaluationEvidence[], policyInput: PromotionPolicy): EvaluationReport {
  const policy = PromotionPolicySchema.parse(policyInput);
  for (const item of evidence) {
    ProblemCaseSchema.parse(item.problemCase);
    FindingSchema.parse(item.finding);
  }
  const metrics: EvaluationMetrics = {
    totalCases: evidence.length, knownCases: 0, unknownLabelCases: 0, positiveCases: 0, negativeCases: 0,
    recalledCases: 0, adjudicatedCases: 0, truePositives: 0, falsePositives: 0, trueNegatives: 0,
    falseNegatives: 0, alertDenominator: 0, positiveDenominator: 0, abstentions: 0, notVerified: 0,
    executionErrors: 0, feedbackLabeledCases: 0, precision: null, recall: null, abstentionRate: 0,
  };
  const reasons = new Set<string>();
  const seen = new Set<string>();
  const seenSources = new Set<string>();
  for (const { problemCase, finding, feedback } of evidence) {
    if (seen.has(problemCase.id)) reasons.add('Duplicate case in evaluation');
    seen.add(problemCase.id);
    if (seenSources.has(problemCase.sourceDigest)) reasons.add('Duplicate source content cannot inflate evaluation denominators');
    seenSources.add(problemCase.sourceDigest);
    if (problemCase.split !== 'holdout') reasons.add('Only heldout cases may certify promotion');
    if (problemCase.provenance.kind === 'synthetic') reasons.add('Synthetic cases cannot certify production promotion');
    if (finding.adjudication?.source === 'fixture') reasons.add('Offline fixture adjudication cannot certify production promotion');
    if (finding.execution.state === 'failed') metrics.executionErrors++;
    if (!['not_recalled', 'execution_error'].includes(finding.candidateState)) metrics.recalledCases++;
    if (['passed', 'rejected', 'abstained'].includes(finding.candidateState)) metrics.adjudicatedCases++;
    if (finding.candidateState === 'abstained') metrics.abstentions++;
    if (finding.candidateState === 'not_verified') metrics.notVerified++;
    const groundTruth = deriveVerdict(feedback);
    if (groundTruth === 'Disputed') reasons.add('Disputed feedback requires human resolution before promotion');
    if (groundTruth === 'TP' || groundTruth === 'FP') metrics.feedbackLabeledCases++;
    if (feedback.some(f => f.kind === 'label' && f.label === 'Unknown')) reasons.add('Explicit unknown feedback prevents promotion');
    const known = problemCase.expected !== 'unknown' && problemCase.provenance.reviewedBy !== null;
    if (!known) { metrics.unknownLabelCases++; continue; }
    metrics.knownCases++;
    const positive = problemCase.expected === 'violation';
    const alert = finding.candidateState === 'passed';
    if (positive) {
      metrics.positiveCases++;
      if (alert) metrics.truePositives++; else metrics.falseNegatives++;
    } else {
      metrics.negativeCases++;
      if (alert) metrics.falsePositives++;
      else if (['rejected', 'not_recalled'].includes(finding.candidateState)) metrics.trueNegatives++;
    }
    // Human disagreement with the frozen case or adjudication invalidates certification, not the audit trail.
    if ((groundTruth === 'FP' && positive) || (groundTruth === 'TP' && !positive)) reasons.add('Human finding feedback conflicts with the frozen case label');
  }
  metrics.alertDenominator = metrics.truePositives + metrics.falsePositives;
  metrics.positiveDenominator = metrics.positiveCases;
  metrics.precision = metrics.alertDenominator ? metrics.truePositives / metrics.alertDenominator : null;
  metrics.recall = metrics.positiveDenominator ? metrics.truePositives / metrics.positiveDenominator : null;
  metrics.abstentionRate = evidence.length ? (metrics.abstentions + metrics.notVerified) / evidence.length : 0;
  if (metrics.knownCases < policy.minKnownCases) reasons.add('Insufficient known labeled cases');
  if (metrics.unknownLabelCases > 0) reasons.add('Unknown or unreviewed case labels cannot certify promotion');
  if (metrics.positiveCases < policy.minPositiveCases) reasons.add('Insufficient positive cases');
  if (metrics.negativeCases < policy.minNegativeCases) reasons.add('Insufficient negative cases');
  if (metrics.precision === null || metrics.precision < policy.minPrecision) reasons.add('Precision threshold not met');
  if (metrics.recall === null || metrics.recall < policy.minRecall) reasons.add('Recall threshold not met');
  if (metrics.abstentionRate > policy.maxAbstentionRate) reasons.add('Abstention threshold not met');
  if (metrics.executionErrors > 0) reasons.add('Execution errors prevent promotion');
  if (metrics.feedbackLabeledCases < policy.minFeedbackLabels) reasons.add('Insufficient explicit human finding labels');
  const normalized = [...evidence].sort((a, b) => a.problemCase.id.localeCompare(b.problemCase.id)).map(item => ({
    ...item, feedback: [...item.feedback].sort((a, b) => a.id.localeCompare(b.id)),
  }));
  return {
    eligible: reasons.size === 0, reasons: [...reasons], metrics,
    evidenceDigest: digestOf(normalized),
    evidenceKind: evidence.every(item => item.problemCase.provenance.kind === 'synthetic') ? 'synthetic_only' : evidence.some(item => item.problemCase.provenance.kind === 'synthetic') ? 'mixed_synthetic' : 'reviewed_cases',
  };
}

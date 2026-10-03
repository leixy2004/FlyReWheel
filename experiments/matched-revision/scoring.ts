import { ReviewSchema, type FutureCase, type GateCase, type Observation, type TargetInput } from './contracts.js';

/** Fixture citation binding only: this is not independent semantic evidence assessment. */
export function observations(targets: TargetInput[], raw: unknown, failure: string | null): Observation[] {
  if (failure) return targets.map(t => ({ targetId: t.id, prediction: 'unresolved', reason: failure, evidenceSupport: 'not_assessable', judgment: null }));
  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) return observations(targets, null, 'invalid_output');
  const ids = parsed.data.judgments.map(j => j.targetId);
  if (new Set(ids).size !== ids.length || ids.some(id => !targets.some(t => t.id === id))) return observations(targets, null, 'invalid_output');
  return targets.map(target => {
    const judgment = parsed.data.judgments.find(j => j.targetId === target.id);
    if (!judgment) return { targetId: target.id, prediction: 'unresolved', reason: 'missing_output', evidenceSupport: 'not_assessable', judgment: null };
    const bound = judgment.evidenceRefs.length > 0 && judgment.evidenceRefs.every(ref => target.evidence.some(e => e.id === ref));
    const supported = bound && !judgment.missingEvidence.length && !target.missingEvidence.length && judgment.reason === 'judgment';
    return { targetId: target.id, prediction: judgment.prediction, reason: judgment.reason,
      evidenceSupport: supported ? 'fixture-bound' : 'unsupported', judgment };
  });
}
export function evaluateGate(cases: GateCase[], predictions: Observation[]) {
  const obligations = cases.map(c => {
    const prediction = predictions.find(p => p.targetId === c.input.id);
    const passed = prediction?.evidenceSupport === 'fixture-bound' && prediction.prediction === c.expected;
    return { targetId: c.input.id, expected: c.expected, role: c.role, passed,
      reason: passed ? 'expected_fixture_bound_judgment' : prediction?.prediction === 'unresolved'
        || prediction?.evidenceSupport !== 'fixture-bound' ? 'inconclusive' : c.role === 'old_positive' ? 'regressed' : 'still_failing' };
  });
  return { passed: obligations.every(o => o.passed), obligations };
}
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator,
  state: denominator ? 'estimable' as const : 'not_estimable' as const, value: denominator ? numerator / denominator : null });
export function scoreFuture(cases: FutureCase[], predictions: Observation[]) {
  const rows = cases.map(c => {
    const p = predictions.find(p => p.targetId === c.input.id);
    const supported = p?.evidenceSupport === 'fixture-bound';
    return { targetId: c.input.id, prId: c.input.prId, familyId: c.input.familyId, lineageId: c.input.lineageId, label: c.label,
      prediction: p?.prediction ?? 'unresolved', reason: p?.reason ?? 'missing_output',
      evidenceSupport: p?.evidenceSupport ?? 'not_assessable', repeatedFeedbackMechanism: c.repeatedFeedbackMechanism,
      detected: supported && p?.prediction === 'violation',
      legalResolved: supported && (p?.prediction === 'safe' || p?.prediction === 'not_applicable'),
      safeResolved: supported && p?.prediction === 'safe',
      determinate: supported && p?.prediction !== 'unresolved' };
  });
  const positives = rows.filter(r => r.label === 'violation'), legal = rows.filter(r => r.label === 'legal_neighbor'),
    safe = rows.filter(r => r.label === 'safe_applicable'), repeated = legal.filter(r => r.repeatedFeedbackMechanism);
  const positiveRecall = ratio(positives.filter(r => r.detected).length, positives.length);
  const strictLegalResolution = ratio(legal.filter(r => r.legalResolved).length, legal.length);
  return { scheduledTargets: cases.length, rows, positiveRecall,
    effectivePositiveMissRate: ratio(positives.filter(r => !r.detected).length, positives.length),
    falseSafePositiveMisses: positives.filter(r => r.prediction === 'safe' || r.prediction === 'not_applicable').length,
    unresolvedPositiveMisses: positives.filter(r => !r.detected && r.prediction !== 'safe' && r.prediction !== 'not_applicable').length,
    // An unsupported alert still burdens a negative; it gets no positive recall credit.
    legalFalseAlarmRate: ratio(legal.filter(r => r.prediction === 'violation').length, legal.length), strictLegalResolution,
    safeApplicableResolution: ratio(safe.filter(r => r.safeResolved).length, safe.length),
    repeatedFeedbackFalseAlarmRate: ratio(repeated.filter(r => r.prediction === 'violation').length, repeated.length),
    strictBalancedResolution: positiveRecall.value === null || strictLegalResolution.value === null ? null
      : (positiveRecall.value + strictLegalResolution.value) / 2,
    validJudgmentCoverage: ratio(rows.filter(r => r.determinate).length, rows.length),
    scopeLoss: ratio(rows.filter(r => r.reason === 'scope_excluded').length, rows.length),
    unsupportedNotApplicable: rows.filter(r => r.prediction === 'not_applicable' && r.evidenceSupport !== 'fixture-bound').length,
    unresolvedReferences: rows.filter(r => r.label === 'unknown' || r.label === 'disputed'),
    uncertaintyBounds: 'not_computed_no_frozen_feasible_label_constraints' as const };
}

import { open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { digestOf, ruleVersionDigest } from './core/identity.js';
import { validateSnapshotAnchor } from './adapters/semantic-review-fixture.js';
import { validateSemanticReview } from './semantic-review.js';
import { type SemanticReview, type ReviewFinding } from './core/semantic-review.js';
import {
  EvaluationDatasetSchema, EvaluationAnnotationSchema, EvaluationRunsSchema,
  PAIRED_EVALUATION_LIMITS as LIMITS, PAIRED_EVALUATION_VERSION, CONTEXT_PAIRED_EVALUATION_VERSION, emptyEvaluationCounts,
  type EvaluationDataset, type EvaluationAnnotations, type EvaluationRuns, type EvaluationArm, type EvaluationCounts,
} from './core/paired-evaluation.js';

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const key = (prId: string, familyId: string) => JSON.stringify([prId, familyId]);
const receiptHistoryPolicy = (receipt: NonNullable<SemanticReview['executionReceipt']>) =>
  receipt.context.evaluation === undefined ? 'all-local-refs-v1' : 'exact-allowed-head-closure-v1';
function unique(values: readonly string[], description: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${description}`);
}
function bounded(value: unknown, limit: number, name: string) {
  // Includes a canonical JSON check so undefined/non-finite/prototype surprises never acquire identities.
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? '');
  if (bytes > limit) throw new Error(`${name} exceeds ${limit} bytes`);
  digestOf(value);
}
export async function readEvaluationJson(path: string, maxBytes: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Evaluation input must be a regular file');
    if (info.size > maxBytes) throw new Error(`Evaluation input exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new Error(`Evaluation input exceeds ${maxBytes} bytes`);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await file.close(); }
}
export async function writeEvaluationJson(path: string, value: unknown) {
  bounded(value, LIMITS.reportBytes, 'Evaluation output');
  // Refuse replacement: changed labels, configuration or inputs need a new artifact path and digest.
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > LIMITS.reportBytes) throw new Error('Formatted evaluation output exceeds byte limit');
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
}
function explicitAnchor(review: SemanticReview, finding: ReviewFinding): boolean {
  const judgments = review.fixtures?.judgments ?? review.executionReceipt?.workerResult.value.judgments ?? [];
  const judgment = judgments.find(j => j.targetId === finding.targetId);
  if (!judgment) return false;
  return 'anchorJudgments' in judgment
    ? judgment.anchorJudgments.some(a => digestOf(a.anchor) === digestOf(finding.anchor))
    : judgment.findingAnchors.some(a => digestOf(a) === digestOf(finding.anchor));
}
function validate(dataset: EvaluationDataset, annotations: EvaluationAnnotations, runs: EvaluationRuns) {
  const datasetDigest = digestOf(dataset);
  if (annotations.datasetDigest !== datasetDigest || runs.datasetDigest !== datasetDigest) throw new Error('Dataset digest mismatch');
  unique(dataset.prs.map(p => p.id), 'PR ID'); unique(dataset.families.map(f => f.id), 'family ID');
  unique(dataset.families.flatMap(f => f.ruleIds), 'rule ID across frozen families');
  unique(dataset.prs.map(p => JSON.stringify([p.repository, p.number])), 'PR alias; only one checkpoint per sampled PR is supported');
  unique(annotations.instances.map(i => i.id), 'annotation instance ID');
  unique(annotations.instances.map(i => JSON.stringify([i.prId, i.familyId, i.issueId])), 'issue instance');
  unique(annotations.instances.map(i => JSON.stringify([i.prId, i.familyId, i.lineageId])), 'same-PR issue lineage');
  unique(annotations.provenance.authors, 'annotation author');
  if (annotations.provenance.origin === 'adjudicated' && (annotations.provenance.authors.length < 2 || !annotations.provenance.evidenceDigests.length)) {
    throw new Error('Adjudicated origin requires at least two declared authors and supporting evidence digests; identity remains unverified');
  }
  if (dataset.sampling.kind === 'probability-declared' && (!dataset.sampling.frameDigest || dataset.prs.some(p => p.inclusionProbability === null))) {
    throw new Error('Probability sampling declaration requires a frame digest and all inclusion probabilities');
  }
  if (dataset.sampling.kind === 'synthetic' && (dataset.prs.some(p => p.split !== 'synthetic') || annotations.provenance.origin !== 'synthetic')) {
    throw new Error('Synthetic sampling requires synthetic PRs and synthetic annotation origin');
  }
  const { temporal } = dataset;
  if (temporal.targetWindowStart && temporal.targetWindowEnd && Date.parse(temporal.targetWindowStart) >= Date.parse(temporal.targetWindowEnd)) throw new Error('Invalid target time window');
  const units = new Set(dataset.prs.flatMap(pr => dataset.families.map(f => key(pr.id, f.id))));
  const checkUnit = (prId: string, familyId: string) => {
    if (!units.has(key(prId, familyId))) throw new Error('Orphan PR/family unit outside the dataset roster');
  };
  for (const pr of dataset.prs) {
    if (pr.repository !== pr.snapshot.snapshot.repository.id) throw new Error('PR repository does not match snapshot');
    const metadata = pr.snapshot.snapshot.prMetadata;
    if (metadata && (metadata.repository !== pr.repository || metadata.number !== pr.number)) throw new Error('PR metadata conflicts with dataset identity');
  }
  unique(annotations.coverage.map(c => key(c.prId, c.familyId)), 'annotation coverage unit');
  for (const coverage of annotations.coverage) checkUnit(coverage.prId, coverage.familyId);
  if (annotations.coverage.length !== units.size) throw new Error('Annotation coverage must explicitly include the full PR × family roster');
  const occupied = new Set<string>();
  for (const instance of annotations.instances) {
    checkUnit(instance.prId, instance.familyId);
    const coverage = annotations.coverage.find(c => key(c.prId, c.familyId) === key(instance.prId, instance.familyId))!;
    if (coverage.state === 'unassessed' || (coverage.state === 'excluded' && instance.label !== 'excluded')) throw new Error('Annotation instance contradicts unit coverage');
    const pr = dataset.prs.find(p => p.id === instance.prId)!;
    unique(instance.anchors.map(digestOf), 'annotation anchor');
    for (const anchor of instance.anchors) {
      validateSnapshotAnchor(anchor, pr.snapshot);
      const identity = JSON.stringify([instance.prId, instance.familyId, digestOf(anchor)]);
      if (occupied.has(identity)) throw new Error('Annotation anchor belongs to multiple issue instances');
      occupied.add(identity);
    }
  }
  unique(runs.arms.map(a => a.id), 'arm ID');
  if (!runs.arms.some(a => a.id === runs.baselineArmId)) throw new Error('Baseline arm is absent');
  let findings = 0;
  const logicalRules = new Map<string, string>();
  for (const arm of runs.arms) {
    unique(arm.units.map(u => key(u.prId, u.familyId)), 'arm PR/family unit');
    for (const unit of arm.units) {
      checkUnit(unit.prId, unit.familyId);
      if (!dataset.families.find(f => f.id === unit.familyId)!.ruleIds.includes(unit.rule.rule.ruleId)) throw new Error('Rule ID is outside frozen family mapping');
      if (unit.rule.digest !== ruleVersionDigest(unit.rule.rule)) throw new Error('Rule digest mismatch');
      const logicalKey = JSON.stringify([unit.rule.rule.ruleId, unit.rule.rule.version]);
      if (logicalRules.has(logicalKey) && logicalRules.get(logicalKey) !== unit.rule.digest) throw new Error('Conflicting content under one immutable rule/version identity');
      logicalRules.set(logicalKey, unit.rule.digest);
      if ((unit.state === 'completed') !== (unit.review !== null)) throw new Error('Completed unit requires a review; noncompleted units must not hide predictions in a review');
      if (!unit.review) continue;
      if (unit.review.digest !== digestOf(unit.review.value)) throw new Error('Frozen review digest mismatch');
      const pr = dataset.prs.find(p => p.id === unit.prId)!;
      const review = validateSemanticReview(unit.review.value, unit.rule, pr.snapshot);
      if (unit.repositoryContextDigests !== undefined
        && digestOf(unit.repositoryContextDigests) !== digestOf(review.config.repositoryContextDigests ?? [])) {
        throw new Error('Evaluation unit repository context selection contradicts its frozen review');
      }
      findings += review.findings.length;
      if (findings > LIMITS.totalFindings) throw new Error('Aggregate evaluation finding budget exceeded');
      const actualModel = review.executionReceipt?.modelExecution === 'completed';
      if (actualModel !== (arm.conditions.model.execution === 'declared-model')) throw new Error('Arm model execution declaration contradicts frozen review provenance');
      if (actualModel && review.executionReceipt?.model !== arm.conditions.model.name) throw new Error('Declared model name contradicts review requested model');
      if (review.executionReceipt && (arm.conditions.information.access !== review.executionReceipt.context.kind || arm.conditions.information.historyPolicy !== receiptHistoryPolicy(review.executionReceipt))) {
        throw new Error('Information access/history declaration contradicts validated workspace review receipt');
      }
    }
    const lower = receiptUsage(arm);
    if (arm.totalUsage && (arm.totalUsage.modelCalls < lower.modelCalls || arm.totalUsage.inputTokens < lower.inputTokens || arm.totalUsage.outputTokens < lower.outputTokens)) {
      throw new Error('Declared total usage is below the frozen review receipt lower bound');
    }
  }
}

function unitContextDigests(unit: EvaluationArm['units'][number] | undefined): string[] {
  return unit?.review?.value.config.repositoryContextDigests ?? unit?.repositoryContextDigests ?? [];
}
type Unit = { repositoryContextDigests?: string[]; prId: string; familyId: string; state: string; reviewDigest: string | null; counts: EvaluationCounts;
  instances: { id: string; label: string; outcome: string; alertFindingIds: string[]; otherFindingIds: string[] }[];
  predictions: { findingId: string; anchorDigest: string; status: string; explicitAnchor: boolean; instanceId: string | null }[] };
function scoreUnit(dataset: EvaluationDataset, annotations: EvaluationAnnotations, arm: EvaluationArm, prId: string, familyId: string, contextContract: boolean): Unit {
  const input = arm.units.find(u => key(u.prId, u.familyId) === key(prId, familyId));
  const review = input?.review?.value;
  const labels = annotations.instances.filter(i => i.prId === prId && i.familyId === familyId).sort((a, b) => order(a.id, b.id));
  const counts = emptyEvaluationCounts(); counts.units = 1; counts.prs = 1;
  const state = input?.state ?? 'missing';
  const stateCount = { completed: 'completedUnits', abstained: 'abstainedUnits', failed: 'failedUnits', 'not-run': 'notRunUnits', missing: 'missingRunUnits' } as const;
  counts[stateCount[state]]++;
  const coverage = annotations.coverage.find(c => c.prId === prId && c.familyId === familyId)!;
  const coverageCount = { 'complete-declared': 'annotationCompleteUnits', partial: 'annotationPartialUnits', unassessed: 'annotationUnassessedUnits', excluded: 'annotationExcludedUnits' } as const;
  counts[coverageCount[coverage.state]]++;
  const anchorLabels = new Map(labels.flatMap(label => label.anchors.map(anchor => [digestOf(anchor), label] as const)));
  const predictions = (review?.findings ?? []).map(finding => {
    const anchorDigest = digestOf(finding.anchor), label = anchorLabels.get(anchorDigest);
    if (!label) counts.unmatchedPredictionAnchors++;
    if (finding.status === 'violation') {
      counts.uniqueAlerts++;
      if (!label) counts.unmatchedAlertAnchors++;
      else if (label.label === 'positive') counts.usefulAlertAnchors++;
      else if (label.label === 'negative') counts.falseAlertAnchors++;
      else if (label.label === 'unknown') counts.unknownLabelAlertAnchors++;
      else if (label.label === 'disputed') counts.disputedLabelAlertAnchors++;
      else counts.excludedLabelAlertAnchors++;
    } else if (finding.status === 'unknown') counts.abstentionAnchors++;
    else if (finding.status === 'not_verified') counts.notVerifiedAnchors++;
    else counts.safePredictionAnchors++;
    return { findingId: finding.id, anchorDigest, status: finding.status, explicitAnchor: explicitAnchor(review!, finding), instanceId: label?.id ?? null };
  }).sort((a, b) => order(a.findingId, b.findingId));
  const instances = labels.map(label => {
    const matched = predictions.filter(p => p.instanceId === label.id);
    const alerts = matched.filter(p => p.status === 'violation');
    const unknown = matched.some(p => p.status === 'unknown' || p.status === 'not_verified');
    if (!matched.length) counts.instancesWithNoExactPrediction++;
    if (unknown) counts.instancesWithUnknownPrediction++;
    // A whole-issue safe outcome requires explicit safety at every annotated anchor.
    const explicitSafe = label.anchors.every(a => matched.some(p => p.anchorDigest === digestOf(a) && p.status === 'safe' && p.explicitAnchor));
    if (explicitSafe) counts.explicitSafeInstances++;
    let outcome: string = label.label;
    if (label.label === 'positive') {
      counts.positiveInstances++;
      if (alerts.length) { counts.usefulInstances++; counts.redundantPositiveAlertAnchors += alerts.length - 1; outcome = 'detected'; }
      else { counts.missedPositiveInstances++; outcome = 'missed'; }
    } else if (label.label === 'negative') {
      counts.negativeInstances++;
      if (alerts.length) { counts.falseAlertInstances++; outcome = 'false-alert'; }
      else { counts.knownNegativeWithoutAlertInstances++; outcome = 'no-alert-not-proof-of-safety'; }
    } else if (label.label === 'unknown') counts.unknownInstances++;
    else if (label.label === 'disputed') counts.disputedInstances++;
    else counts.excludedInstances++;
    return { id: label.id, label: label.label, outcome, alertFindingIds: alerts.map(a => a.findingId), otherFindingIds: matched.filter(p => p.status !== 'violation').map(p => p.findingId) };
  });
  for (const target of review?.coverage.targets ?? []) {
    const dispositionCount = { captured: 'capturedTargets', excluded: 'excludedTargets', deleted: 'deletedTargets', out_of_scope: 'outOfScopeTargets', unsupported_scope: 'unsupportedTargets' } as const;
    counts[dispositionCount[target.disposition]]++;
    if (target.semantic.state === 'unknown') counts.unknownTargets++;
    else if (target.semantic.state === 'not_run') counts.notRunTargets++;
    else counts.knownTargets++;
    if (target.scans.some(s => s.state !== 'scanned')) counts.incompleteScanTargets++;
  }
  return { prId, familyId, state, reviewDigest: input?.review?.digest ?? null,
    ...(contextContract ? { repositoryContextDigests: unitContextDigests(input) } : {}), counts, instances, predictions };
}
function sum(units: Unit[]): EvaluationCounts {
  const result = emptyEvaluationCounts();
  for (const unit of units) for (const k of Object.keys(result) as (keyof EvaluationCounts)[]) result[k] += unit.counts[k];
  result.prs = new Set(units.map(u => u.prId)).size;
  return result;
}
function receiptUsage(arm: EvaluationArm) {
  const result = { uniqueWorkspaceReceipts: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 };
  const seen = new Set<string>();
  for (const unit of arm.units) {
    const receipt = unit.review?.value.executionReceipt;
    if (!receipt || seen.has(digestOf(receipt))) continue;
    seen.add(digestOf(receipt)); result.uniqueWorkspaceReceipts++;
    if (receipt.modelExecution === 'completed') result.modelCalls++;
    result.inputTokens += receipt.workerResult.usage.input_tokens;
    result.outputTokens += receipt.workerResult.usage.output_tokens;
  }
  if (Object.values(result).some(n => !Number.isSafeInteger(n))) throw new Error('Receipt usage exceeds safe integer accounting bounds');
  return result;
}
function usageStatus(arm: EvaluationArm) {
  const usage = arm.totalUsage, budget = arm.conditions.budget, lower = receiptUsage(arm);
  const fields = { modelCalls: 'maxModelCalls', inputTokens: 'maxInputTokens', outputTokens: 'maxOutputTokens', wallTimeMs: 'maxWallTimeMs', costMicros: 'maxCostMicros' } as const;
  const lowerExceeded = (['modelCalls', 'inputTokens', 'outputTokens'] as const).filter(k => lower[k] > budget[fields[k]]);
  if (!usage) return { state: lowerExceeded.length ? 'receipt-lower-bound-over-budget' as const : 'unmeasured' as const, exceeded: lowerExceeded as string[] };
  const exceeded = (Object.keys(fields) as (keyof typeof fields)[]).filter(k => usage[k] > budget[fields[k]]);
  return { state: exceeded.length ? 'declared-over-budget' as const : 'declared-within-budget' as const, exceeded };
}

/** Pure offline rederivation. No store, scanner, model, provider, or annotation side effects. */
export function evaluatePairedReviews(datasetInput: unknown, annotationInput: unknown, runsInput: unknown) {
  bounded(datasetInput, LIMITS.datasetBytes, 'Dataset'); bounded(annotationInput, LIMITS.annotationBytes, 'Annotations'); bounded(runsInput, LIMITS.runsBytes, 'Runs');
  const dataset = EvaluationDatasetSchema.parse(datasetInput), annotations = EvaluationAnnotationSchema.parse(annotationInput), runs = EvaluationRunsSchema.parse(runsInput);
  validate(dataset, annotations, runs);
  const contextContract = runs.arms.some(arm => arm.units.some(unit => unit.repositoryContextDigests !== undefined
    || unit.review?.value.config.repositoryContextDigests !== undefined));
  const prs = [...dataset.prs].sort((a, b) => order(a.id, b.id)), families = [...dataset.families].sort((a, b) => order(a.id, b.id));
  const arms = [...runs.arms].sort((a, b) => order(a.id, b.id)).map(arm => {
    const units = prs.flatMap(pr => families.map(family => scoreUnit(dataset, annotations, arm, pr.id, family.id, contextContract)));
    return { id: arm.id, description: arm.description, policy: arm.policy, conditions: arm.conditions,
      rules: [...arm.units].sort((a, b) => order(key(a.prId, a.familyId), key(b.prId, b.familyId))).map(u => ({ prId: u.prId, familyId: u.familyId, ruleDigest: u.rule.digest, ruleId: u.rule.rule.ruleId, ruleVersion: u.rule.rule.version, state: u.state, reason: u.reason })),
      totalUsage: arm.totalUsage, receiptUsageLowerBound: receiptUsage(arm), budgetStatus: usageStatus(arm),
      workspaceReceiptBindings: arm.units.filter(u => u.review?.value.executionReceipt).map(u => {
        const receipt = u.review!.value.executionReceipt!;
        return { prId: u.prId, familyId: u.familyId, receiptDigest: digestOf(receipt), context: receipt.context, historyPolicy: receiptHistoryPolicy(receipt),
          model: receipt.model, modelExecution: receipt.modelExecution, usage: receipt.workerResult.usage, generationLimits: receipt.generationLimits, workspaceLimits: receipt.workspaceLimits };
      }), counts: sum(units),
      perPr: prs.map(pr => ({ prId: pr.id, counts: sum(units.filter(u => u.prId === pr.id)) })),
      perFamily: families.map(family => ({ familyId: family.id, counts: sum(units.filter(u => u.familyId === family.id)) })),
      perSplit: ['synthetic', 'development', 'holdout'].map(split => ({ split, counts: sum(units.filter(u => prs.find(p => p.id === u.prId)!.split === split)) })), units };
  });
  const baseline = arms.find(a => a.id === runs.baselineArmId)!;
  const comparisons = arms.filter(a => a.id !== baseline.id).map(arm => {
    const reasons: string[] = [];
    for (const dimension of ['model', 'information', 'budget'] as const) {
      if (digestOf(arm.conditions[dimension]) !== digestOf(baseline.conditions[dimension])) reasons.push(`Mismatched declared ${dimension}`);
    }
    if (contextContract) {
      for (const unit of arm.units) {
        const old = baseline.units.find(value => key(value.prId, value.familyId) === key(unit.prId, unit.familyId))!;
        if (digestOf(unit.repositoryContextDigests ?? []) !== digestOf(old.repositoryContextDigests ?? [])) {
          reasons.push(`Mismatched selected repository context: ${unit.prId}/${unit.familyId}`);
        }
      }
    }
    if (arm.counts.missingRunUnits || baseline.counts.missingRunUnits) reasons.push('Missing run units: no complete paired-roster comparison');
    if ([arm, baseline].some(a => a.budgetStatus.state === 'declared-over-budget' || a.budgetStatus.state === 'receipt-lower-bound-over-budget')) reasons.push('Declared aggregate usage or receipt lower bound exceeds a frozen budget');
    const deltas = emptyEvaluationCounts();
    for (const field of Object.keys(deltas) as (keyof EvaluationCounts)[]) deltas[field] = arm.counts[field] - baseline.counts[field];
    const transitions = { positivesGained: 0, positivesLost: 0, positivesRetained: 0, positivesMissedByBoth: 0,
      falseAlertInstancesRemoved: 0, falseAlertInstancesAdded: 0, falseAlertInstancesRetained: 0, negativeNoAlertBoth: 0 };
    for (const unit of arm.units) for (const instance of unit.instances) {
      const old = baseline.units.find(u => key(u.prId, u.familyId) === key(unit.prId, unit.familyId))!.instances.find(i => i.id === instance.id)!;
      const before = !!old.alertFindingIds.length, after = !!instance.alertFindingIds.length;
      if (instance.label === 'positive') transitions[before ? after ? 'positivesRetained' : 'positivesLost' : after ? 'positivesGained' : 'positivesMissedByBoth']++;
      if (instance.label === 'negative') transitions[before ? after ? 'falseAlertInstancesRetained' : 'falseAlertInstancesRemoved' : after ? 'falseAlertInstancesAdded' : 'negativeNoAlertBoth']++;
    }
    return { baselineArmId: baseline.id, candidateArmId: arm.id, status: reasons.length ? 'incomparable' : 'declaration-matched-descriptive', reasons,
      deltaDirection: 'candidate-minus-baseline', deltas: reasons.length ? null : deltas, transitions: reasons.length ? null : transitions };
  });
  const body = {
    schemaVersion: 1, kind: 'paired-review-evaluation-report', scorer: contextContract ? CONTEXT_PAIRED_EVALUATION_VERSION : PAIRED_EVALUATION_VERSION,
    inputBindings: { dataset: { id: dataset.id, version: dataset.version, digest: digestOf(dataset), protocolDigest: dataset.protocolDigest },
      annotations: { id: annotations.id, version: annotations.version, digest: digestOf(annotations), rubricDigest: annotations.rubricDigest, provenance: annotations.provenance },
      runs: { id: runs.id, version: runs.version, digest: digestOf(runs) } },
    sourceAttestation: 'package-integrity-and-local-declarations-only',
    matching: 'Exact PR/family and full snapshot/side/path/source/span identity; one issue counts once; no overlap/fuzzy matching',
    sampling: dataset.sampling, temporal: dataset.temporal, families,
    auditWarnings: [
      ...(contextContract ? ['Selected repository context is package-integrity-only; exact review head does not establish historical availability, full context or label truth'] : []),
      ...(!annotations.provenance.independentOfRuns ? ['Annotation independence from runs is not declared'] : []),
      ...(!annotations.provenance.blindedToOutputs ? ['Annotation blinding to method outputs is not declared'] : []),
      ...(annotations.provenance.origin === 'synthetic' ? ['Synthetic labels do not support efficacy claims'] : []),
      ...(dataset.temporal.historyExposure === 'all-local-refs-v1' ? ['All-local-refs history can expose future information'] : []),
      ...(dataset.temporal.visibility !== 'as-of-declared' ? ['As-of visibility is not declared'] : []),
      ...(!dataset.temporal.isolationManifestDigest ? ['No temporal isolation manifest is bound'] : []),
      ...(dataset.sampling.frameUnknownCount ? ['Sampling frame includes unplaced or unknown cases'] : []),
      ...prs.filter(pr => pr.checkpointAt === null || pr.checkpointEvidenceDigest === null).map(pr => `No complete declared review checkpoint evidence: ${pr.id}`),
      ...prs.filter(pr => pr.checkpointAt && dataset.temporal.historyCutoff && Date.parse(pr.checkpointAt) <= Date.parse(dataset.temporal.historyCutoff)).map(pr => `Checkpoint is not strictly after declared historical cutoff: ${pr.id}`),
      ...prs.filter(pr => pr.checkpointAt && ((dataset.temporal.targetWindowStart && Date.parse(pr.checkpointAt) < Date.parse(dataset.temporal.targetWindowStart)) || (dataset.temporal.targetWindowEnd && Date.parse(pr.checkpointAt) >= Date.parse(dataset.temporal.targetWindowEnd)))).map(pr => `Checkpoint outside declared target window: ${pr.id}`),
      ...arms.filter(a => a.budgetStatus.state === 'unmeasured').map(a => `Aggregate construction/maintenance/review usage is unmeasured: ${a.id}`),
    ],
    roster: prs.map(({ snapshot, ...pr }) => ({ ...pr, snapshotDigest: snapshot.digest, head: snapshot.snapshot.head, mergeBase: snapshot.snapshot.mergeBase })),
    repeatedPrLineages: [...new Set(prs.map(pr => pr.lineageId))].filter(lineage => prs.filter(pr => pr.lineageId === lineage).length > 1).sort(order),
    arms, comparisons, bounds: LIMITS,
    limitations: [
      'Descriptive counts of supplied PRs and annotation issue instances only; no population estimate, confidence interval, significance test, causal effect, promotion or activation.',
      'Fixture/demo labels and review decisions are authored structural test inputs, never evidence of model efficacy or human correctness.',
      'Imported model/version/policy, label authorship/adjudication/independence, sampling, costs and temporal isolation are unverified declarations; hashes establish integrity, not authenticity.',
      'No annotation is inferred from comments, merge, approval, resolution, silence, model judgments or absence of an alert. Annotation provenance is retained verbatim.',
      'Missed positives include safe, abstained, failed, not-run, missing or unmatched predictions. No-alert negatives are not proof of safety. Unknown, disputed, excluded and unmatched predictions are never negatives.',
      'Only exact anchors match. Alternative or shifted anchors are unmatched even if semantically related; a frozen independently reviewed anchor rubric is required.',
      'Useful instances are deduplicated within PR/family issues. Multiple false-alert anchors remain user burden; cross-PR semantic lineages and representative sampling are not inferred.',
      'Dataset PR × family roster is fixed for all arms, including zero-instance units. Missing run units block paired deltas; explicit failed/not-run units remain in all denominators.',
      'Declaration-matched comparisons establish only equality of supplied model/information/budget descriptors. Different information hidden in prompts, unequal measured costs, future refs and pretraining exposure remain possible.',
      'Current review coverage is changed entries only, with incomplete repository context and unverified introduction/notification eligibility; target safety does not imply exact-anchor safety.',
      'Synthetic, development and holdout counts are separately listed; no declared split automatically qualifies for an empirical main analysis.',
    ],
  };
  bounded(body, LIMITS.reportBytes, 'Evaluation report');
  return { id: `paired_evaluation_${digestOf(body)}`, digest: digestOf(body), ...body };
}

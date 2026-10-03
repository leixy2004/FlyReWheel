import { validateReviewRepositoryContexts, reviewRepositoryContextDigests } from './semantic-review-context.js';
import type { StoredRepositoryContext } from './repository-context.js';
import { extname } from 'node:path';
import { type SemanticRuleVersion, type StoredRuleVersion } from './core/semantic-rule.js';
import { digestOf } from './core/identity.js';
import { type StoredChangeSnapshot } from './change-snapshot.js';
import { detectAstGrep } from './adapters/ast-grep.js';
import { makeCandidate } from './adapters/candidates.js';
import { snapshotSource, validateSnapshotAnchor, validateReviewFixtures } from './adapters/semantic-review-fixture.js';
import { REVIEW_LIMITS, SemanticReviewSchema, ReviewConfigSchema, semanticReviewId, reviewFindingId, type SemanticReview, type ReviewFixture, type ReviewFinding, type ReviewOccurrence, type ReviewTarget, type ReviewConfig, type AnchorJudgment, type AnchorTargetJudgment } from './core/semantic-review.js';

import type { SemanticReviewExecutionReceipt } from './core/semantic-review-execution.js';
import { validateSemanticReviewExecution } from './semantic-review-execution.js';
type ReviewAdjudication = { evidence: ReviewFixture['evidence']; judgments: (ReviewFixture['judgments'][number] & { missingContext?: string[] })[] };

const languageAliases: Record<string, string> = { ts: 'typescript', typescript: 'typescript', js: 'javascript', javascript: 'javascript', tsx: 'tsx', jsx: 'jsx', py: 'python', python: 'python' };
const pathLanguages: Record<string, string> = { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.tsx': 'tsx', '.jsx': 'jsx', '.py': 'python' };
type DetectionAsset = NonNullable<SemanticRuleVersion['detectionAssets']>[number];
type ScanEligibility = { state: 'eligible'; detector: Extract<DetectionAsset['detector'], { kind: 'ast-grep' }> }
  | { state: 'unsupported_engine' | 'unsupported_language' | 'language_mismatch'; reason: string };
/** Deterministic eligibility only: shared by execution and reads, without parsing source or running a scanner. */
function scanEligibility(asset: DetectionAsset, path: string): ScanEligibility {
  if (asset.detector.kind !== 'ast-grep') return { state: 'unsupported_engine', reason: 'This review runtime does not execute or import Semgrep/OpenGrep assets.' };
  const language = languageAliases[asset.detector.language.toLowerCase()];
  if (!language) return { state: 'unsupported_language', reason: 'The declared scanner language is not registered.' };
  if (pathLanguages[extname(path).toLowerCase()] !== language) return { state: 'language_mismatch', reason: 'Literal filename extension does not establish this asset language; no parser was guessed.' };
  return { state: 'eligible', detector: asset.detector };
}
import { semanticReviewInputs as inputs, makeReviewTargets as makeTargets, notRun } from './semantic-review-inputs.js';
/** Per-anchor v3 does not borrow another declaration's context or coverage. */
function anchorSemantic(judgment: AnchorJudgment | AnchorTargetJudgment, rule: SemanticRuleVersion, evidence: ReviewFixture['evidence']): ReviewTarget['semantic'] & { state: AnchorJudgment['decision'] } {
  const cited = evidence.filter(item => judgment.evidenceRefs.includes(item.id));
  const missingContext = [...new Set([...rule.semantics.requiredContext.filter(kind => !cited.some(item => item.kind === kind)), ...judgment.missingContext])];
  return missingContext.length
    ? { state: 'unknown', reasoning: 'Required or reported contextual evidence is missing for this judgment. Context labels are declarations, not independently verified facts.', missingContext }
    : { state: judgment.decision, reasoning: judgment.reasoning, missingContext: [] };
}
function semanticTargets(targets: ReviewTarget[], rule: SemanticRuleVersion, fixtures: ReviewAdjudication | null): ReviewTarget[] {
  return targets.map(target => {
    const judgment = fixtures?.judgments.find(value => value.targetId === target.id);
    if (!judgment) return { ...target, semantic: notRun() };
    if ('anchorJudgments' in judgment) {
      let semantic = anchorSemantic(judgment, rule, fixtures!.evidence);
      const anchors = judgment.anchorJudgments.map(item => anchorSemantic(item, rule, fixtures!.evidence));
      if ((semantic.state === 'violation' && !anchors.some(item => item.state === 'violation'))
        || (semantic.state === 'safe' && anchors.some(item => item.state !== 'safe'))) {
        semantic = { state: 'unknown', reasoning: 'Independently missing anchor context prevents the declared target-level conclusion.',
          missingContext: [...new Set(anchors.flatMap(item => item.missingContext))] };
      }
      return { ...target, semantic };
    }
    const evidence = fixtures!.evidence.filter(item => judgment.evidenceRefs.includes(item.id));
    const requiredGaps = rule.semantics.requiredContext.filter(kind => !evidence.some(item => item.kind === kind));
    // Preserve legacy immutable fixture payloads, including repeated declarations.
    const missingContext = judgment.missingContext === undefined ? requiredGaps : [...new Set([...requiredGaps, ...judgment.missingContext])];
    return { ...target, semantic: missingContext.length
      ? { state: 'unknown', reasoning: judgment.missingContext === undefined
        ? 'Required contextual evidence is missing. Fixture context labels are declarations, not independently verified facts.'
        : 'Required or reported contextual evidence is missing. Context labels are declarations, not independently verified facts.', missingContext }
      : { state: judgment.decision, reasoning: judgment.reasoning, missingContext: [] } };
  });
}
function makeFindings(id: string, ruleDigest: string, rule: SemanticRuleVersion, snapshot: StoredChangeSnapshot, targets: ReviewTarget[], occurrences: ReviewOccurrence[], fixtures: ReviewAdjudication | null, judgmentOrigin: 'fixture' | 'model' = 'fixture'): ReviewFinding[] {
  const groups = new Map<string, { anchor: ReviewOccurrence['anchor']; targetId: string; occurrenceIds: string[] }>();
  for (const occurrence of occurrences) {
    const key = digestOf(occurrence.anchor);
    const group = groups.get(key) ?? { anchor: occurrence.anchor, targetId: occurrence.targetId, occurrenceIds: [] };
    group.occurrenceIds.push(occurrence.id); groups.set(key, group);
  }
  for (const judgment of fixtures?.judgments ?? []) {
    const target = targets.find(value => value.id === judgment.targetId)!;
    if (!('anchorJudgments' in judgment) && target.semantic.state !== 'violation' && target.semantic.state !== 'safe') continue;
    const anchors = 'anchorJudgments' in judgment ? judgment.anchorJudgments.map(item => item.anchor) : judgment.findingAnchors;
    for (const anchor of anchors) {
      const key = digestOf(anchor);
      if (!groups.has(key)) groups.set(key, { anchor, targetId: target.id, occurrenceIds: [] });
    }
  }
  return [...groups.values()].map(group => {
    const target = targets.find(value => value.id === group.targetId)!;
    const judgment = fixtures?.judgments.find(value => value.targetId === target.id);
    let status: ReviewFinding['status'] = 'not_verified', origin: ReviewFinding['origin'] = 'structural';
    let reasoning = 'Structural occurrence only; semantic correctness and introduction by this change are unverified.';
    let evidenceRefs: string[] = [];
    if (judgment && 'anchorJudgments' in judgment) {
      const selected = judgment.anchorJudgments.find(item => digestOf(item.anchor) === digestOf(group.anchor));
      if (selected) {
        const semantic = anchorSemantic(selected, rule, fixtures!.evidence);
        status = semantic.state;
        origin = semantic.missingContext.length ? 'evidence_gate' : judgmentOrigin;
        reasoning = semantic.reasoning; evidenceRefs = selected.evidenceRefs;
      }
    } else if (judgment) {
      evidenceRefs = judgment.evidenceRefs;
      if (target.semantic.missingContext.length) { status = 'unknown'; origin = 'evidence_gate'; reasoning = target.semantic.reasoning; }
      else if (judgment.decision !== 'violation' && (!judgment.findingAnchors.length || judgment.findingAnchors.some(anchor => digestOf(anchor) === digestOf(group.anchor)))) { status = judgment.decision; origin = judgmentOrigin; reasoning = judgment.reasoning; }
      else if (judgment.findingAnchors.some(anchor => digestOf(anchor) === digestOf(group.anchor))) { status = 'violation'; origin = judgmentOrigin; reasoning = judgment.reasoning; }
      // Explicit selected anchors do not adjudicate other structural matches.
      // Legacy safe/unknown judgments with no anchors retain their old aggregation.
    }
    return { id: reviewFindingId(id, group.anchor), reviewId: id, ruleDigest, snapshotDigest: snapshot.digest, ruleId: rule.ruleId, ruleVersion: rule.version,
      targetId: group.targetId, anchor: group.anchor, occurrenceIds: [...group.occurrenceIds].sort(), status, origin, reasoning, evidenceRefs,
      introduction: 'unverified' as const, notificationEligibility: 'unverified' as const };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function reviewRuntime(fixtures: ReviewFixture | null, executionReceipt?: SemanticReviewExecutionReceipt, repositoryContexts?: readonly StoredRepositoryContext[]): ReviewConfig['runtime'] {
  if (repositoryContexts !== undefined) return 'semantic-snapshot-review-v3';
  return fixtures?.schemaVersion === 2 || executionReceipt?.judgmentContract === 'per-anchor-v3'
    ? 'semantic-snapshot-review-v2' : 'semantic-snapshot-review-v1';
}
type ReviewOptions = { rule: StoredRuleVersion; snapshot: StoredChangeSnapshot; fixtures?: ReviewFixture; repositoryContexts?: StoredRepositoryContext[]; attempt?: string };
export function buildSemanticReview(options: ReviewOptions): SemanticReview { return buildReview(options); }
/** Deterministic application construction, not a persistence capability. */
export function buildExecutedSemanticReview(options: Omit<ReviewOptions, 'fixtures'> & { executionReceipt: SemanticReviewExecutionReceipt }): SemanticReview {
  return buildReview(options);
}
function buildReview(options: ReviewOptions & { executionReceipt?: SemanticReviewExecutionReceipt }): SemanticReview {
  const { rule, snapshot } = inputs(options.rule, options.snapshot);
  const repositoryContexts = options.repositoryContexts === undefined ? undefined : validateReviewRepositoryContexts(options.repositoryContexts, snapshot);
  let targets = makeTargets(rule, options.rule.digest, snapshot);
  const fixtures = options.fixtures === undefined ? null : validateReviewFixtures(options.fixtures, options.rule.digest, snapshot, targets, repositoryContexts);
  if (fixtures && options.executionReceipt) throw new Error('A workspace review cannot also carry offline fixtures');
  const adjudication = options.executionReceipt ? validateSemanticReviewExecution(options.executionReceipt, options.rule, snapshot, repositoryContexts) : fixtures;
  const judgmentOrigin = options.executionReceipt?.modelExecution === 'completed' ? 'model' as const : 'fixture' as const;
  const config: ReviewConfig = ReviewConfigSchema.parse({ runtime: reviewRuntime(fixtures, options.executionReceipt, repositoryContexts), scanner: 'ast-grep@0.45.3',
    mode: options.executionReceipt ? 'workspace_execution' : fixtures ? 'offline_fixture' : 'structural_only',
    fixtureDigest: fixtures ? digestOf(fixtures) : null, attempt: options.attempt ?? 'initial',
    ...(options.executionReceipt ? { executionDigest: digestOf(options.executionReceipt) } : {}),
    ...(repositoryContexts ? { repositoryContextDigests: reviewRepositoryContextDigests(repositoryContexts) } : {}) });
  const id = semanticReviewId(options.rule.digest, snapshot.digest, config), occurrences: ReviewOccurrence[] = [];
  let scannerCalls = 0, scannerBytes = 0;
  for (const target of targets) {
    if (target.disposition !== 'captured') continue;
    const source = snapshotSource(snapshot, 'after', target.path);
    for (const asset of rule.detectionAssets ?? []) {
      const common = { assetId: asset.id, engine: asset.detector.kind, candidateCount: null };
      const eligibility = scanEligibility(asset, target.path);
      if (eligibility.state !== 'eligible') { target.scans.push({ ...common, ...eligibility }); continue; }
      if (scannerCalls >= REVIEW_LIMITS.scannerCalls || scannerBytes + Buffer.byteLength(source) > REVIEW_LIMITS.scannerBytes || occurrences.length >= REVIEW_LIMITS.occurrences) {
        target.scans.push({ ...common, state: 'budget_exceeded', reason: 'Aggregate scanner call, byte or occurrence budget is exhausted; this asset was not covered.' }); continue;
      }
      scannerCalls++; scannerBytes += Buffer.byteLength(source);
      try {
        const candidates = detectAstGrep({ source, path: target.path, language: eligibility.detector.language, pattern: eligibility.detector.pattern,
          ruleId: rule.ruleId, ruleVersion: rule.version, bundleDigest: options.rule.digest, maxCandidates: REVIEW_LIMITS.candidatesPerScan });
        if (occurrences.length + candidates.length > REVIEW_LIMITS.occurrences) {
          target.scans.push({ ...common, state: 'budget_exceeded', reason: 'This scan exceeded the remaining occurrence budget; none of its matches were truncated into successful coverage.' }); continue;
        }
        for (const candidate of candidates) occurrences.push({ id: digestOf({ snapshotDigest: snapshot.digest, side: 'after', assetId: asset.id, candidateId: candidate.id }),
          targetId: target.id, assetId: asset.id, candidateId: candidate.id, engine: 'ast-grep', language: candidate.language,
          anchor: { snapshotDigest: snapshot.digest, side: 'after', path: target.path, sourceDigest: candidate.sourceDigest, span: candidate.span } });
        target.scans.push({ ...common, state: 'scanned', candidateCount: candidates.length, reason: null });
      } catch (error) {
        target.scans.push({ ...common, state: 'execution_error', reason: (error instanceof Error ? error.message : 'Native scanner failed').slice(0, 16_384) || 'Native scanner failed' });
      }
    }
  }
  targets = semanticTargets(targets, rule, adjudication);
  const review: SemanticReview = { schemaVersion: 1, kind: 'semantic-snapshot-review', id, ruleDigest: options.rule.digest, snapshotDigest: snapshot.digest, config, fixtures,
    ...(options.executionReceipt ? { executionReceipt: options.executionReceipt } : {}),
    ...(repositoryContexts ? { repositoryContexts } : {}),
    coverage: { scope: 'changed-entries-only', snapshotVerification: 'package-integrity-only', repositoryContext: 'incomplete', introduction: 'unverified', targets },
    occurrences, findings: makeFindings(id, options.rule.digest, rule, snapshot, targets, occurrences, adjudication, judgmentOrigin), notification: 'not_performed' };
  return validateSemanticReview(review, options.rule, snapshot);
}

/** Read-time integrity and domain binding checks; never re-executes a scanner or model. */
export function validateSemanticReview(input: SemanticReview, ruleInput: StoredRuleVersion, snapshotInput: StoredChangeSnapshot): SemanticReview {
  const review = SemanticReviewSchema.parse(input), { rule, snapshot } = inputs(ruleInput, snapshotInput);
  if (Buffer.byteLength(JSON.stringify(review)) > REVIEW_LIMITS.jsonBytes) throw new Error('Review result exceeds 4MB; no truncated review can be stored');
  if (review.ruleDigest !== ruleInput.digest || review.snapshotDigest !== snapshot.digest || review.id !== semanticReviewId(review.ruleDigest, review.snapshotDigest, review.config)) throw new Error('Review identity mismatch');
  if ((review.fixtures ? digestOf(review.fixtures) : null) !== review.config.fixtureDigest) throw new Error('Review fixture configuration mismatch');
  const repositoryContexts = review.repositoryContexts === undefined ? undefined : validateReviewRepositoryContexts(review.repositoryContexts, snapshot);
  if (digestOf(repositoryContexts ?? null) !== digestOf(review.repositoryContexts ?? null)
    || digestOf(review.config.repositoryContextDigests ?? null) !== digestOf(repositoryContexts ? reviewRepositoryContextDigests(repositoryContexts) : null)) throw new Error('Review repository context configuration mismatch');
  if (review.config.runtime !== reviewRuntime(review.fixtures, review.executionReceipt, repositoryContexts)) throw new Error('Review runtime does not match its versioned judgment contract');
  const baseTargets = makeTargets(rule, ruleInput.digest, snapshot);
  const fixtures = review.fixtures ? validateReviewFixtures(review.fixtures, ruleInput.digest, snapshot, baseTargets, repositoryContexts) : null;
  if ((review.executionReceipt ? digestOf(review.executionReceipt) : undefined) !== review.config.executionDigest
    || (review.config.mode === 'workspace_execution') !== !!review.executionReceipt
    || (review.executionReceipt && fixtures)) throw new Error('Review execution configuration mismatch');
  const adjudication = review.executionReceipt ? validateSemanticReviewExecution(review.executionReceipt, ruleInput, snapshot, repositoryContexts) : fixtures;
  const judgmentOrigin = review.executionReceipt?.modelExecution === 'completed' ? 'model' as const : 'fixture' as const;
  if (baseTargets.length !== review.coverage.targets.length) throw new Error('Review coverage omits changed entries');
  for (const [index, target] of review.coverage.targets.entries()) {
    const { scans, semantic, ...identity } = target, { scans: ignoredScans, semantic: ignoredSemantic, ...expected } = baseTargets[index];
    if (digestOf(identity) !== digestOf(expected)) throw new Error('Review target does not bind to the declared snapshot and scope');
    const assets = target.disposition === 'captured' ? rule.detectionAssets ?? [] : [];
    if (target.scans.length !== assets.length || target.scans.some((scan, i) => scan.assetId !== assets[i].id || scan.engine !== assets[i].detector.kind)) throw new Error('Review asset coverage is incomplete or mismatched');
    for (const [assetIndex, scan] of scans.entries()) {
      const eligibility = scanEligibility(assets[assetIndex], target.path);
      // Eligible work can succeed, fail or exhaust a budget; reads retain rather than rerun that outcome.
      if (eligibility.state === 'eligible' ? !['scanned', 'execution_error', 'budget_exceeded'].includes(scan.state) : scan.state !== eligibility.state) throw new Error('Review asset coverage contradicts deterministic scanner eligibility');
      const count = review.occurrences.filter(item => item.targetId === target.id && item.assetId === scan.assetId).length;
      if ((scan.state === 'scanned' ? scan.candidateCount : 0) !== count) throw new Error('Review occurrence counts disagree with asset coverage');
    }
  }
  const expectedTargets = semanticTargets(review.coverage.targets, rule, adjudication);
  if (digestOf(expectedTargets) !== digestOf(review.coverage.targets)) throw new Error('Review semantic result does not match the bound semantic evidence');
  const seen = new Set<string>();
  for (const occurrence of review.occurrences) {
    if (seen.has(occurrence.id)) throw new Error('Duplicate review occurrence'); seen.add(occurrence.id);
    const target = review.coverage.targets.find(value => value.id === occurrence.targetId);
    const asset = rule.detectionAssets?.find(value => value.id === occurrence.assetId);
    if (!target || target.disposition !== 'captured' || !asset || asset.detector.kind !== 'ast-grep' || occurrence.anchor.side !== 'after' || occurrence.anchor.path !== target.path || occurrence.anchor.sourceDigest !== target.sourceDigest || occurrence.language !== asset.detector.language) throw new Error('Occurrence target/asset identity mismatch');
    validateSnapshotAnchor(occurrence.anchor, snapshot);
    const candidate = makeCandidate({ ruleId: rule.ruleId, ruleVersion: rule.version, bundleDigest: ruleInput.digest,
      source: snapshotSource(snapshot, 'after', target.path), path: target.path, language: occurrence.language, engine: 'ast-grep', start: occurrence.anchor.span.start.offset, end: occurrence.anchor.span.end.offset });
    if (candidate.id !== occurrence.candidateId || occurrence.id !== digestOf({ snapshotDigest: snapshot.digest, side: 'after', assetId: asset.id, candidateId: candidate.id })) throw new Error('Occurrence ID does not bind exact source, asset and snapshot');
  }
  const findings = makeFindings(review.id, ruleInput.digest, rule, snapshot, review.coverage.targets, review.occurrences, adjudication, judgmentOrigin);
  if (digestOf(findings) !== digestOf(review.findings)) throw new Error('Finding aggregation or adjudication does not match review evidence');
  return review;
}

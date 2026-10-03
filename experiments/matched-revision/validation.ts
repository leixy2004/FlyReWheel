import { z } from 'zod';
import { canonicalJson, digestOf } from '../../src/core/identity.js';
import { DigestSchema, IdSchema } from '../../src/core/model.js';
import { SemanticRuleVersionSchema } from '../../src/core/semantic-rule.js';
import { REVISION_CONTEXT_POLICY, REVISION_OPERATOR_POLICY, type RevisionModelResponse } from '../../src/core/revision-model.js';
import { buildRevisionModelInput, requiredRevisionOperator, revisionConsumedSourceDigests, validateRevisionModelResponse,
  type PreparedRevisionModelInput, type RevisionModelInput } from '../../src/revision-generation.js';
import { validateSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { bytesDigest, freeze } from '../../src/workspace/execution-receipt.js';
import { FutureCaseSchema, GateCaseSchema, ProposalSchema, RuleContentSchema, SettingsSchema, SharedDiagnosisSchema,
  type Arm, type FrozenEpisode, type FrozenFuture, type FrozenPacket, type PersistentState, type Proposal } from './contracts.js';
import { renderState } from './prompts.js';

const EpisodeSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('matched-revision-frozen-episode'), origin: z.literal('authored_fixture'),
  id: IdSchema, familyId: IdSchema, frozenAt: z.string().datetime({ offset: true }), revision: z.unknown(),
  diagnosis: SharedDiagnosisSchema, gate: z.array(GateCaseSchema).min(1).max(100),
  revisionLineageIds: z.array(IdSchema).min(1).max(300), visibilityAndMissingness: z.string().min(1).max(8192),
  protocolRecordDigest: DigestSchema, settings: SettingsSchema,
}).strict();
function unique(xs: string[], name: string) {
  if (new Set(xs).size !== xs.length) throw new Error(`Duplicate ${name}`);
}
export function fixtureTokenCount(text: string) { return Buffer.byteLength(text, 'utf8'); }
export function initialStructured(prepared: PreparedRevisionModelInput): PersistentState {
  const base = SemanticRuleVersionSchema.parse(prepared.graph.baseRule.rule);
  return { kind: 'structured', content: RuleContentSchema.parse({ semantics: base.semantics, paths: base.scope.paths, detectionAssets: base.detectionAssets ?? [] }) };
}
export function initialMemory(prepared: PreparedRevisionModelInput): PersistentState {
  return { kind: 'scoped_memory', initialLesson: renderState(initialStructured(prepared)), delta: null };
}
function wrapHard(prepared: PreparedRevisionModelInput, result: RevisionModelResponse['result']) {
  return { policyVersion: REVISION_OPERATOR_POLICY, requestDigest: prepared.graph.request.digest,
    baseRuleDigest: prepared.graph.baseRule.digest, requestedRuleVersion: prepared.graph.request.request.requestedRuleVersion, result,
    ...(prepared.outputContract === 'rule-revision-v3' ? { evidencePolicyVersion: REVISION_CONTEXT_POLICY,
      repositoryContextBindings: prepared.repositoryContextBindings } : {}) };
}
function nonMutation(episode: FrozenEpisode, proposal?: Proposal): RevisionModelResponse['result'] {
  return { status: 'no_rule_change', operator: proposal?.action === 'retain' ? 'retain_rule'
    : proposal?.action === 'request_context' ? 'request_context' : 'abstain',
    reasoning: proposal?.rationale ?? 'Frozen diagnosis validation; no policy output generated',
    nextStep: proposal?.nextStep ?? 'Use the already frozen diagnosis without reclassification',
    missingEvidence: proposal?.missingEvidence ?? [], evidenceRefs: proposal?.evidenceRefs ?? [],
    diagnoses: episode.diagnosis.diagnoses };
}
export interface NativeValidationLimits { renderedPersistentStateBytes: number; model: string; maxOutputBytes: number; timeoutMs: number }
function prepare(episode: FrozenEpisode, native?: NativeValidationLimits) {
  return buildRevisionModelInput(episode.revision, { model: native?.model ?? episode.settings.revisionModel,
    // The product graph validator has its own 1 MB envelope ceiling. Native
    // answer admission remains separate in the ledger; a broader declaration
    // must not make an otherwise valid supplied graph fail during preparation.
    limits: { maxInputBytes: 2_000_000, maxOutputBytes: native ? Math.min(native.maxOutputBytes, 1_000_000) : episode.settings.limits.maxOutputBytes,
      timeoutMs: native?.timeoutMs ?? episode.settings.limits.timeoutMsPerCall } });
}
/** Hash checking establishes byte identity only, never temporal visibility or human independence. */
export function validatePacket(packet: FrozenPacket, future: FrozenFuture, native?: NativeValidationLimits) {
  if (Buffer.byteLength(canonicalJson(packet)) > 16_000_000 || Buffer.byteLength(canonicalJson(future)) > 8_000_000) throw new Error('Experiment packet exceeds byte budget');
  const parsed = EpisodeSchema.parse(packet.episode);
  if (digestOf(packet.episode) !== DigestSchema.parse(packet.digest)) throw new Error('Frozen episode digest mismatch');
  const episode = structuredClone(parsed) as FrozenEpisode;
  const prepared = prepare(episode, native);
  // Product graph validation strips no experiment-writable evidence: require exact canonical equality.
  const revision: RevisionModelInput = { ...prepared.graph, candidateId: prepared.candidateId,
    candidateCreatedAt: prepared.candidateCreatedAt, context: prepared.context };
  if (digestOf(revision) !== digestOf(episode.revision)) throw new Error('Revision packet contains unknown or noncanonical fields');
  const cases = z.array(FutureCaseSchema).min(1).max(100).parse(future.cases);
  if (digestOf(cases) !== DigestSchema.parse(future.digest)) throw new Error('Frozen future roster/label digest mismatch');
  if (Date.parse(episode.diagnosis.lockedAt) > Date.parse(episode.frozenAt)) throw new Error('Diagnosis must be locked before the episode');
  const provenance = episode.diagnosis.provenance;
  // Generated authored-native outcomes are runtime records, never accepted as
  // supplied packets or silently promoted to the legacy inferred condition.
  if (provenance.origin === 'authored_sdk_diagnosis_no_model') throw new Error('Authored SDK diagnosis must be produced by the diagnosis-only stage');
  const pendingDiagnosis = provenance.origin === 'authored_sdk_diagnosis_pending';
  if (pendingDiagnosis && (!native || episode.diagnosis.condition !== 'inferred' || provenance.upstreamCalls !== 0
    || provenance.upstreamModel !== null || provenance.rawFailure !== null
    || [provenance.inputTokens, provenance.outputTokens, provenance.costMicros, provenance.elapsedMs].some(v => v !== null)
    || episode.diagnosis.originalContextStatus !== 'unknown' || episode.diagnosis.revisionContextStatus !== 'unknown'
    || episode.diagnosis.diagnoses.some(d => d.category !== 'insufficient_evidence' || !d.missingEvidence.length))) {
    throw new Error('Pending authored diagnosis requires an unexecuted native-only Unknown slot');
  }
  if (episode.diagnosis.condition === 'provided' && (provenance.origin === 'model_inference_declared' || provenance.origin === 'administrative_failure')) throw new Error('Provided diagnosis cannot claim inferred provenance');
  if (episode.diagnosis.condition === 'inferred' && provenance.origin === 'independent_human_declared') throw new Error('Inferred diagnosis cannot be an expert-provided diagnosis');
  if (provenance.origin === 'administrative_failure' && (!provenance.rawFailure || episode.diagnosis.diagnoses.some(d => d.category !== 'insufficient_evidence' || !d.missingEvidence.length))) throw new Error('Failed diagnosis needs unchanged administrative insufficient-evidence records and raw failure');
  if (episode.diagnosis.condition === 'inferred' && !pendingDiagnosis && provenance.upstreamCalls !== 1) throw new Error('Inferred diagnosis requires exactly one upstream attempt; the runner does not retry it');
  validateSharedDiagnosis(episode, prepared);
  unique(episode.gate.map(g => g.input.id), 'gate target'); unique(cases.map(c => c.input.id), 'future target');
  unique(cases.map(c => canonicalJson([c.input.prId, c.input.familyId, c.input.lineageId])), 'future issue within PR/family');
  unique(episode.revisionLineageIds, 'revision lineage');
  const oldCases = prepared.graph.cases;
  if (oldCases.some(c => !episode.revisionLineageIds.includes(c.lineageId))) throw new Error('Revision lineage inventory omits a source/regression case');
  const required = [...prepared.graph.baseRule.rule.regressionCases.map(c => `case:${c.caseId}`),
    ...prepared.graph.feedback.map(f => `feedback:${f.feedback.id}`)];
  if (required.some(ref => !episode.gate.some(g => g.obligationRefs.includes(ref)))) throw new Error('Common gate omits a frozen regression/feedback obligation');
  if (!episode.gate.some(g => g.role === 'old_positive')) throw new Error('Common gate requires a still-valid old positive');
  for (const regression of prepared.graph.baseRule.rule.regressionCases) {
    const item = oldCases.find(c => c.id === regression.caseId)!;
    const matching = episode.gate.filter(g => g.obligationRefs.includes(`case:${item.id}`));
    if (matching.some(g => g.input.sourceDigest !== item.sourceDigest || g.expected !== item.expected
      || (regression.role === 'positive' && (g.role !== 'old_positive' || g.expected !== 'violation')))) throw new Error('Gate changes a frozen case expectation/source/positive obligation');
  }
  for (const { feedback, finding } of prepared.graph.feedback) {
    for (const g of episode.gate.filter(g => g.obligationRefs.includes(`feedback:${feedback.id}`))) {
      if (g.input.sourceSnapshotDigest !== finding.anchor.snapshotDigest || g.input.sourceDigest !== finding.anchor.sourceDigest
        || g.input.path !== finding.anchor.path || g.input.issueScope.start !== finding.anchor.span.start.offset
        || g.input.issueScope.end !== finding.anchor.span.end.offset
        || (feedback.label === 'TP' && g.expected !== 'violation')
        || (feedback.label === 'FP' && g.expected !== 'safe' && g.expected !== 'not_applicable')) throw new Error('Gate substitutes the selected feedback source/scope or expectation');
    }
  }
  const allTargets = [...episode.gate.map(g => g.input), ...cases.map(c => c.input)];
  for (const target of allTargets) {
    if (target.familyId !== episode.familyId || bytesDigest(target.source) !== target.sourceDigest
      || target.issueScope.end > target.source.length) throw new Error('Target family/source digest or issue scope mismatch');
    unique(target.evidence.map(e => e.id), 'target evidence ID');
  }
  const usedSources = new Set([...revisionConsumedSourceDigests(prepared.graph), ...episode.gate.map(g => g.input.sourceDigest)]);
  const usedLineages = new Set([...episode.revisionLineageIds, ...episode.gate.map(g => g.input.lineageId)]);
  const usedIds = new Set(episode.gate.map(g => g.input.id));
  for (const c of cases) {
    if (usedSources.has(c.input.sourceDigest) || usedLineages.has(c.input.lineageId) || usedIds.has(c.input.id)) throw new Error('Future case overlaps revision/gate source, lineage or target');
    if (c.repeatedFeedbackMechanism && c.label !== 'legal_neighbor') throw new Error('Repeated-feedback denominator must be frozen legal neighbors');
  }
  const positiveLineages = new Set(cases.filter(c => c.label === 'violation').map(c => c.input.lineageId));
  if (cases.some(c => c.label === 'legal_neighbor' && positiveLineages.has(c.input.lineageId))) throw new Error('Future positive and legal neighbor require independent lineages');
  // Native over-budget states become undispatched roster entries in the ledger.
  // The legacy frozen packet preflight keeps its existing token-cap behavior.
  if (!native) for (const state of [initialStructured(prepared), initialMemory(prepared)]) checkPersistentBudget(state, episode);
  return freeze({ episode, cases, prepared });
}
/** Validate exactly one cited diagnosis per selected feedback, independently of
 * proposal policy. An abstention wrapper applies only the existing evidence checks. */
export function validateSharedDiagnosis(episode: FrozenEpisode, prepared: PreparedRevisionModelInput) {
  const diagnosticCheck = nonMutation(episode);
  diagnosticCheck.evidenceRefs = prepared.repositoryContextBindings.flatMap(b => b.evidenceRefs.map(id => `evidence:${id}`));
  validateRevisionModelResponse(prepared, wrapHard(prepared, diagnosticCheck));
}
export function checkPersistentBudget(state: PersistentState, episode: FrozenEpisode, nativeBytes?: number) {
  if (nativeBytes !== undefined) {
    if (Buffer.byteLength(renderState(state), 'utf8') > nativeBytes) throw new Error('Persistent state exceeds the native rendered byte cap');
    return;
  }
  if (fixtureTokenCount(renderState(state)) > episode.settings.limits.persistentStateTokens) throw new Error('Persistent state exceeds the common token cap');
}
export function commonRevisionBlock(episode: FrozenEpisode, prepared: PreparedRevisionModelInput, budget: unknown = episode.settings): string {
  const graph = prepared.graph;
  return canonicalJson({ episodeId: episode.id, oldRule: graph.baseRule, ruleOrigin: episode.origin,
    sourceCases: graph.cases, originalReviewAndFeedback: graph.feedback.map(({ feedback, finding, review }) => {
      const evidence = review.executionReceipt?.workerResult.value.evidence ?? review.fixtures?.evidence ?? [];
      return { feedback, finding, findingSource: validateSnapshotAnchor(finding.anchor, graph.snapshots.find(s => s.digest === review.snapshotDigest)!),
        originalInputManifest: { reviewDigest: digestOf(review), snapshotDigest: review.snapshotDigest, config: review.config },
        selectedEvidence: finding.evidenceRefs.map(id => evidence.find(e => e.id === id)!) };
    }), visibilityAndMissingness: episode.visibilityAndMissingness, frozenDiagnosis: episode.diagnosis,
    publicRegressionObligations: episode.gate, retrievalEnvelope: { familyId: episode.familyId, tools: 'none', outsideRetrieval: 'none' },
    budget, permittedEvidenceRefs: prepared.evidenceRefs });
}
/** Shared schema/source constraints, then H-only enforcement. Never route U/M through H's validator. */
export function validateProposal(raw: unknown, arm: Exclude<Arm, 'F'>, episode: FrozenEpisode,
  prepared: PreparedRevisionModelInput, nativePersistentBytes?: number): Proposal {
  const proposal = ProposalSchema.parse(raw), base = initialStructured(prepared);
  if (proposal.evidenceRefs.some(ref => !prepared.evidenceRefs.includes(ref))) throw new Error('Proposal cites evidence outside the frozen revision selection');
  const requiredContext = prepared.repositoryContextBindings.flatMap(b => b.evidenceRefs.map(id => `evidence:${id}`));
  if (requiredContext.some(ref => !proposal.evidenceRefs.includes(ref))) throw new Error('Proposal drops selected context citations');
  if (proposal.action !== 'revise') {
    if (proposal.state !== null || proposal.replacement !== null || !proposal.nextStep) throw new Error('Non-mutation requires null state/replacement and a concrete next step');
  } else {
    if (!proposal.state) throw new Error('Changed proposal requires a state');
    const required = [`rule:${prepared.graph.baseRule.digest}`, ...prepared.graph.feedback.flatMap(f => [`feedback:${f.feedback.id}`, `finding:${f.finding.id}`])];
    if (required.some(ref => !proposal.evidenceRefs.includes(ref))) throw new Error('Changed proposal must cite the base and every selected feedback/finding');
    if (arm === 'M') {
      const initial = initialMemory(prepared);
      if (proposal.state.kind !== 'scoped_memory' || initial.kind !== 'scoped_memory'
        || proposal.state.initialLesson !== initial.initialLesson || !proposal.state.delta || proposal.replacement !== null) throw new Error('Memory requires the exact initial lesson and one local delta, without a contract envelope');
      if (proposal.state.delta.operation === 'revise' && proposal.state.delta.text === initial.initialLesson) throw new Error('Memory revision requires an actual edit');
    } else {
      if (proposal.state.kind !== 'structured') throw new Error('Structured arm requires structured content');
      const old = SemanticRuleVersionSchema.parse(prepared.graph.baseRule.rule);
      SemanticRuleVersionSchema.parse({ ...old, semantics: proposal.state.content.semantics,
        scope: { ...old.scope, paths: proposal.state.content.paths }, detectionAssets: proposal.state.content.detectionAssets });
      if (digestOf(proposal.state) === digestOf(base)) throw new Error('Changed proposal requires an actual edit');
    }
    if (proposal.replacement && (proposal.replacement.priorRuleDigest !== prepared.graph.baseRule.digest
      || proposal.replacement.evidenceRefs.some(ref => !prepared.evidenceRefs.includes(ref)))) throw new Error('Replacement declaration changes immutable evidence identities');
    checkPersistentBudget(proposal.state, episode, nativePersistentBytes);
  }
  if (arm === 'H') {
    let result = nonMutation(episode, proposal);
    if (proposal.action === 'revise') {
      if (proposal.state?.kind !== 'structured') throw new Error('Structured arm requires structured content');
      const required = requiredRevisionOperator(prepared, wrapHard(prepared, result));
      if (required !== 'boundary_update' && required !== 'contract_replacement') throw new Error('Hard policy does not permit mutation for this frozen diagnosis');
      result = { status: 'candidate', ...proposal.state.content, operator: required, replacement: proposal.replacement,
        rationale: proposal.rationale, evidenceRefs: proposal.evidenceRefs, diagnoses: episode.diagnosis.diagnoses };
      if (proposal.missingEvidence.length) throw new Error('Hard mutation cannot conceal missing evidence');
    }
    validateRevisionModelResponse(prepared, wrapHard(prepared, result));
  }
  return freeze(proposal);
}

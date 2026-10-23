import { digestOf } from '../../src/core/identity.js';
import { NativeEvaluationContextSchema } from '../../src/core/matched-revision-model.js';
import { aggregateMatchedResults } from './macro-report.js';
import { checkDigest, checkNativeCall, checkNativeDiagnosis, type NativeMacroContext } from './native-macro-integrity.js';
import { validateSdkNativeConfiguration } from './sdk-native-validation.js';
import { validateSdkNativeSchedule, validateSdkNativeScheduledInput } from './sdk-native-schedule.js';
import type { SdkNativeConfiguration } from './sdk-native-contracts.js';
import type { SdkNativeStudyInput, SdkNativeStudyReport } from './sdk-native-study.js';
import { commonRevisionBlock, initialMemory, initialStructured, validatePacket, validateProposal } from './validation.js';
import { nativeProposalRequest, nativeReviewRequest } from './sdk-native-runner.js';
import { nativeDiagnosisRequest } from './sdk-native-diagnosis.js';
import { evaluateGate, observations } from './scoring.js';
import type { Proposal } from './contracts.js';

/** Complete frozen source roster, distinct from the subset supplied for execution. */
export interface NativeMacroInput {
  configuration: SdkNativeConfiguration;
  sources: SdkNativeStudyInput[];
  study: SdkNativeStudyReport;
  clusters: { repository: string; clusterId: string; lineages: string[] }[];
}
/** One supported native input path: canonical study + configuration + complete
 * frozen sources + explicit repository/lineage dependence mapping. No execution. */
export function aggregateNativeStudy(input: NativeMacroInput) {
  const config = validateSdkNativeConfiguration(input.configuration), study = input.study;
  checkDigest(study);
  const schedule = validateSdkNativeSchedule(study.schedule, config);
  if (study.schemaVersion !== 1 || study.kind !== 'matched-revision-sdk-native-authored-study-report'
    || study.execution !== 'completed' || study.modelExecution !== 'not_run' || study.empiricalEpisodes !== 0
    || study.independentHumanAnnotations !== 0 || study.providerModelCalls !== 0
    || study.scheduleDigest !== schedule.digest || study.configurationDigest !== digestOf(config)
    || study.operationalAdmission !== 'not_evaluated' || study.declaredPinsVerified !== false) throw new Error('Expected canonical authored native study');
  const evaluation = study.evaluation === undefined ? undefined : NativeEvaluationContextSchema.parse(study.evaluation);
  const sources = new Map(input.sources.map(s => [s.blockId, s]));
  const results = new Map(study.blocks.map(b => [b.blockId, b]));
  if (sources.size !== input.sources.length || results.size !== study.blocks.length) throw new Error('Duplicate native block');
  if (sources.size !== schedule.blocks.length || [...sources.keys(), ...results.keys()].some(id => !schedule.blocks.some(b => b.blockId === id))) throw new Error('Complete frozen sources required; unplanned native block');
  const repositories = new Map<string, Set<string>>();
  let unsafeSince: number | null = null;
  const audit = schedule.blocks.map(block => {
    const source = sources.get(block.blockId)!;
    validateSdkNativeScheduledInput(schedule, block.blockId, { ...source, repetition: block.repetition });
    const { episode, cases, prepared } = validatePacket(source.packet, source.future, {
      renderedPersistentStateBytes: config.limits.renderedPersistentStateBytes, model: config.roles.proposal.model,
      maxOutputBytes: config.limits.answerBytes.proposal, timeoutMs: config.limits.deadlineMsPerCall });
    const repositoryIds = [...new Set(episode.revision.snapshots.map(s => s.snapshot.repository.id))];
    if (repositoryIds.length !== 1) throw new Error('Ambiguous native repository');
    const repository = repositoryIds[0], lineages = repositories.get(repository) ?? new Set<string>();
    for (const lineage of [...episode.revisionLineageIds, ...episode.gate.map(g => g.input.lineageId), ...cases.map(c => c.input.lineageId)]) lineages.add(lineage);
    repositories.set(repository, lineages);
    const context: NativeMacroContext = { configuration: config, schedule, block, ...(evaluation ? { evaluation } : {}) };
    const result = results.get(block.blockId);
    if (result) {
      if (result.episodeId !== block.episodeId || result.condition !== block.condition || result.repetition !== block.repetition
        || !['completed', 'failed', 'missing'].includes(result.status)
        || digestOf(result.plannedArmOrder) !== digestOf(block.armOrder)
        || digestOf(result.plannedFutureTargetOrder) !== digestOf(block.futureTargetOrder)
        || digestOf(result.roster.map(a => a.arm)) !== digestOf(block.armOrder)
        || result.roster.some(a => digestOf(a.future.map(t => t.targetId)) !== digestOf(block.futureTargetOrder)
          || digestOf(a.slots.map(s => s.stage)) !== digestOf(a.arm === 'F' ? ['gate', 'future'] : ['proposal', 'gate', 'future']))
        || (result.report !== null && (result.interrupted || result.status === 'missing'))
        || (result.report === null && result.status === 'completed')) throw new Error('Native block/result roster mismatch');
      const recorded = result.report ? result.report.arms.flatMap(a => a.calls.map(call => ({ arm: a.arm, call })))
        : result.interruptedCallRecords ?? [];
      const shared = result.report?.diagnosisStage ? [result.report.diagnosisStage.call]
        : result.diagnosisSlot?.record ? [result.diagnosisSlot.record.call] : result.interruptedSharedCallRecords ?? [];
      const all = [...shared.map(call => ({ arm: null, call })), ...recorded];
      const scheduledDiagnosis = schedule.counting.diagnosis === 'authored-sdk-once-per-inferred-block' && block.condition === 'inferred';
      const diagnosisRecord = result.diagnosisSlot?.record ?? null;
      if (scheduledDiagnosis !== (result.diagnosisSlot !== null)
        || (diagnosisRecord && !scheduledDiagnosis)) throw new Error('Native diagnosis slot mismatch');
      const lockedDiagnosis = diagnosisRecord ? checkNativeDiagnosis(diagnosisRecord, episode, prepared, context) : null;
      if (diagnosisRecord && result.interruptedSharedCallRecords?.length
        && digestOf(result.interruptedSharedCallRecords) !== digestOf([diagnosisRecord.call])) throw new Error('Conflicting interrupted shared call');
      if (diagnosisRecord && (result.diagnosisSlot!.scheduled !== 1 || result.diagnosisSlot!.status !== diagnosisRecord.status)) throw new Error('Native diagnosis slot status mismatch');
      if (scheduledDiagnosis && recorded.length && !lockedDiagnosis) throw new Error('Native arm calls lack locked diagnosis');
      const plannedCalls = block.armOrder.flatMap(arm => (arm === 'F' ? ['gate', 'future'] : ['proposal', 'gate', 'future'])
        .map(stage => ({ arm, stage })));
      if (digestOf(recorded.map(r => ({ arm: r.arm, stage: r.call.stage }))) !== digestOf(plannedCalls.slice(0, recorded.length))) throw new Error('Native call order is not a scheduled prefix');
      const effectiveEpisode = lockedDiagnosis ? { ...episode, diagnosis: lockedDiagnosis } : episode;
      const common = commonRevisionBlock(effectiveEpisode, prepared, config);
      const diagnosisRequest = nativeDiagnosisRequest(episode, prepared, context);
      for (const call of shared) if (!scheduledDiagnosis || digestOf(call.request) !== digestOf(diagnosisRequest)) throw new Error('Native shared request mismatch');
      // Check every retained prefix even when no completed runner report exists.
      // Uncertain intents are admitted only at their exact next scheduled request.
      const expectedRequests = new Map<string, string>();
      if (scheduledDiagnosis) expectedRequests.set(digestOf([block.blockId, block.repetition, null, 'diagnosis']), digestOf(diagnosisRequest));
      for (const arm of block.armOrder) {
        const rows = recorded.filter(r => r.arm === arm).map(r => r.call);
        const stages = arm === 'F' ? ['gate', 'future'] : ['proposal', 'gate', 'future'];
        if (digestOf(rows.map(r => r.stage)) !== digestOf(stages.slice(0, rows.length))) throw new Error('Native partial call roster mismatch');
        const incumbent = arm === 'M' ? initialMemory(prepared) : initialStructured(prepared);
        let proposal: Proposal | null = null, accepted = false;
        for (let index = 0; index < stages.length; index++) {
          const stage = stages[index];
          if (index > rows.length) break;
          const base = stage === 'proposal' && arm !== 'F' ? nativeProposalRequest(arm, common, config)
            : stage === 'gate' ? nativeReviewRequest('gate', proposal?.state ?? incumbent, episode.gate.map(g => g.input), config)
              : nativeReviewRequest('future', accepted ? proposal!.state! : incumbent,
                block.futureTargetOrder.map(id => cases.find(c => c.input.id === id)!.input), config);
          const request = evaluation ? { ...base, evaluation } : base;
          const callId = digestOf([block.blockId, block.repetition, arm, stage]);
          expectedRequests.set(callId, digestOf(request));
          const call = rows[index];
          if (!call) continue;
          if (digestOf(call.request) !== digestOf(request)) throw new Error('Native partial request mismatch');
          if (stage === 'proposal' && arm !== 'F' && call.status === 'completed') {
            try { proposal = validateProposal(call.output, arm, effectiveEpisode, prepared, config.limits.renderedPersistentStateBytes); }
            catch { proposal = null; }
          }
          if (stage === 'gate') accepted = proposal?.action === 'revise' && evaluateGate(episode.gate,
            observations(episode.gate.map(g => g.input), call.output, call.status === 'completed' ? null
              : call.status === 'budget_exhausted' ? 'not_run_budget_exhausted' : call.status)).passed;
        }
      }
      const ids = new Set<string>();
      for (const { arm, call } of all) {
        const native = checkNativeCall(call, arm, context);
        if (ids.has(native.callId)) throw new Error('Duplicate native call');
        ids.add(native.callId);
        if (unsafeSince !== null && call.invoked && Date.parse(call.finishedAt!) >= unsafeSince) throw new Error('Native dispatch after uncertain completion/cleanup');
        if (call.invoked && call.transportEvidence?.cleanup !== 'verified') {
          unsafeSince = Math.min(unsafeSince ?? Infinity, Date.parse(call.finishedAt!));
        }
      }
      const uncertain = result.uncertainCalls ?? [];
      if (uncertain.length > 1) throw new Error('Duplicate uncertain native calls');
      for (const call of uncertain) {
        const next = scheduledDiagnosis && !shared.length ? { arm: null, stage: 'diagnosis' } : plannedCalls[recorded.length];
        const stages = call.arm === null ? ['diagnosis'] : call.arm === 'F' ? ['gate', 'future'] : ['proposal', 'gate', 'future'];
        if (!next || call.callId !== digestOf([block.blockId, block.repetition, next.arm, next.stage])
          || (scheduledDiagnosis && call.arm !== null && !lockedDiagnosis)
          || (call.arm !== null && !block.armOrder.includes(call.arm))
          || !stages.some(stage => call.callId === digestOf([block.blockId, block.repetition, call.arm, stage]))
          || ids.has(call.callId) || expectedRequests.get(call.callId) !== call.requestDigest) throw new Error('Invalid/duplicate uncertain native call');
        ids.add(call.callId);
      }
      if (uncertain.length && (!result.interrupted || result.report)) throw new Error('Uncertain call requires interrupted missing report');
      const unsafeReturned = all.filter(r => r.call.invoked && r.call.transportEvidence?.cleanup !== 'verified');
      if (uncertain.length || unsafeReturned.length) {
        const times = [...unsafeReturned.map(r => Date.parse(r.call.finishedAt!)),
          ...(uncertain.length ? [Date.parse(result.startedAt ?? '')] : [])];
        if (times.some(t => !Number.isFinite(t))) throw new Error('Uncertain native record lacks time boundary');
        unsafeSince = Math.min(unsafeSince ?? Infinity, ...times);
      }
      const order = all.map(({ arm, call: c }) => ({ arm, stage: c.stage, callId: c.nativeRecord!.callId,
        invoked: c.invoked, status: c.status, startedAt: c.startedAt!, finishedAt: c.finishedAt! }));
      if (digestOf(order) !== digestOf(result.actualCallOrder)
        || digestOf([...new Set(recorded.map(c => c.arm))]) !== digestOf(result.actualArmOrder)) throw new Error('Native observed order mismatch');
      if (!result.report && !result.interrupted && (all.length || uncertain.length)) throw new Error('Missing block claims execution records');
      if (result.report && result.diagnosisSlot?.record
        && digestOf(result.diagnosisSlot.record) !== digestOf(result.report.diagnosisStage ?? null)) throw new Error('Native shared diagnosis mismatch');
      if (result.report) {
        const failed = (result.report.diagnosisStage !== undefined && result.report.diagnosisStage.status !== 'authored_output_locked')
          || result.report.arms.some(a => a.calls.some(c => c.status !== 'completed')
            || [...a.gate.observations, ...a.future].some(o => o.judgment === null)
            || ['schema_invalid', 'policy_invalid', 'failed', 'not_run'].includes(a.disposition));
        if (result.status !== (failed ? 'failed' : 'completed')) throw new Error('Native block status contradicts retained results');
        for (const arm of result.report.arms) {
          const expectedAllocation = arm.arm === 'F' ? null : result.report.diagnosisStage?.allocation ?? null;
          if (!('sharedDiagnosisAllocation' in arm.usage.standalone)
            || digestOf(arm.usage.standalone.sharedDiagnosisAllocation) !== digestOf(expectedAllocation)) throw new Error('Native standalone diagnosis allocation mismatch');
        }
      }
    }
    return { source, context, result, repository };
  });
  // Reordered imported results are joined by block ID; the schedule remains canonical.
  // Missing result rows are retained as absent records, never silently excluded.
  if (study.counts.plannedBlocks !== schedule.blocks.length || study.counts.repetitions !== schedule.repetitions
    || study.counts.retries !== 0 || study.counts.authoredEpisodeIdentities !== new Set(schedule.sources.map(s => s.episodeId)).size
    || study.counts.completedBlocks !== study.blocks.filter(b => b.status === 'completed').length
    || study.counts.failedBlocks !== study.blocks.filter(b => b.status === 'failed').length
    || study.counts.missingBlocks !== study.blocks.filter(b => b.status === 'missing').length) throw new Error('Native study counts mismatch');
  validateNativeClusters(input.clusters, repositories);
  const macro = aggregateMatchedResults(audit.map(({ source, context, result }) => ({ ...source,
    repetition: context.block.repetition, report: result?.report ?? null, native: context })));
  const clusterMapping = [...input.clusters].sort((a, b) => a.repository.localeCompare(b.repository))
    .map(c => ({ ...c, lineages: [...c.lineages].sort() }));
  const body = { schemaVersion: 1, kind: 'matched-revision-native-macro-report',
    modelExecution: 'not_run', empiricalEpisodes: 0, inference: 'not_estimated',
    inputDigest: digestOf(input), scheduleDigest: schedule.digest, studyDigest: study.digest,
    clusterMapping, clusterMappingDigest: digestOf(clusterMapping), declaredClusters: new Set(clusterMapping.map(c => c.clusterId)).size,
    clusterBoundary: 'Declared dependence mapping only; no verified independent/probability-sampled clusters. Repository weights are unchanged.',
    blocks: audit.map(({ context, result }) => ({ blockId: context.block.blockId,
      repetition: context.block.repetition, status: result?.status ?? 'missing',
      resultRecordAbsent: !result, interrupted: result?.interrupted ?? false,
      uncertainCalls: result?.uncertainCalls ?? [],
      interruptedCallRecords: result?.interruptedCallRecords ?? [],
      interruptedSharedCallRecords: result?.interruptedSharedCallRecords ?? [],
      diagnosisSlot: result?.diagnosisSlot ?? null,
      actualCallOrder: result?.actualCallOrder ?? [],
      // Raw usage and unknown billing retained; no synthetic cost or token totals.
      nativeCalls: result?.report?.arms.flatMap(a => a.calls.map(c => c.nativeRecord!)) ?? [],
      reportDigest: result?.report?.digest ?? null })), macro };
  return { ...body, digest: digestOf(body) };
}

/** Validate declared dependence groups; never establishes statistical independence. */
export function validateNativeClusters(clusters: NativeMacroInput['clusters'], repositories: Map<string, Set<string>>) {
  const clusterByRepo = new Map(clusters.map(c => [c.repository, c]));
  if (clusterByRepo.size !== clusters.length || clusterByRepo.size !== repositories.size) throw new Error('Exact cluster mapping required');
  const lineageClusters = new Map<string, string>();
  for (const [repository, lineages] of repositories) {
    const mapping = clusterByRepo.get(repository);
    if (!mapping || !mapping.clusterId.trim() || new Set(mapping.lineages).size !== mapping.lineages.length
      || digestOf([...mapping.lineages].sort()) !== digestOf([...lineages].sort())) throw new Error('Repository/lineage cluster mapping mismatch');
    for (const lineage of lineages) {
      if (lineageClusters.has(lineage) && lineageClusters.get(lineage) !== mapping.clusterId) throw new Error('Shared lineage split across clusters');
      lineageClusters.set(lineage, mapping.clusterId);
    }
  }
}

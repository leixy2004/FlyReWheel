import { NativeEvaluationContextSchema, type NativeEvaluationContext } from '../../src/core/matched-revision-model.js';
import { MatchedStudyStore, MatchedStudyError, type MatchedStudyClaim, type MatchedStudyEvent } from '../../src/storage/matched-studies.js';
import { digestOf } from '../../src/core/identity.js';
import { freeze } from '../../src/workspace/execution-receipt.js';
import { isAuthoredCodexNativeMatchedTransport, type AuthoredCodexNativeMatchedTransport } from '../../src/adapters/matched-revision-codex.js';
import type { Arm, FrozenFuture, FrozenPacket } from './contracts.js';
import { runMatchedRevision, type CallRecord } from './runner.js';
import type { SdkNativeConfiguration } from './sdk-native-contracts.js';
import type { AuthoredSdkNativeDiagnosisRecord } from './sdk-native-diagnosis.js';
import { validateSdkNativeConfiguration } from './sdk-native-validation.js';
import { validateSdkNativeSchedule, validateSdkNativeScheduledInput, type SdkNativeSchedule,
  type SdkNativeScheduledBlock } from './sdk-native-schedule.js';

type CompletedBlock = Extract<Awaited<ReturnType<typeof runMatchedRevision>>, { execution: 'completed' }>;
type Outcome = 'completed' | 'failed' | 'missing';
export interface SdkNativeStudyInput { blockId: string; packet: FrozenPacket; future: FrozenFuture }
/** Compute the status identity before dispatch, so interruption cannot hide it. */
export function sdkNativeStudyDigest(schedule: SdkNativeSchedule, configuration: SdkNativeConfiguration, evaluation?: NativeEvaluationContext) {
  const config = validateSdkNativeConfiguration(configuration);
  const frozen = validateSdkNativeSchedule(schedule, config);
  return digestOf(['authored-matched-study-recovery', frozen.digest, digestOf(config),
    ...(evaluation === undefined ? [] : [digestOf(NativeEvaluationContextSchema.parse(evaluation))])]);
}
function roster(block: SdkNativeScheduledBlock, report: CompletedBlock | null, recorded: { arm: Arm; call: CallRecord }[],
  uncertain: BlockOutcome['uncertainCalls']) {
  const pending = (arm: Arm, stage: string) => uncertain.find(c => c.callId === digestOf([block.blockId, block.repetition, arm, stage]));
  return block.armOrder.map(arm => {
    const result = report?.arms.find(row => row.arm === arm);
    const stages = arm === 'F' ? ['gate', 'future'] as const : ['proposal', 'gate', 'future'] as const;
    return { arm, proposalSlotsScheduled: arm === 'F' ? 0 : 1, proposalSlotsUsed: result?.proposalSlotsUsed ?? (recorded.some(c => c.arm === arm && c.call.stage === 'proposal') || pending(arm, 'proposal') ? 1 : 0),
      slots: stages.map(stage => {
        const call = recorded.find(c => c.arm === arm && c.call.stage === stage)?.call;
        const status: Outcome | 'uncertain' = pending(arm, stage) ? 'uncertain' : !call || !call.invoked ? 'missing' : call.status === 'completed' ? 'completed' : 'failed';
        return { stage, status, invoked: call?.invoked ?? null, callId: call?.nativeRecord?.callId ?? pending(arm, stage)?.callId ?? null,
          failure: call?.error ?? (call ? null : 'No returned call record; retain the planned slot') };
      }),
      future: block.futureTargetOrder.map(targetId => {
        const row = result?.future.find(r => r.targetId === targetId);
        const call = recorded.find(c => c.arm === arm && c.call.stage === 'future')?.call;
        const status: Outcome | 'uncertain' = pending(arm, 'future') ? 'uncertain' : !call || !call.invoked ? 'missing' : call.status !== 'completed' ? 'failed'
          : row?.judgment ? 'completed' : 'missing';
        return { targetId, status, observation: row ?? null };
      }) };
  });
}
function failed(report: CompletedBlock) {
  return (report.diagnosisStage !== undefined && report.diagnosisStage.status !== 'authored_output_locked')
    || report.arms.some(a => a.calls.some(c => c.status !== 'completed')
    || [...a.gate.observations, ...a.future].some(row => row.judgment === null)
    || ['schema_invalid', 'policy_invalid', 'failed', 'not_run'].includes(a.disposition));
}

interface BlockOutcome { report: CompletedBlock | null; status: Outcome; failure: string | null;
  startedAt: string | null; finishedAt: string | null; interrupted: boolean;
  recorded: { arm: Arm; call: CallRecord }[]; sharedCallRecords: CallRecord[]; diagnosisRecord: AuthoredSdkNativeDiagnosisRecord | null;
  uncertainCalls: { callId: string; arm: Arm | null; requestDigest: string }[] }
function blockReport(block: SdkNativeScheduledBlock, schedule: SdkNativeSchedule, outcome: BlockOutcome) {
  const { report, status, failure, startedAt, finishedAt, interrupted, recorded, diagnosisRecord, uncertainCalls, sharedCallRecords } = outcome;
  return { blockId: block.blockId, episodeId: block.episodeId, condition: block.condition,
      repetition: block.repetition, status, failure, startedAt, finishedAt, interrupted,
      plannedArmOrder: block.armOrder, plannedFutureTargetOrder: block.futureTargetOrder,
      actualArmOrder: [...new Set(recorded.map(c => c.arm))],
      actualCallOrder: [
        ...(diagnosisRecord ? [{ arm: null, call: (diagnosisRecord as AuthoredSdkNativeDiagnosisRecord).call }]
          : sharedCallRecords.map(call => ({ arm: null, call }))),
        ...recorded].map(({ arm, call: c }) => ({ arm, stage: c.stage,
        callId: c.nativeRecord!.callId, invoked: c.invoked, status: c.status,
        startedAt: c.startedAt!, finishedAt: c.finishedAt! })),
      diagnosisSlot: schedule.counting.diagnosis === 'authored-sdk-once-per-inferred-block' && block.condition === 'inferred'
        ? { scheduled: 1, status: (diagnosisRecord as AuthoredSdkNativeDiagnosisRecord | null)?.status
            ?? (uncertainCalls.some(c => c.arm === null) ? 'uncertain' : sharedCallRecords.length ? 'interrupted' : 'missing'),
          record: diagnosisRecord as AuthoredSdkNativeDiagnosisRecord | null } : null,
      ...(interrupted ? { interruptedCallRecords: recorded, interruptedSharedCallRecords: sharedCallRecords } : {}),
      roster: roster(block, report, recorded, uncertainCalls), report,
      ...(uncertainCalls.length ? { uncertainCalls } : {}) };
}
type StudyBlock = ReturnType<typeof blockReport>;
function studyReport(schedule: SdkNativeSchedule, configuration: SdkNativeConfiguration, blocks: StudyBlock[], studyDigest?: string, evaluation?: NativeEvaluationContext) {
  const body = { ...(evaluation ? { evaluation } : {}), schemaVersion: 1, kind: 'matched-revision-sdk-native-authored-study-report',
    execution: 'completed' as const, modelExecution: 'not_run' as const, empiricalEpisodes: 0,
    independentHumanAnnotations: 0, providerModelCalls: 0,
    operationalAdmission: 'not_evaluated', declaredPinsVerified: false,
    schedule, scheduleDigest: schedule.digest, configurationDigest: digestOf(configuration),
    counts: { authoredEpisodeIdentities: new Set(schedule.sources.map(s => s.episodeId)).size,
      plannedBlocks: blocks.length, completedBlocks: blocks.filter(b => b.status === 'completed').length,
      failedBlocks: blocks.filter(b => b.status === 'failed').length, missingBlocks: blocks.filter(b => b.status === 'missing').length,
      repetitions: schedule.repetitions, retries: 0 },
    boundaries: ['Authored mechanics only; repetitions do not create independent empirical episodes',
      schedule.counting.diagnosis === 'authored-sdk-once-per-inferred-block'
        ? 'One shared authored SDK diagnosis-only slot per inferred episode/repeat; no model inference, construction or diagnosis retries'
        : 'Supplied locked diagnoses only; no construction, diagnosis inference or diagnosis retries executed',
      'All blocks and targets retained; no best-repetition selection or reroll; exact durable results are identity-bound recovery only',
      'No live runtime/monetary admission, analysis freeze or efficacy claim'],
    ...(studyDigest ? { recovery: { studyDigest, protocol: 'transactional-authored-study-v1',
      interruptedSlots: 'retain-uncertainty-never-reinvoke', completedResults: 'immutable-exact-identity-reuse' } } : {}), blocks };
  return freeze({ ...body, digest: digestOf(body) });
}
export type SdkNativeStudyReport = ReturnType<typeof studyReport>;
function checkReport<T extends { digest: string }>(report: T): T {
  const { digest, ...body } = report;
  if (digestOf(body) !== digest) throw new Error('Stored report digest mismatch');
  return report;
}
function recoveryEvents(events: MatchedStudyEvent[], blockId: string) {
  const selected = events.filter(e => e.blockId === blockId);
  const records = selected.filter(e => e.key.startsWith('call-result:')).map(e => e.payload as { arm: Arm | null; call: CallRecord });
  const uncertainCalls = selected.filter(e => e.key.startsWith('call-intent:')
    && !selected.some(r => r.key === `call-result:${e.key.slice('call-intent:'.length)}`))
    .map(e => e.payload as { callId: string; arm: Arm | null; requestDigest: string });
  const unsafe = uncertainCalls.length > 0 || records.some(r => r.call.invoked && r.call.transportEvidence?.cleanup !== 'verified');
  return { selected, records, uncertainCalls, unsafe };
}

/** Authored-only driver. Optional durable storage coordinates processes and
 * checkpoints every dispatch. Recovery reuses finished blocks and terminally
 * retains interrupted blocks; it never replays a partly executed block. */
export async function runSdkNativeStudy(input: {
  evaluation?: NativeEvaluationContext; verifyEvaluation?: () => Promise<void>;
  mode: 'authored_fixture' | 'production'; schedule: SdkNativeSchedule;
  configuration: SdkNativeConfiguration; blocks: SdkNativeStudyInput[];
  transport: AuthoredCodexNativeMatchedTransport; store?: MatchedStudyStore;
}) {
  if (input.mode !== 'authored_fixture') return { execution: 'not_run' as const, modelExecution: 'not_run' as const,
    reason: 'production_adapter_unconfigured', blocks: [] };
  if (!isAuthoredCodexNativeMatchedTransport(input.transport)) return { execution: 'not_run' as const,
    modelExecution: 'not_run' as const, reason: 'authored_native_sdk_transport_required', blocks: [] };
  const evaluation = input.evaluation === undefined ? undefined : freeze(NativeEvaluationContextSchema.parse(input.evaluation));
  const verifyEvaluation = input.verifyEvaluation;
  if (evaluation) {
    if (!verifyEvaluation) throw new Error('Native evaluation requires a trusted verification hook');
    await verifyEvaluation();
  }
  const configuration = validateSdkNativeConfiguration(input.configuration);
  const schedule = validateSdkNativeSchedule(input.schedule, configuration);
  const supplied = freeze(structuredClone(input.blocks));
  const byId = new Map<string, SdkNativeStudyInput>();
  for (const item of supplied) {
    if (byId.has(item.blockId)) throw new Error('Duplicate supplied block; no retry or replacement');
    const block = schedule.blocks.find(b => b.blockId === item.blockId);
    if (!block) throw new Error('Supplied block is not in the frozen schedule');
    validateSdkNativeScheduledInput(schedule, item.blockId, { ...item, repetition: block.repetition });
    byId.set(item.blockId, item);
  }
  const store = input.store;
  let claim: MatchedStudyClaim | undefined, events: MatchedStudyEvent[] = [];
  if (store) {
    const manifest = { schemaVersion: 1 as const, kind: 'authored-matched-study-recovery' as const,
      scheduleDigest: schedule.digest, configurationDigest: digestOf(configuration), blockIds: schedule.blocks.map(b => b.blockId),
      input: { ...(evaluation ? { evaluation } : {}), schedule, configuration, blocks: schedule.blocks.map(b => byId.get(b.blockId) ?? null) } };
    // Renewed on each awaited checkpoint; one call plus cleanup cannot outlive this bound.
    const leaseMs = configuration.limits.deadlineMsPerCall + configuration.limits.cleanupTimeoutMs + 30_000;
    const admission = await store.claim(manifest, leaseMs);
    if (admission.state === 'busy') return { execution: 'not_run' as const, modelExecution: 'not_run' as const,
      reason: 'study_running_in_another_driver', studyDigest: admission.studyDigest, blocks: [] };
    if (admission.state === 'finished') return freeze(checkReport(admission.result as SdkNativeStudyReport));
    claim = admission.claim;
    events = (await store.inspect(claim.studyDigest))!.events;
  }
  const blocks: StudyBlock[] = [];
  const eventsByBlock = new Map<string, MatchedStudyEvent[]>();
  for (const event of events) {
    const rows = eventsByBlock.get(event.blockId) ?? []; rows.push(event); eventsByBlock.set(event.blockId, rows);
  }
  const recovered = new Map(schedule.blocks.map(b => [b.blockId, recoveryEvents(eventsByBlock.get(b.blockId) ?? [], b.blockId)]));
  let dispatchBlocked = [...recovered.values()].some(e => e.unsafe);
  for (const block of schedule.blocks) {
    const prior = recovered.get(block.blockId)!;
    const saved = prior.selected.find(e => e.key === 'block-result');
    if (saved) {
      const result = saved.payload as StudyBlock;
      if (result.blockId !== block.blockId || digestOf(result.plannedArmOrder) !== digestOf(block.armOrder)
        || digestOf(result.plannedFutureTargetOrder) !== digestOf(block.futureTargetOrder)) throw new Error('Stored block roster mismatch');
      if (result.report) checkReport(result.report);
      blocks.push(result); continue;
    }
    const item = byId.get(block.blockId);
    const outcome: BlockOutcome = { report: null, status: 'missing', failure: null, startedAt: null, finishedAt: null,
      interrupted: false, recorded: [], sharedCallRecords: [], diagnosisRecord: null, uncertainCalls: [] };
    const interrupted = prior.selected.find(e => e.key === 'block-start');
    if (interrupted) {
      outcome.status = 'failed'; outcome.interrupted = true;
      outcome.failure = 'Interrupted durable block retained; no diagnosis/proposal/review reinvocation';
      outcome.startedAt = (interrupted.payload as { startedAt: string }).startedAt;
      outcome.finishedAt = new Date().toISOString();
      outcome.recorded = prior.records.filter((r): r is { arm: Arm; call: CallRecord } => r.arm !== null);
      outcome.diagnosisRecord = (prior.selected.find(e => e.key === 'diagnosis')?.payload as AuthoredSdkNativeDiagnosisRecord | undefined) ?? null;
      outcome.sharedCallRecords = prior.records.filter(r => r.arm === null).map(r => r.call);
      outcome.uncertainCalls = prior.uncertainCalls;
    } else if (!item) outcome.failure = 'Frozen block input missing; no replacement or reroll';
    else if (dispatchBlocked) outcome.failure = 'Earlier durable dispatch has uncertain completion or cleanup; remaining roster retained without launch';
    else {
      outcome.startedAt = new Date().toISOString();
      if (store) await store.append(claim!, block.blockId, 'block-start', { startedAt: outcome.startedAt });
      try {
        const result = await runMatchedRevision({ mode: 'authored_fixture', packet: item.packet, future: item.future,
          native: { ...(evaluation ? { evaluation, verifyEvaluation } : {}), configuration, repetition: block.repetition, transport: input.transport,
            schedule: { manifest: schedule, blockId: block.blockId },
            ...(store ? { checkpoint: {
              beforeCall: async (arm: Arm | null, callId: string, requestDigest: string) => {
                await store.append(claim!, block.blockId, `call-intent:${callId}`, { arm, callId, requestDigest });
              },
              afterCall: async (arm: Arm | null, call: CallRecord) => {
                await store.append(claim!, block.blockId, `call-result:${call.nativeRecord!.callId}`, { arm, call });
              },
            } } : {}),
            observeDiagnosis: async record => {
              if (store) await store.append(claim!, block.blockId, 'diagnosis', record);
              outcome.diagnosisRecord = record;
            },
            observeCall: (arm, call) => { outcome.recorded.push({ arm, call }); } } });
        if (result.execution !== 'completed') { outcome.status = 'failed'; outcome.failure = result.reason; }
        else { outcome.report = result; outcome.status = failed(result) ? 'failed' : 'completed'; }
      } catch (error) {
        // Storage/fencing errors may have committed remotely. Leave the exact
        // checkpoints for a later claim; never continue under uncertain ownership.
        if (store && error instanceof MatchedStudyError) throw error;
        outcome.status = 'failed'; outcome.interrupted = true;
        outcome.failure = error instanceof Error ? error.message.slice(0, 2000) : 'Authored block interrupted';
      }
      outcome.finishedAt = new Date().toISOString();
      if (store) {
        const inspected = (await store.inspect(claim!.studyDigest))!;
        const observed = recoveryEvents(inspected.events, block.blockId);
        outcome.uncertainCalls = observed.uncertainCalls;
        if (outcome.interrupted) {
          outcome.recorded = observed.records.filter((r): r is { arm: Arm; call: CallRecord } => r.arm !== null);
          outcome.sharedCallRecords = observed.records.filter(r => r.arm === null).map(r => r.call);
          outcome.diagnosisRecord = (observed.selected.find(e => e.key === 'diagnosis')?.payload as AuthoredSdkNativeDiagnosisRecord | undefined) ?? null;
        }
        dispatchBlocked ||= observed.unsafe;
      }
    }
    const result = blockReport(block, schedule, outcome);
    if (store) await store.append(claim!, block.blockId, 'block-result', result);
    blocks.push(result);
  }
  const report = studyReport(schedule, configuration, blocks, claim?.studyDigest, evaluation);
  if (store) await store.finish(claim!, report);
  return report;
}

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
function roster(block: SdkNativeScheduledBlock, report: CompletedBlock | null, recorded: { arm: Arm; call: CallRecord }[]) {
  return block.armOrder.map(arm => {
    const result = report?.arms.find(row => row.arm === arm);
    const stages = arm === 'F' ? ['gate', 'future'] as const : ['proposal', 'gate', 'future'] as const;
    return { arm, proposalSlotsScheduled: arm === 'F' ? 0 : 1, proposalSlotsUsed: result?.proposalSlotsUsed ?? 0,
      slots: stages.map(stage => {
        const call = recorded.find(c => c.arm === arm && c.call.stage === stage)?.call;
        const status: Outcome = !call || !call.invoked ? 'missing' : call.status === 'completed' ? 'completed' : 'failed';
        return { stage, status, invoked: call?.invoked ?? null, callId: call?.nativeRecord?.callId ?? null,
          failure: call?.error ?? (call ? null : 'No returned call record; retain the planned slot') };
      }),
      future: block.futureTargetOrder.map(targetId => {
        const row = result?.future.find(r => r.targetId === targetId);
        const call = recorded.find(c => c.arm === arm && c.call.stage === 'future')?.call;
        const status: Outcome = !call || !call.invoked ? 'missing' : call.status !== 'completed' ? 'failed'
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

/** Thin authored-only schedule driver around the existing matched loop. Missing
 * inputs stay missing, every block is visited once, and failures never reroll.
 * There is intentionally no live backend, resume or proposal/review cache API. */
export async function runSdkNativeStudy(input: {
  mode: 'authored_fixture' | 'production'; schedule: SdkNativeSchedule;
  configuration: SdkNativeConfiguration; blocks: SdkNativeStudyInput[];
  transport: AuthoredCodexNativeMatchedTransport;
}) {
  if (input.mode !== 'authored_fixture') return { execution: 'not_run' as const, modelExecution: 'not_run' as const,
    reason: 'production_adapter_unconfigured', blocks: [] };
  if (!isAuthoredCodexNativeMatchedTransport(input.transport)) return { execution: 'not_run' as const,
    modelExecution: 'not_run' as const, reason: 'authored_native_sdk_transport_required', blocks: [] };
  const configuration = validateSdkNativeConfiguration(input.configuration);
  const schedule = validateSdkNativeSchedule(input.schedule, configuration);
  // Snapshot and validate every supplied identity before the first dispatch.
  // Unknown/duplicate/substituted inputs cannot become a partial favorable run.
  const supplied = freeze(structuredClone(input.blocks));
  const byId = new Map<string, SdkNativeStudyInput>();
  for (const item of supplied) {
    if (byId.has(item.blockId)) throw new Error('Duplicate supplied block; no retry or replacement');
    const block = schedule.blocks.find(b => b.blockId === item.blockId);
    if (!block) throw new Error('Supplied block is not in the frozen schedule');
    validateSdkNativeScheduledInput(schedule, item.blockId, { ...item, repetition: block.repetition });
    byId.set(item.blockId, item);
  }
  const blocks = [];
  for (const block of schedule.blocks) {
    const item = byId.get(block.blockId);
    let report: CompletedBlock | null = null, status: Outcome = 'missing', failure: string | null = null;
    let startedAt: string | null = null, finishedAt: string | null = null, interrupted = false;
    const recorded: { arm: Arm; call: CallRecord }[] = [];
    let diagnosisRecord: AuthoredSdkNativeDiagnosisRecord | null = null;
    if (!item) failure = 'Frozen block input missing; no replacement or reroll';
    else {
      startedAt = new Date().toISOString();
      try {
        const result = await runMatchedRevision({ mode: 'authored_fixture', packet: item.packet, future: item.future,
          native: { configuration, repetition: block.repetition, transport: input.transport,
            schedule: { manifest: schedule, blockId: block.blockId },
            observeDiagnosis: record => { diagnosisRecord = record; },
            observeCall: (arm, call) => { recorded.push({ arm, call }); } } });
        if (result.execution !== 'completed') { status = 'failed'; failure = result.reason; }
        else { report = result; status = failed(result) ? 'failed' : 'completed'; }
      } catch (error) {
        // No retry. If an unexpected interruption escaped the normal per-call
        // failure ledger, absence of a returned report cannot prove no dispatch.
        status = 'failed'; interrupted = true;
        failure = error instanceof Error ? error.message.slice(0, 2000) : 'Authored block interrupted';
      }
      finishedAt = new Date().toISOString();
    }
    blocks.push({ blockId: block.blockId, episodeId: block.episodeId, condition: block.condition,
      repetition: block.repetition, status, failure, startedAt, finishedAt, interrupted,
      plannedArmOrder: block.armOrder, plannedFutureTargetOrder: block.futureTargetOrder,
      actualArmOrder: [...new Set(recorded.map(c => c.arm))],
      actualCallOrder: [
        ...(diagnosisRecord ? [{ arm: null, call: (diagnosisRecord as AuthoredSdkNativeDiagnosisRecord).call }] : []),
        ...recorded].map(({ arm, call: c }) => ({ arm, stage: c.stage,
        callId: c.nativeRecord!.callId, invoked: c.invoked, status: c.status,
        startedAt: c.startedAt!, finishedAt: c.finishedAt! })),
      diagnosisSlot: schedule.counting.diagnosis === 'authored-sdk-once-per-inferred-block' && block.condition === 'inferred'
        ? { scheduled: 1, status: (diagnosisRecord as AuthoredSdkNativeDiagnosisRecord | null)?.status ?? 'missing',
          record: diagnosisRecord as AuthoredSdkNativeDiagnosisRecord | null } : null,
      ...(interrupted ? { interruptedCallRecords: recorded } : {}),
      roster: roster(block, report, recorded), report });
  }
  const body = { schemaVersion: 1, kind: 'matched-revision-sdk-native-authored-study-report',
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
      'All blocks and targets retained; no best-repetition selection, output cache reuse or reroll',
      'No cross-process execution registry, live runtime/monetary admission, analysis freeze or efficacy claim'], blocks };
  return freeze({ ...body, digest: digestOf(body) });
}

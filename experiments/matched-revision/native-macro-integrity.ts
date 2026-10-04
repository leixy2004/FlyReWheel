import { digestOf } from '../../src/core/identity.js';
import { MatchedDiagnosisSchema, SdkNativeMatchedRequestSchema, type NativeEvaluationContext } from '../../src/core/matched-revision-model.js';
import type { Arm, FrozenEpisode } from './contracts.js';
import type { PreparedRevisionModelInput } from '../../src/revision-generation.js';
import type { CallRecord } from './runner.js';
import type { SdkNativeConfiguration } from './sdk-native-contracts.js';
import type { SdkNativeSchedule, SdkNativeScheduledBlock } from './sdk-native-schedule.js';
import { validateSdkNativeCallRecord } from './sdk-native-validation.js';
import { nativeDiagnosisRequest, type AuthoredSdkNativeDiagnosisRecord } from './sdk-native-diagnosis.js';
import { validateSharedDiagnosis } from './validation.js';
export interface NativeMacroContext {
  configuration: SdkNativeConfiguration; schedule: SdkNativeSchedule; block: SdkNativeScheduledBlock;
  evaluation?: NativeEvaluationContext;
}
export function checkDigest(value: { digest: string }) {
  const { digest, ...body } = value;
  if (digestOf(body) !== digest) throw new Error('Native report digest mismatch');
}
/** Consistency checks only: these receipts do not authenticate execution. */
export function checkNativeCall(call: CallRecord, arm: Arm | null, context: NativeMacroContext) {
  const record = validateSdkNativeCallRecord(call.nativeRecord, context.configuration);
  const request = SdkNativeMatchedRequestSchema.parse(call.request);
  if (digestOf({ model: request.model, ...(request.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: request.modelReasoningEffort }) })
    !== digestOf(record.requestedSettings) || digestOf(request.evaluation ?? null) !== digestOf(context.evaluation ?? null)
    || !Number.isFinite(call.elapsedMs) || call.elapsedMs < 0
    || !['completed', 'failed', 'timeout', 'invalid_output', 'budget_exhausted'].includes(call.status)) throw new Error('Native actual request/settings mismatch');
  const { block } = context;
  if (record.executionKind !== 'authored_sdk_no_model' || record.blockId !== block.blockId
    || record.repetition !== block.repetition || record.arm !== arm
    || record.callId !== digestOf([block.blockId, block.repetition, arm, call.stage])
    || record.role !== (call.stage === 'diagnosis' ? 'diagnosis' : call.stage === 'proposal' ? 'proposal' : 'review')
    || !['proposal', 'gate', 'future', 'diagnosis'].includes(call.stage)
    || (arm === null) !== (call.stage === 'diagnosis')
    || call.invoked !== (record.observations.sdkInvocations === 1)
    || call.usage !== null || digestOf(call.request) !== call.requestDigest
    || call.request.stage !== call.stage || !call.startedAt || !call.finishedAt
    || !Number.isFinite(Date.parse(call.startedAt)) || Date.parse(call.finishedAt) < Date.parse(call.startedAt)
    || !Number.isFinite(Date.parse(call.finishedAt))) throw new Error('Native call identity/status mismatch');
  const expected = call.status === 'completed' ? 'authored_completed'
    : !call.invoked ? 'not_dispatched' : call.status === 'timeout' && record.status === 'cancelled' ? 'cancelled' : 'failed';
  if (record.status !== expected || (call.output !== null && call.outputDigest !== digestOf(call.output))
    || (call.status === 'completed' && call.outputDigest !== digestOf(call.output))) throw new Error('Native call outcome mismatch');
  if (!call.invoked && (call.output !== null || call.outputDigest !== null)) throw new Error('Undispatched native output');
  return record;
}
export function checkNativeDiagnosis(stage: AuthoredSdkNativeDiagnosisRecord, episode: FrozenEpisode,
  prepared: PreparedRevisionModelInput, context: NativeMacroContext) {
  checkDigest(stage);
  const { block, configuration } = context;
  if (stage.schemaVersion !== 1 || stage.kind !== 'matched-revision-sdk-native-authored-diagnosis'
    || stage.executionKind !== 'authored_sdk_no_model' || stage.modelExecution !== 'not_run' || stage.empiricalEpisodes !== 0
    || stage.blockId !== block.blockId || stage.episodeId !== episode.id || stage.repetition !== block.repetition
    || stage.configurationDigest !== digestOf(configuration) || stage.attemptsScheduled !== 1 || stage.retries !== 0) throw new Error('Native diagnosis identity mismatch');
  const record = checkNativeCall(stage.call, null, context);
  const request = nativeDiagnosisRequest(episode, prepared, context);
  if (stage.inputDigest !== digestOf(request) || digestOf(stage.call.request) !== digestOf(request)) throw new Error('Native diagnosis input mismatch');
  validateSharedDiagnosis({ ...episode, diagnosis: stage.sharedDiagnosis }, prepared);
  const diagnosis = stage.sharedDiagnosis, provenance = diagnosis.provenance;
  const elapsed = Math.max(Math.ceil(stage.call.elapsedMs), (record.observations.setupMs ?? 0)
    + (record.observations.executionMs ?? 0) + (record.observations.cleanupMs ?? 0));
  if (stage.allocation.recordDigest !== digestOf(stage.call) || stage.allocation.elapsedMs !== elapsed
    || stage.allocation.sdkInvocations !== record.observations.sdkInvocations
    || digestOf(stage.allocation.rawUsage) !== digestOf(record.observations.rawUsage)
    || digestOf(stage.allocation.cost) !== digestOf(record.observations.cost)
    || diagnosis.condition !== 'inferred' || diagnosis.lockedAt !== stage.call.finishedAt
    || provenance.origin !== 'authored_sdk_diagnosis_no_model' || provenance.sourceRecordDigest !== digestOf(stage.call)
    || provenance.upstreamCalls !== 0 || provenance.upstreamModel !== null || provenance.costMicros !== null
    || provenance.elapsedMs !== elapsed || provenance.inputTokens !== record.observations.rawUsage.input_tokens
    || provenance.outputTokens !== record.observations.rawUsage.output_tokens || provenance.rawFailure !== stage.failure) throw new Error('Native diagnosis allocation mismatch');
  if (stage.status === 'authored_output_locked') {
    const output = MatchedDiagnosisSchema.parse(stage.call.output);
    if (stage.call.status !== 'completed' || stage.failure !== null
      || digestOf(output) !== digestOf({ diagnoses: diagnosis.diagnoses,
        originalContextStatus: diagnosis.originalContextStatus, revisionContextStatus: diagnosis.revisionContextStatus })) throw new Error('Native diagnosis output mismatch');
  } else if (stage.status !== 'administrative_unknown' || stage.call.status === 'completed'
    || diagnosis.originalContextStatus !== 'unknown' || diagnosis.revisionContextStatus !== 'unknown'
    || diagnosis.diagnoses.some(d => d.category !== 'insufficient_evidence' || !d.missingEvidence.length)) throw new Error('Native diagnosis fallback mismatch');
  return diagnosis;
}

import { canonicalJson, digestOf } from '../../src/core/identity.js';
import { freeze } from '../../src/workspace/execution-receipt.js';
import { ProposalSchema, TransportResultSchema, type Arm, type AuthoredTransport, type FrozenFuture, type FrozenPacket,
  type ModelRequest, type PersistentState, type Proposal, type Settings, type SharedDiagnosis, type TransportResult, type Usage } from './contracts.js';
import { commonRevisionBlock, fixtureTokenCount, initialMemory, initialStructured, validatePacket, validateProposal } from './validation.js';
import { proposalRequest, renderState, reviewRequest } from './prompts.js';
import { evaluateGate, observations, scoreFuture } from './scoring.js';
import type { SdkNativeMatchedRequest } from '../../src/core/matched-revision-model.js';
import { isAuthoredCodexNativeMatchedTransport } from '../../src/adapters/matched-revision-codex.js';
import { nativeProposalRequest, nativeReviewRequest, SdkNativeLedger, type NativeMatchedExecution } from './sdk-native-runner.js';
import { validateSdkNativeConfiguration } from './sdk-native-validation.js';
import type { SdkNativeCallRecord } from './sdk-native-contracts.js';
import { validateSdkNativeSchedule, validateSdkNativeScheduledInput } from './sdk-native-schedule.js';
import { runAuthoredSdkNativeDiagnosis, SDK_NATIVE_AUTHORED_DIAGNOSIS } from './sdk-native-diagnosis.js';

export interface CallRecord {
  stage: SdkNativeMatchedRequest['stage']; requestDigest: string; request: ModelRequest | SdkNativeMatchedRequest;
  status: 'completed' | 'failed' | 'timeout' | 'invalid_output' | 'budget_exhausted';
  error: string | null; invoked: boolean; output: unknown; outputDigest: string | null;
  usage: Usage | null; elapsedMs: number; accountedInputTokens?: number; accountedOutputTokens?: number;
  transportEvidence: TransportResult['transportEvidence'] | null;
  nativeRecord?: SdkNativeCallRecord;
  startedAt?: string; finishedAt?: string;
}
function errorText(error: unknown) { return error instanceof Error ? error.message.slice(0, 2000) : 'Adapter error'; }
class Ledger {
  readonly calls: CallRecord[] = [];
  private started = performance.now();
  private blocked: string | null = null;
  constructor(private readonly settings: Settings, private readonly transport: AuthoredTransport,
    private readonly upstream: SharedDiagnosis['provenance'] | null) {
    if (upstream && [upstream.inputTokens, upstream.outputTokens, upstream.costMicros, upstream.elapsedMs].some(v => v === null)) {
      this.blocked = 'Upstream diagnosis usage is unknown; standalone budget cannot be verified';
    }
  }
  async call(rawRequest: ModelRequest | SdkNativeMatchedRequest, _persistentStateBytes?: number): Promise<CallRecord> {
    const request = freeze(structuredClone(rawRequest)) as ModelRequest, limits = this.settings.limits, started = performance.now();
    const requestText = canonicalJson(request), inputTokens = fixtureTokenCount(requestText);
    const record: CallRecord = { stage: request.stage, requestDigest: digestOf(request), request,
      status: 'budget_exhausted', error: null, invoked: false, output: null, outputDigest: null, usage: null,
      elapsedMs: 0, accountedInputTokens: 0, accountedOutputTokens: 0, transportEvidence: null };
    const usedInput = this.calls.reduce((n, c) => n + (c.accountedInputTokens ?? 0), this.upstream?.inputTokens ?? 0);
    const usedOutput = this.calls.reduce((n, c) => n + (c.accountedOutputTokens ?? 0), this.upstream?.outputTokens ?? 0);
    const remainingTime = limits.maxElapsedMsPerArm - (started - this.started) - (this.upstream?.elapsedMs ?? 0);
    const inputCap = request.stage === 'proposal' ? limits.revisionInputTokens : limits.reviewInputTokens;
    if (this.blocked || this.calls.filter(c => c.invoked).length + (this.upstream?.upstreamCalls ?? 0) >= limits.maxCallsPerArm
      || (this.upstream?.costMicros ?? 0) > limits.maxCostMicrosPerArm
      || inputTokens > inputCap || Buffer.byteLength(requestText) > limits.maxInputBytes
      || usedInput + inputTokens > limits.maxInputTokensPerArm || usedOutput >= limits.maxOutputTokensPerArm || remainingTime <= 0) {
      record.error = this.blocked ?? 'Frozen input/call/token/time budget exhausted'; this.calls.push(record); return record;
    }
    // Reserve the remaining completion budget before dispatch; never promise unavailable output tokens.
    if (request.maxOutputTokens > limits.maxOutputTokensPerArm - usedOutput) {
      record.error = 'Remaining output budget cannot cover the frozen per-call ceiling'; this.calls.push(record); return record;
    }
    record.invoked = true; record.accountedInputTokens = inputTokens;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const dispatched = Promise.resolve().then(() => this.transport.execute(request, controller.signal));
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('AUTHORED_TRANSPORT_TIMEOUT'));
      }, Math.min(limits.timeoutMsPerCall, remainingTime)); });
      const raw = await Promise.race([dispatched, timeout]);
      const result = TransportResultSchema.parse(raw);
      record.usage = result.usage;
      record.transportEvidence = result.transportEvidence ?? null;
      const outputText = canonicalJson(result.output);
      record.outputDigest = digestOf(result.output); record.accountedOutputTokens = Math.max(fixtureTokenCount(outputText), result.usage?.outputTokens ?? 0);
      record.accountedInputTokens = Math.max(inputTokens, result.usage?.inputTokens ?? 0);
      if (Buffer.byteLength(outputText) > limits.maxOutputBytes || record.accountedOutputTokens > request.maxOutputTokens) {
        record.status = 'invalid_output'; record.error = 'Output exceeds the frozen response ceiling';
      } else {
        record.output = result.output; record.status = result.status;
        record.error = result.status === 'failed' ? result.error ?? 'Authored transport failed' : null;
      }
      // A synchronous fixture can prevent the timer from firing. Its late return still cannot be accepted.
      if (performance.now() - started > Math.min(limits.timeoutMsPerCall, remainingTime)) {
        record.status = 'timeout'; record.error = 'Transport returned after the frozen call/arm deadline';
      }
      const totalCost = [...this.calls, record].reduce((n, c) => n + (c.usage?.costMicros ?? 0), this.upstream?.costMicros ?? 0);
      if (!result.usage || result.usage.costMicros === null || totalCost > limits.maxCostMicrosPerArm
        || usedInput + record.accountedInputTokens > limits.maxInputTokensPerArm
        || usedOutput + record.accountedOutputTokens > limits.maxOutputTokensPerArm) {
        this.blocked = 'Usage is unmeasured or exceeds the frozen total budget';
        // Preserve a concrete execution failure as well as its unknown-cost blocker.
        if (record.status !== 'failed' && record.status !== 'timeout') { record.status = 'budget_exhausted'; record.error = this.blocked; }
      }
      if (record.transportEvidence?.cleanup === 'unverified') this.blocked = 'Worker cleanup is unverified; subsequent dispatch is disabled';
    } catch (error) {
      record.status = errorText(error) === 'AUTHORED_TRANSPORT_TIMEOUT' ? 'timeout' : 'failed'; record.error = errorText(error);
      // No retries or subsequent work whose remaining cost is unknown. A fixture callback cannot be forcibly killed.
      this.blocked = 'Earlier call did not return bounded usage; subsequent dispatch is disabled';
      if (record.status === 'timeout' && this.transport.abortSettlementMs !== undefined) {
        let settlementTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const ms = this.transport.abortSettlementMs;
          if (!Number.isSafeInteger(ms) || ms < 1 || ms > 35_000) throw new Error('Invalid cancellation settlement bound');
          const result = TransportResultSchema.parse(await Promise.race([dispatched,
            new Promise<never>((_, reject) => { settlementTimer = setTimeout(() => reject(new Error('Stop receipt unavailable')), ms); })]));
          // A late response is still timed out. Retain its accounting and stop
          // receipt without accepting output, retrying or enabling more work.
          record.usage = result.usage; record.transportEvidence = result.transportEvidence ?? null;
          record.accountedInputTokens = Math.max(inputTokens, result.usage?.inputTokens ?? 0);
          record.accountedOutputTokens = result.usage?.outputTokens ?? 0;
          this.blocked = 'Earlier call timed out; subsequent dispatch is disabled';
        } catch { /* Unknown usage/cleanup stays unknown; independent worker supervision remains active. */ }
        finally { if (settlementTimer) clearTimeout(settlementTimer); }
      }
    } finally {
      if (timer) clearTimeout(timer); record.elapsedMs = performance.now() - started;
    }
    this.calls.push(record); return record;
  }
  summary() {
    return { transportCalls: this.calls.filter(c => c.invoked).length, modelCalls: 0, retries: 0,
      inputTokens: this.calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0),
      outputTokens: this.calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0),
      cachedInputTokens: this.calls.reduce((n, c) => n + (c.usage?.cachedInputTokens ?? 0), 0),
      costMicrosKnownLowerBound: this.calls.reduce((n, c) => n + (c.usage?.costMicros ?? 0), 0),
      usageComplete: this.calls.filter(c => c.invoked).every(c => c.usage !== null && c.usage.costMicros !== null)
        && (!this.upstream || [this.upstream.inputTokens, this.upstream.outputTokens, this.upstream.costMicros, this.upstream.elapsedMs].every(v => v !== null)),
      standalone: { upstreamDiagnosis: this.upstream, totalCalls: this.calls.filter(c => c.invoked).length + (this.upstream?.upstreamCalls ?? 0),
        inputTokensKnownLowerBound: this.calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), this.upstream?.inputTokens ?? 0),
        outputTokensKnownLowerBound: this.calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), this.upstream?.outputTokens ?? 0),
        costMicrosKnownLowerBound: this.calls.reduce((n, c) => n + (c.usage?.costMicros ?? 0), this.upstream?.costMicros ?? 0),
        budgetBlocker: this.blocked },
      elapsedMs: performance.now() - this.started,
      failures: this.calls.filter(c => c.status !== 'completed').length,
      accounting: 'authored transport usage declarations; UTF-8-byte conservative fixture token ceiling; no actual model inference' };
  }
}

export type ProposalDisposition = 'frozen_reference' | 'changed' | 'retained' | 'abstained' | 'context_requested'
  | 'schema_invalid' | 'policy_invalid' | 'failed' | 'not_run';
const failureReason = (call: CallRecord) => call.status === 'completed' ? null
  : call.status === 'budget_exhausted' ? 'not_run_budget_exhausted' : call.status;
function pairedDifferences(runs: { arm: Arm; metrics: ReturnType<typeof scoreFuture> }[]) {
  return (['U', 'M'] as const).map(other => {
    const hard = runs.find(r => r.arm === 'H')!.metrics, baseline = runs.find(r => r.arm === other)!.metrics;
    const difference = (a: number | null, b: number | null) => a === null || b === null ? null : a - b;
    return { contrast: `H-${other}`, positiveRecall: difference(hard.positiveRecall.value, baseline.positiveRecall.value),
      legalFalseAlarmRate: difference(hard.legalFalseAlarmRate.value, baseline.legalFalseAlarmRate.value),
      strictLegalResolution: difference(hard.strictLegalResolution.value, baseline.strictLegalResolution.value),
      gainedPositiveTargets: hard.rows.filter(r => r.label === 'violation' && r.detected && !baseline.rows.find(b => b.targetId === r.targetId)!.detected).map(r => r.targetId),
      lostPositiveTargets: baseline.rows.filter(r => r.label === 'violation' && r.detected && !hard.rows.find(h => h.targetId === r.targetId)!.detected).map(r => r.targetId) };
  });
}

/** One already-frozen episode and diagnosis condition. No inference, retrieval, annotation, storage or activation. */
export async function runMatchedRevision(input: {
  mode: 'authored_fixture' | 'production'; packet: FrozenPacket; future: FrozenFuture; transport?: AuthoredTransport;
  native?: NativeMatchedExecution;
}) {
  // Production is deliberately not enabled by a JSON flag, injected callback, environment variable or default backend.
  if (input.mode !== 'authored_fixture') return { execution: 'not_run' as const, modelExecution: 'not_run' as const,
    reason: 'production_adapter_unconfigured' as const, arms: [] };
  const transport = input.native?.transport ?? input.transport;
  if (!transport || transport.kind !== 'authored-test-no-model') return { execution: 'not_run' as const,
    modelExecution: 'not_run' as const, reason: 'authored_transport_required' as const, arms: [] };
  if (input.native && !isAuthoredCodexNativeMatchedTransport(input.native.transport)) return { execution: 'not_run' as const,
    modelExecution: 'not_run' as const, reason: 'authored_native_sdk_transport_required' as const, arms: [] };
  const native = input.native ? { ...input.native, configuration: validateSdkNativeConfiguration(input.native.configuration) } : undefined;
  if (native && (!Number.isSafeInteger(native.repetition) || native.repetition < 1 || native.repetition > native.configuration.scheduling.repetitions)) {
    throw new Error('Native repetition is outside the declared schedule');
  }
  const nativeConfig = native?.configuration;
  const manifest = native?.schedule ? validateSdkNativeSchedule(native.schedule.manifest, native.configuration) : undefined;
  const scheduled = manifest ? validateSdkNativeScheduledInput(
    manifest, native!.schedule!.blockId,
    { packet: input.packet, future: input.future, repetition: native!.repetition }) : undefined;
  const { episode: suppliedEpisode, cases: validatedCases, prepared } = validatePacket(input.packet, input.future, nativeConfig ? {
    renderedPersistentStateBytes: nativeConfig.limits.renderedPersistentStateBytes, model: nativeConfig.roles.proposal.model,
    maxOutputBytes: nativeConfig.limits.answerBytes.proposal, timeoutMs: nativeConfig.limits.deadlineMsPerCall } : undefined);
  const scheduledDiagnosis = manifest?.counting.diagnosis === 'authored-sdk-once-per-inferred-block';
  if (native?.diagnosis && manifest && !scheduledDiagnosis) throw new Error('Diagnosis execution differs from the frozen schedule');
  const diagnosisStage = native && suppliedEpisode.diagnosis.condition === 'inferred' && (native.diagnosis || scheduledDiagnosis)
    ? await runAuthoredSdkNativeDiagnosis({ episode: suppliedEpisode, prepared, blockId: scheduled?.blockId ?? suppliedEpisode.id,
      execution: { ...native, diagnosis: SDK_NATIVE_AUTHORED_DIAGNOSIS } }) : null;
  if (diagnosisStage) native!.observeDiagnosis?.(diagnosisStage);
  // Keep the original pre-output packet identity. The separately identified
  // locked outcome is supervision, never a rewritten source packet or freeze.
  const episode = diagnosisStage ? freeze({ ...suppliedEpisode, diagnosis: diagnosisStage.sharedDiagnosis }) : suppliedEpisode;
  const cases = scheduled ? scheduled.futureTargetOrder.map(id => validatedCases.find(c => c.input.id === id)!) : validatedCases;
  const packetDigest = input.packet.digest, futureDigest = input.future.digest;
  const commonBlock = commonRevisionBlock(episode, prepared, nativeConfig ?? episode.settings), commonRevisionInputDigest = digestOf(commonBlock);
  const runs = [];
  for (const arm of scheduled?.armOrder ?? episode.settings.armOrder) {
    const ledger = native ? new SdkNativeLedger(native, scheduled?.blockId ?? episode.id, arm, arm === 'F' ? null : episode.diagnosis.provenance,
      arm === 'F' ? undefined : diagnosisStage?.allocation)
      : new Ledger(episode.settings, input.transport!, arm === 'F' ? null : episode.diagnosis.provenance);
    const incumbent = arm === 'M' ? initialMemory(prepared) : initialStructured(prepared);
    let proposal: Proposal | null = null, disposition: ProposalDisposition = 'frozen_reference', proposalError: string | null = null;
    let proposalCall: CallRecord | null = null;
    if (arm !== 'F') {
      proposalCall = await ledger.call(nativeConfig ? nativeProposalRequest(arm, commonBlock, nativeConfig)
        : proposalRequest(arm, commonBlock, episode.settings), Buffer.byteLength(renderState(incumbent), 'utf8'));
      if (proposalCall.status !== 'completed') disposition = proposalCall.invoked ? 'failed' : 'not_run';
      else if (!ProposalSchema.safeParse(proposalCall.output).success) disposition = 'schema_invalid';
      else {
        try {
          proposal = validateProposal(proposalCall.output, arm, episode, prepared, nativeConfig?.limits.renderedPersistentStateBytes);
          disposition = { revise: 'changed', retain: 'retained', abstain: 'abstained', request_context: 'context_requested' }[proposal.action] as ProposalDisposition;
        } catch (error) { disposition = 'policy_invalid'; proposalError = errorText(error); }
      }
    }
    const gateState = proposal?.state ?? incumbent;
    const gateCall = await ledger.call(nativeConfig ? nativeReviewRequest('gate', gateState, episode.gate.map(g => g.input), nativeConfig)
      : reviewRequest('gate', gateState, episode.gate.map(g => g.input), episode.settings), Buffer.byteLength(renderState(gateState), 'utf8'));
    const gatePredictions = observations(episode.gate.map(g => g.input), gateCall.output, failureReason(gateCall));
    const gate = evaluateGate(episode.gate, gatePredictions);
    const acceptedChange = disposition === 'changed' && gate.passed;
    const effectiveState: PersistentState = acceptedChange ? proposal!.state! : incumbent;
    const futureCall = await ledger.call(nativeConfig ? nativeReviewRequest('future', effectiveState, cases.map(c => c.input), nativeConfig)
      : reviewRequest('future', effectiveState, cases.map(c => c.input), episode.settings), Buffer.byteLength(renderState(effectiveState), 'utf8'));
    const futurePredictions = observations(cases.map(c => c.input), futureCall.output, failureReason(futureCall));
    runs.push({ arm, condition: episode.diagnosis.condition, commonRevisionInputDigest,
      sharedDiagnosisDigest: digestOf(episode.diagnosis), proposalSlotsScheduled: arm === 'F' ? 0 : 1,
      proposalSlotsUsed: arm === 'F' ? 0 : 1, actualChangedCandidates: disposition === 'changed' ? 1 : 0,
      disposition, proposalError, proposal, acceptedChange, contextRequestFulfilled: false,
      reviewRepairExecuted: false, incumbentStateDigest: digestOf(incumbent),
      submittedStateDigest: proposal?.state ? digestOf(proposal.state) : null,
      gateStateDigest: digestOf(gateState), effectiveStateDigest: digestOf(effectiveState), effectiveState,
      persistentReviewBytesDigest: digestOf(renderState(effectiveState)),
      gate: { ...gate, observations: gatePredictions, callDigest: digestOf(gateCall) },
      future: futurePredictions, metrics: scoreFuture(cases, futurePredictions), calls: ledger.calls, usage: ledger.summary() });
  }
  const report = { schemaVersion: 1, kind: 'matched-revision-fixture-report', execution: 'completed' as const,
    modelExecution: 'not_run' as const, empiricalEpisodes: 0, independentHumanAnnotations: 0,
    packetDigest, futureDigest, episodeId: episode.id,
    condition: episode.diagnosis.condition, sharedDiagnosis: episode.diagnosis,
    diagnosisCost: { allocation: diagnosisStage
      ? 'One shared authored diagnosis slot; observed physical SDK count retained once; identical standalone SDK-call/time/raw-usage allocation to each U/H/M; monetary cost remains unknown'
      : 'shared cached upstream cost once; equivalent standalone cost charged to each U/H/M budget, with no repeated inference', ...episode.diagnosis.provenance },
    ...(diagnosisStage ? { diagnosisStage } : {}),
    ...(nativeConfig ? { nativeProfile: { configuration: nativeConfig, configurationDigest: digestOf(nativeConfig),
      repetition: native!.repetition, scope: diagnosisStage ? 'authored shared diagnosis-only stage and matched block; no model inference or construction'
        : scheduled ? 'manifest-bound supplied authored block; construction/diagnosis not executed'
        : 'single supplied authored block; construction/diagnosis and repeated scheduling not executed',
      ...(scheduled ? { scheduleDigest: manifest!.digest, blockId: scheduled.blockId,
        armOrder: scheduled.armOrder, futureTargetOrder: scheduled.futureTargetOrder } : {}),
      operationalAdmission: 'not_evaluated', declaredPinsVerified: false, declaredScheduleDigestsVerified: !!scheduled } } : {}),
    transport: { id: transport.id, kind: transport.kind,
      ...(transport.capabilities ? { capabilities: transport.capabilities } : {}) },
    boundaries: ['Authored mechanics only; no real model, real temporal cohort or human assessment',
      'Memory is a local-delta protocol adapter, not a validated competent external system',
      'Byte/digest checks do not establish chronology, isolation, label truth or citation sufficiency',
      'No hypothesis test, population estimate, automatic rule activation or W0/W1/W2 study freeze'],
    pairedDifferences: pairedDifferences(runs), arms: runs };
  return freeze({ ...report, digest: digestOf(report) });
}

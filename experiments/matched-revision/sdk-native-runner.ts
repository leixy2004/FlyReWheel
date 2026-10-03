import { z } from 'zod';
import { canonicalJson, digestOf } from '../../src/core/identity.js';
import { freeze } from '../../src/workspace/execution-receipt.js';
import { SdkNativeMatchedRequestSchema, type SdkNativeMatchedRequest } from '../../src/core/matched-revision-model.js';
import { isAuthoredCodexNativeMatchedTransport, type AuthoredCodexNativeMatchedTransport } from '../../src/adapters/matched-revision-codex.js';
import { ProposalSchema, ReviewSchema, type Arm, type ModelRequest, type PersistentState, type SharedDiagnosis, type TargetInput } from './contracts.js';
import { proposalPrompt, reviewPrompt } from './prompts.js';
import { SDK_NATIVE_PROFILE_VERSION, type SdkNativeCallRecord, type SdkNativeConfiguration } from './sdk-native-contracts.js';
import { validateSdkNativeCallRecord } from './sdk-native-validation.js';
import type { CallRecord } from './runner.js';
import type { SdkNativeSchedule } from './sdk-native-schedule.js';
import type { AuthoredSdkNativeDiagnosisRecord } from './sdk-native-diagnosis.js';

export interface NativeMatchedExecution {
  configuration: SdkNativeConfiguration; repetition: number; transport: AuthoredCodexNativeMatchedTransport;
  schedule?: { manifest: SdkNativeSchedule; blockId: string };
  /** Audit hook only; the study driver retains records even on interruption. */
  observeCall?: (arm: Arm, record: CallRecord) => void;
  observeDiagnosis?: (record: AuthoredSdkNativeDiagnosisRecord) => void | Promise<void>;
  /** Awaited durable boundaries. Intent commits before any possible dispatch. */
  checkpoint?: {
    beforeCall: (arm: Arm | null, callId: string, requestDigest: string) => Promise<void>;
    afterCall: (arm: Arm | null, record: CallRecord) => Promise<void>;
  };
  /** Explicit authored-only stage; absence preserves supplied-diagnosis behavior. */
  diagnosis?: 'authored-once-per-episode-repeat';
}
export interface NativeDiagnosisAllocation {
  recordDigest: string; elapsedMs: number; sdkInvocations: number; blocker: string | null;
  rawUsage: SdkNativeCallRecord['observations']['rawUsage'];
  cost: SdkNativeCallRecord['observations']['cost'];
}
export function nativeProposalRequest(arm: Exclude<Arm, 'F'>, commonBlock: string, config: SdkNativeConfiguration): SdkNativeMatchedRequest {
  return { profile: SDK_NATIVE_PROFILE_VERSION, stage: 'proposal', ...config.roles.proposal,
    prompt: proposalPrompt(arm, commonBlock), outputSchema: z.toJSONSchema(ProposalSchema) };
}
export function nativeReviewRequest(stage: 'gate' | 'future', state: PersistentState, targets: TargetInput[], config: SdkNativeConfiguration): SdkNativeMatchedRequest {
  return { profile: SDK_NATIVE_PROFILE_VERSION, stage, ...config.roles.review,
    prompt: reviewPrompt(state, targets), outputSchema: z.toJSONSchema(ReviewSchema) };
}
const unknownUsage = () => ({ input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null,
  output_tokens: null, reasoning_output_tokens: null });

/** The existing matched loop owns proposal policy, gate decisions and every
 * target row. This ledger replaces only request/call accounting for that loop. */
export class SdkNativeLedger {
  readonly calls: CallRecord[] = [];
  private readonly started = performance.now();
  private blocked: string | null = null;
  private attempts = 0;
  private readonly roleAttempts = { diagnosis: 0, proposal: 0, review: 0 };
  constructor(private readonly execution: NativeMatchedExecution, private readonly blockId: string,
    private readonly arm: Arm | null, private readonly upstream: SharedDiagnosis['provenance'] | null,
    private readonly allocation?: NativeDiagnosisAllocation) {
    if (!isAuthoredCodexNativeMatchedTransport(execution.transport)) throw new Error('Native execution requires an import-created authored SDK transport');
    if (allocation) this.blocked = allocation.blocker;
    else if (upstream && (upstream.origin !== 'authored_fixture' || upstream.upstreamCalls !== 0 || upstream.upstreamModel !== null
      || upstream.elapsedMs === null || upstream.rawFailure !== null)) {
      this.blocked = 'Native authored slice requires a supplied authored diagnosis with zero upstream model calls and known elapsed time';
    }
  }
  async call(rawRequest: ModelRequest | SdkNativeMatchedRequest, persistentStateBytes = 0): Promise<CallRecord> {
    const started = performance.now(), request = freeze(structuredClone(rawRequest)) as SdkNativeMatchedRequest;
    const requestShape = SdkNativeMatchedRequestSchema.safeParse(request);
    const { configuration: config, repetition, transport } = this.execution, limits = config.limits;
    const role = request.stage === 'diagnosis' ? 'diagnosis' : request.stage === 'proposal' ? 'proposal' : 'review';
    if ((role === 'diagnosis') !== (this.arm === null)) throw new Error('Diagnosis must be one shared call, never an arm call');
    if (digestOf({ model: request.model, ...(request.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: request.modelReasoningEffort }) })
      !== digestOf(config.roles[role])) throw new Error('Native request changes shared role settings');
    const requestBytes = Buffer.byteLength(canonicalJson(request), 'utf8');
    const schemaBytes = Buffer.byteLength(canonicalJson(request.outputSchema), 'utf8');
    const record: CallRecord = { stage: request.stage, requestDigest: digestOf(request), request,
      status: 'budget_exhausted', error: null, invoked: false, output: null, outputDigest: null, usage: null,
      elapsedMs: 0, transportEvidence: null, startedAt: new Date().toISOString() };
    const native: SdkNativeCallRecord = {
      schemaVersion: 1, kind: 'matched-revision-sdk-native-call-record', profileVersion: SDK_NATIVE_PROFILE_VERSION,
      executionKind: 'authored_sdk_no_model', configurationDigest: digestOf(config),
      callId: digestOf([this.blockId, repetition, this.arm, request.stage]), blockId: this.blockId, repetition, role, arm: this.arm,
      status: 'not_dispatched', requestedSettings: config.roles[role], appliedSettings: null,
      launchSettingsReceiptDigest: null, effectiveConfigurationEvidenceDigest: null,
      monetaryAdmission: { status: 'not_evaluated' }, enforcement: { status: 'not_started' },
      observations: { serializedRequestBytes: requestBytes, outputSchemaBytes: schemaBytes,
        renderedPersistentStateBytes: persistentStateBytes, answerBytes: null,
        stdoutBytes: null, stderrBytes: null, forwardedEventBytes: null, setupMs: null, executionMs: null, cleanupMs: null,
        sdkInvocations: 0, providerCalls: 0, roleDispatchedAttempts: this.roleAttempts[role],
        armDispatchedAttempts: this.arm === null ? null : this.attempts + (this.allocation?.sdkInvocations ?? 0),
        armProviderCalls: this.arm === null ? null : 0, armElapsedMsIncludingSharedDiagnosis: null, rawUsage: unknownUsage(),
        cost: { status: 'unknown', costMicros: null, currency: null } },
      isolationEvidence: { sdkPolicyDigest: null, applicationChecksDigest: null, externalRuntimeEvidenceDigest: null,
        processGroupStopped: null, wholeRuntimeDestroyed: null, remoteGenerationStopped: null }, failure: null,
    };
    const remainingTime = this.arm === null ? limits.deadlineMsPerCall
      : limits.elapsedMsPerArm - (performance.now() - this.started) - (this.allocation?.elapsedMs ?? this.upstream?.elapsedMs ?? 0);
    const preflightFailure = this.blocked ?? (!requestShape.success ? 'Native request shape/size rejected before dispatch' : null)
      ?? (requestBytes > limits.serializedRequestBytes || schemaBytes > limits.outputSchemaBytes
      || persistentStateBytes > limits.renderedPersistentStateBytes || this.roleAttempts[role] >= limits.dispatchedAttemptsPerRole[role]
      || (this.arm !== null && this.attempts + (this.allocation?.sdkInvocations ?? 0) >= limits.dispatchedAttemptsPerArm)
      || remainingTime <= 0 ? 'Native byte/call/time budget exhausted before dispatch' : null);
    if (preflightFailure) { record.error = preflightFailure; native.failure = preflightFailure; }
    else {
      await this.execution.checkpoint?.beforeCall(this.arm, native.callId, record.requestDigest);
      const controller = new AbortController(), allowedMs = Math.min(limits.deadlineMsPerCall, remainingTime);
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(allowedMs)));
      const bridgeStarted = performance.now();
      // A stricter combined-stream ceiling also bounds forwarded/event bytes.
      // Worker-envelope overhead is additionally checked by the worker itself.
      const result = await transport.execute(request, { maxInputBytes: limits.serializedRequestBytes,
        maxOutputBytes: Math.min(limits.combinedStdoutStderrBytes, limits.forwardedEventBytes),
        maxArtifactBytes: 1, maxArtifacts: 0, timeoutMs: Math.max(1, Math.floor(allowedMs)), cleanupTimeoutMs: limits.cleanupTimeoutMs }, controller.signal)
        .finally(() => clearTimeout(timer));
      const observed = native.observations, evidence = result.processEvidence;
      record.invoked = result.observations.sdkInvocations === 1;
      if (record.invoked) { this.attempts++; this.roleAttempts[role]++; }
      Object.assign(observed, result.observations, { setupMs: result.observations.setupMs + Math.ceil(bridgeStarted - started),
        roleDispatchedAttempts: this.roleAttempts[role],
        armDispatchedAttempts: this.arm === null ? null : this.attempts + (this.allocation?.sdkInvocations ?? 0),
        stdoutBytes: evidence?.stdoutBytes ?? null, stderrBytes: evidence?.stderrBytes ?? null,
        forwardedEventBytes: evidence?.forwardedBytes ?? null, rawUsage: result.rawUsage });
      record.transportEvidence = { adapter: 'authored-codex-sdk', sdkVersion: '0.159.2', controls: 'not-enforced-authored-script',
        modelCalls: 0, sessionId: result.sessionId, processEvidence: evidence, rawUsage: result.usage,
        cleanup: result.cleanupVerified ? 'verified' : record.invoked ? 'unverified' : 'not_started' };
      if (record.invoked) {
        native.launchSettingsReceiptDigest = digestOf({ request, processEvidence: evidence, sessionId: result.sessionId,
          meaning: 'Settings forwarded to authored SDK executable; no backend acceptance' });
        native.isolationEvidence = { ...native.isolationEvidence,
          sdkPolicyDigest: digestOf({ tools: 'selected-evidence-no-tools-v1', history: 'all-local-refs-v1', freshThread: true }),
          applicationChecksDigest: digestOf({ requestBytes, schemaBytes, persistentStateBytes, limits }),
          processGroupStopped: evidence?.processGroupStopped ?? null };
        native.enforcement = { status: 'unverified', detail: 'Authored process observations retained; no operational admission or external runtime verification' };
      }
      const elapsed = Math.ceil(performance.now() - started);
      const timedOut = controller.signal.aborted || elapsed > allowedMs;
      const exceeded = (observed.answerBytes !== null && observed.answerBytes > limits.answerBytes[role])
        || (observed.cleanupMs !== null && observed.cleanupMs > limits.cleanupTimeoutMs)
        || (observed.stdoutBytes !== null && observed.stderrBytes !== null
          && observed.stdoutBytes + observed.stderrBytes > limits.combinedStdoutStderrBytes)
        || (observed.forwardedEventBytes !== null && observed.forwardedEventBytes > limits.forwardedEventBytes)
        || evidence?.reason === 'output-limit';
      record.status = timedOut ? 'timeout' : result.status === 'failed' ? 'failed' : exceeded ? 'invalid_output' : 'completed';
      record.error = timedOut ? 'Native call/arm deadline exceeded, including setup and cleanup'
        : result.error ?? (exceeded ? 'Native answer/stream/cleanup ceiling exceeded' : null);
      if (!record.invoked) { native.status = 'not_dispatched'; record.status = 'failed'; }
      else native.status = timedOut ? 'cancelled' : record.status === 'completed' ? 'authored_completed' : 'failed';
      if (record.status === 'completed') { record.output = result.output; record.outputDigest = digestOf(result.output); }
      native.failure = record.error;
      if (record.invoked && (!result.cleanupVerified || Object.values(result.rawUsage).some(v => v === null) || timedOut || exceeded)) {
        this.blocked = 'Earlier native call has unknown usage, unverified cleanup or exceeded bounds; no further dispatch in this arm';
      }
    }
    record.elapsedMs = performance.now() - started;
    native.observations.armElapsedMsIncludingSharedDiagnosis = this.arm === null || (!this.allocation && this.upstream?.elapsedMs === null) ? null
      : Math.ceil(performance.now() - this.started) + (this.allocation?.elapsedMs ?? this.upstream?.elapsedMs ?? 0);
    if (native.status === 'not_dispatched') native.observations.setupMs ??= Math.ceil(record.elapsedMs);
    // Rounding phase clocks conservatively can add a few milliseconds. A bound
    // violation is a retained failure, never a missing roster row or late answer.
    if (native.status === 'authored_completed') {
      const o = native.observations;
      if (this.arm !== null) o.armElapsedMsIncludingSharedDiagnosis = Math.max(o.armElapsedMsIncludingSharedDiagnosis!, o.setupMs! + o.executionMs! + o.cleanupMs!);
      if (o.setupMs! + o.executionMs! + o.cleanupMs! > limits.deadlineMsPerCall
        || (this.arm !== null && o.armElapsedMsIncludingSharedDiagnosis! > limits.elapsedMsPerArm)) {
        native.status = 'failed'; native.failure = record.error = 'Native elapsed ceiling exceeded';
        record.status = 'timeout'; record.output = null; record.outputDigest = null; this.blocked = native.failure;
      }
    }
    if (native.status === 'authored_completed') native.enforcement = { status: 'authored_supervised', limitsDigest: digestOf(limits),
      enforcementEvidenceDigest: digestOf({ observations: native.observations, processEvidence: record.transportEvidence?.processEvidence ?? null }) };
    record.nativeRecord = validateSdkNativeCallRecord(native, config);
    record.finishedAt = new Date().toISOString();
    await this.execution.checkpoint?.afterCall(this.arm, freeze(structuredClone(record)));
    this.calls.push(record);
    if (this.arm !== null) this.execution.observeCall?.(this.arm, freeze(structuredClone(record)));
    return record;
  }
  summary() {
    return { transportCalls: this.attempts, modelCalls: 0, retries: 0,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, costMicrosKnownLowerBound: null, usageComplete: false,
      standalone: { upstreamDiagnosis: this.upstream, sharedDiagnosisAllocation: this.allocation ?? null,
        totalCalls: this.attempts + (this.allocation?.sdkInvocations ?? this.upstream?.upstreamCalls ?? 0),
        inputTokensKnownLowerBound: null, outputTokensKnownLowerBound: null, costMicrosKnownLowerBound: null,
        budgetBlocker: this.blocked }, elapsedMs: performance.now() - this.started,
      failures: this.calls.filter(c => c.status !== 'completed').length,
      accounting: 'Authored SDK invocations only; zero provider/model calls; raw token fields retained per call without totals; monetary cost unknown' };
  }
}

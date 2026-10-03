import { describe, expect, it, vi } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { CODEX_MODEL_REASONING_EFFORTS } from '../src/core/codex-model-settings.js';
import { MatchedModelRequestSchema } from '../src/core/matched-revision-model.js';
import { enforceMatchedCodexExecution, MatchedCodexExecutionSchema, preflightMatchedCodexControls } from '../src/workspace/matched-codex-policy.js';
import { SettingsSchema } from '../experiments/matched-revision/contracts.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import { validatePacket } from '../experiments/matched-revision/validation.js';
import { SDK_NATIVE_PROFILE_VERSION, SdkNativeConfigurationSchema, SdkNativeObservedCostSchema,
  type SdkNativeCallRecord, type SdkNativeConfiguration } from '../experiments/matched-revision/sdk-native-contracts.js';
import { validateSdkNativeCallRecord, validateSdkNativeConfiguration } from '../experiments/matched-revision/sdk-native-validation.js';

const digest = digestOf('authored contract-test evidence only; not a runtime or authorization');
function configuration(): SdkNativeConfiguration {
  const unsupported = { availability: 'unsupported_in_pinned_typed_sdk' as const };
  return {
    schemaVersion: 1, kind: 'matched-revision-sdk-native-configuration', profileVersion: SDK_NATIVE_PROFILE_VERSION,
    runtimePins: { sdk: '@openai/codex-sdk', sdkVersion: '0.159.2', cliVersion: 'authored-test-pin',
      providerRoute: 'authored-test-route', sdkDeclarationDigest: digest, runtimeDigest: digest, configurationDigest: digest },
    roles: { construction: { model: 'authored-construction' }, diagnosis: { model: 'authored-diagnosis', modelReasoningEffort: 'high' },
      proposal: { model: 'authored-proposal' }, review: { model: 'authored-review', modelReasoningEffort: 'low' } },
    generationControls: { temperature: unsupported, generationSeed: unsupported, maxOutputTokens: unsupported },
    scheduling: { schedulingSeed: 0, seedPurpose: 'assignment_and_order_only', repetitions: 2,
      algorithm: 'authored-schedule-for-contract-tests', algorithmDigest: digest, blockRosterDigest: digest, targetScheduleDigest: digest },
    limits: { serializedRequestBytes: 10_000, outputSchemaBytes: 1000, renderedPersistentStateBytes: 1000,
      answerBytes: { construction: 1000, diagnosis: 1000, proposal: 1000, review: 1000 },
      combinedStdoutStderrBytes: 5000, forwardedEventBytes: 4000, deadlineMsPerCall: 1000, cleanupTimeoutMs: 100,
      dispatchedAttemptsPerRole: { construction: 1, diagnosis: 1, proposal: 1, review: 3 },
      dispatchedAttemptsPerArm: 5, providerCallsPerArm: 5, elapsedMsPerArm: 5000 },
    countingRules: { serialization: 'canonical-json-utf8-v1', persistentState: 'rendered-utf8-including-initial-lesson-delta-and-overhead',
      attempt: 'every-dispatch-including-failure-invalid-abstention', elapsed: 'setup-execution-cleanup-and-allocated-shared-diagnosis',
      providerInternalCalls: 'disabled', retries: 0, freshThreadPerCall: true, outputCacheReuse: false },
    monetaryPolicy: { kind: 'hard_ceiling', currency: 'USD', maxCostMicros: 10_000, scope: 'whole_study_including_in_flight' },
  };
}
function record(config = configuration()): SdkNativeCallRecord {
  return { schemaVersion: 1, kind: 'matched-revision-sdk-native-call-record', profileVersion: SDK_NATIVE_PROFILE_VERSION,
    configurationDigest: digestOf(config), callId: 'authored-call', blockId: 'authored-block', repetition: 1, role: 'proposal', arm: 'U',
    status: 'completed', requestedSettings: { ...config.roles.proposal }, appliedSettings: { ...config.roles.proposal },
    launchSettingsReceiptDigest: digest, effectiveConfigurationEvidenceDigest: digest,
    monetaryAdmission: { status: 'external_admission_recorded', mode: 'hard_ceiling', authorizationEvidenceDigest: digest,
      mechanismEvidenceDigest: digest, inFlightReservationEvidenceDigest: digest, stopAndOvershootPolicyDigest: digest,
      currency: 'USD', maxCostMicros: 10_000 },
    enforcement: { status: 'reported_enforced', limitsDigest: digestOf(config.limits), enforcementEvidenceDigest: digest },
    observations: { serializedRequestBytes: 500, outputSchemaBytes: 200, renderedPersistentStateBytes: 100, answerBytes: 200,
      stdoutBytes: 500, stderrBytes: 10, forwardedEventBytes: 300, setupMs: 10, executionMs: 50, cleanupMs: 10,
      sdkInvocations: 1, providerCalls: 1, roleDispatchedAttempts: 1, armDispatchedAttempts: 1, armProviderCalls: 1,
      armElapsedMsIncludingSharedDiagnosis: 70,
      rawUsage: { input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null, output_tokens: null, reasoning_output_tokens: null },
      cost: { status: 'unknown', costMicros: null, currency: null } },
    isolationEvidence: { sdkPolicyDigest: digest, applicationChecksDigest: digest, externalRuntimeEvidenceDigest: null,
      processGroupStopped: true, wholeRuntimeDestroyed: null, remoteGenerationStopped: null }, failure: null };
}
function check(mutate: (r: SdkNativeCallRecord) => void) {
  const config = configuration(), r = record(config); mutate(r);
  return () => validateSdkNativeCallRecord(r, config);
}

describe('SDK-native configuration contract only', () => {
  it('separately versions inputs, keeps role settings shared, and preserves omission and scheduling seed zero', () => {
    const input = configuration(), parsed = validateSdkNativeConfiguration(input);
    expect(parsed).toEqual(input); expect(parsed.roles.proposal).not.toHaveProperty('modelReasoningEffort');
    expect(parsed.scheduling.schedulingSeed).toBe(0); expect(Object.isFrozen(parsed.roles)).toBe(true);
    expect(parsed.generationControls.generationSeed).toEqual({ availability: 'unsupported_in_pinned_typed_sdk' });
    expect(SettingsSchema.safeParse(parsed).success).toBe(false);
    expect(SdkNativeConfigurationSchema.safeParse(createMatchedFixture().packet.episode.settings).success).toBe(false);
  });
  it.each(CODEX_MODEL_REASONING_EFFORTS)('uses the shared pinned SDK effort enum: %s', effort => {
    const config = configuration(); config.roles.proposal.modelReasoningEffort = effort;
    expect(validateSdkNativeConfiguration(config).roles.proposal.modelReasoningEffort).toBe(effort);
  });
  it.each([null, 'none', 'default', '', 0, undefined])('rejects invalid or non-JSON explicit effort %s', effort => {
    const config: any = configuration(); config.roles.proposal.modelReasoningEffort = effort;
    expect(() => validateSdkNativeConfiguration(config)).toThrow();
  });
  it.each(['temperature', 'generationSeed', 'maxOutputTokens'] as const)('cannot represent %s as requested/applied/enforced', control => {
    for (const extra of [{ requested: 0 }, { applied: 0 }, { value: 0 }, { enforced: true }, { requested: null }]) {
      const config: any = configuration(); Object.assign(config.generationControls[control], extra);
      expect(() => validateSdkNativeConfiguration(config)).toThrow();
    }
  });
  it.each(['sampler', 'seed', 'maxOutputTokens', 'tokenizer', 'armSettings', 'modelsAndSamplerConfigDigest', 'seedRosterDigest'])('rejects old or arm-specific field %s', key => {
    expect(() => validateSdkNativeConfiguration({ ...configuration(), [key]: 1 })).toThrow();
  });
  it.each([
    (c: any) => { c.roles.proposal.temperature = 0; },
    (c: any) => { c.scheduling.seedPurpose = 'model_generation'; },
    (c: any) => { c.scheduling.schedulingSeed = -1; },
    (c: any) => { c.scheduling.repetitions = 0; },
    (c: any) => { c.limits.dispatchedAttemptsPerRole.proposal = 2; },
    (c: any) => { c.limits.dispatchedAttemptsPerRole.diagnosis = 2; },
    (c: any) => { c.limits.deadlineMsPerCall = 300_001; },
    (c: any) => { c.limits.serializedRequestBytes = 2_097_153; },
    (c: any) => { c.limits.maxOutputTokens = 1000; },
    (c: any) => { c.countingRules.retries = 1; },
    (c: any) => { c.countingRules.outputCacheReuse = true; },
    (c: any) => { c.runtimePins.sdkVersion = 'future-unverified-sdk'; },
  ])('rejects unsupported or unsafe configuration variant %#', mutate => {
    const config = configuration(); mutate(config); expect(() => validateSdkNativeConfiguration(config)).toThrow();
  });
});

describe('SDK-native record consistency, not execution authority', () => {
  it('retains unknown tokens and cost, and distinguishes process stop from external/remote isolation', () => {
    const parsed = validateSdkNativeCallRecord(record(), configuration());
    expect(Object.values(parsed.observations.rawUsage)).toEqual([null, null, null, null, null]);
    expect(parsed.observations.cost).toEqual({ status: 'unknown', costMicros: null, currency: null });
    expect(parsed.isolationEvidence).toMatchObject({ processGroupStopped: true, externalRuntimeEvidenceDigest: null,
      wholeRuntimeDestroyed: null, remoteGenerationStopped: null });
    expect(Object.isFrozen(parsed.observations)).toBe(true);
  });
  it('retains partial raw usage without summing overlapping fields or treating absent fields as zero', () => {
    const r = record(); r.observations.rawUsage = { input_tokens: 10, cached_input_tokens: 8,
      cache_write_input_tokens: null, output_tokens: 4, reasoning_output_tokens: 3 };
    expect(validateSdkNativeCallRecord(r, configuration()).observations.rawUsage).toEqual(r.observations.rawUsage);
    const bad: any = structuredClone(r); delete bad.observations.rawUsage.output_tokens;
    expect(() => validateSdkNativeCallRecord(bad, configuration())).toThrow();
    bad.observations.rawUsage.output_tokens = Number.MAX_SAFE_INTEGER + 1;
    expect(() => validateSdkNativeCallRecord(bad, configuration())).toThrow();
  });
  it('keeps authoritative billing, estimates and unknown cost distinct', () => {
    expect(SdkNativeObservedCostSchema.safeParse({ status: 'unknown', costMicros: 0, currency: 'USD' }).success).toBe(false);
    expect(SdkNativeObservedCostSchema.safeParse({ status: 'authoritative_billing', costMicros: 1, currency: 'USD' }).success).toBe(false);
    const r = record(); r.observations.cost = { status: 'estimate', costMicros: 5, currency: 'USD', assumptionsDigest: digest };
    expect(validateSdkNativeCallRecord(r, configuration()).observations.cost.status).toBe('estimate');
    r.observations.cost = { status: 'authoritative_billing', costMicros: 5, currency: 'USD', billingRecordDigest: digest };
    expect(validateSdkNativeCallRecord(r, configuration()).observations.cost.status).toBe('authoritative_billing');
  });
  it.each(['F', 'U', 'H', 'M'] as const)('requires the same review configuration for arm %s', arm => {
    const config = configuration(), r = record(config); r.role = 'review'; r.arm = arm;
    r.requestedSettings = { ...config.roles.review }; r.appliedSettings = { ...config.roles.review };
    expect(validateSdkNativeCallRecord(r, config).requestedSettings).toEqual(config.roles.review);
    r.requestedSettings.modelReasoningEffort = 'high'; r.appliedSettings = { ...r.requestedSettings };
    expect(() => validateSdkNativeCallRecord(r, config)).toThrow('shared configuration');
  });
  it.each([
    [(r: any) => { r.configurationDigest = digest; }, 'configuration digest'],
    [(r: any) => { r.repetition = 3; }, 'frozen schedule'],
    [(r: any) => { r.arm = 'F'; }, 'role/arm'],
    [(r: any) => { r.requestedSettings.model = 'other'; }, 'shared configuration'],
    [(r: any) => { r.appliedSettings.model = 'other'; }, 'applied settings'],
    [(r: any) => { r.appliedSettings.modelReasoningEffort = 'high'; }, 'applied settings'],
    [(r: any) => { r.launchSettingsReceiptDigest = null; }, 'configuration evidence'],
    [(r: any) => { r.enforcement = { status: 'unverified', detail: 'No trusted evidence' }; }, 'enforcement record'],
    [(r: any) => { r.enforcement.limitsDigest = digest; }, 'frozen limits'],
    [(r: any) => { r.observations.serializedRequestBytes = 10_001; }, 'request bytes'],
    [(r: any) => { r.observations.outputSchemaBytes = 1001; }, 'schema bytes'],
    [(r: any) => { r.observations.renderedPersistentStateBytes = 1001; }, 'persistent-state bytes'],
    [(r: any) => { r.observations.answerBytes = 1001; }, 'answer bytes'],
    [(r: any) => { r.observations.stderrBytes = 4501; }, 'stdout/stderr bytes'],
    [(r: any) => { r.observations.forwardedEventBytes = 4001; }, 'forwarded/event bytes'],
    [(r: any) => { r.observations.executionMs = 1000; }, 'call elapsed time'],
    [(r: any) => { r.observations.cleanupMs = 101; }, 'cleanup time'],
    [(r: any) => { r.observations.roleDispatchedAttempts = 2; r.observations.armDispatchedAttempts = 2; }, 'role attempts'],
    [(r: any) => { r.observations.armDispatchedAttempts = 6; }, 'arm attempts'],
    [(r: any) => { r.observations.armProviderCalls = 6; }, 'arm provider calls'],
    [(r: any) => { r.observations.armElapsedMsIncludingSharedDiagnosis = 5001; }, 'arm elapsed time'],
    [(r: any) => { r.observations.sdkInvocations = 2; }, 'no retries'],
    [(r: any) => { r.observations.providerCalls = 2; r.observations.armProviderCalls = 2; }, 'internal calls'],
    [(r: any) => { r.observations.providerCalls = null; }, 'provider-call accounting'],
    [(r: any) => { r.observations.answerBytes = null; }, 'answer bytes'],
  ] as const)('rejects a completed record with inconsistent settings/limits %#', (mutate, error) => {
    expect(check(mutate)).toThrow(error);
  });
  it('retains failure overshoot, missing usage and setting mismatch without classifying it as a valid answer', () => {
    const r = record(); r.status = 'failed'; r.failure = 'Late oversized answer and wrong applied model';
    r.observations.answerBytes = 1001; r.observations.executionMs = 1001; r.appliedSettings!.model = 'wrong-model';
    expect(validateSdkNativeCallRecord(r, configuration())).toEqual(r);
    r.failure = null; expect(() => validateSdkNativeCallRecord(r, configuration())).toThrow('retain its failure');
  });
  it('represents a blocked undispatched call without invented zero token/cost receipts', () => {
    const r = record(); r.status = 'not_dispatched'; r.appliedSettings = null; r.launchSettingsReceiptDigest = null;
    r.effectiveConfigurationEvidenceDigest = null; r.monetaryAdmission = { status: 'blocked', reason: 'hard_ceiling_unavailable', detail: 'No independently enforceable ceiling' };
    r.enforcement = { status: 'not_started' }; r.observations.sdkInvocations = 0; r.observations.providerCalls = null;
    r.observations.roleDispatchedAttempts = 0; r.observations.armDispatchedAttempts = 0; r.observations.answerBytes = null;
    r.observations.stdoutBytes = null; r.observations.stderrBytes = null; r.observations.forwardedEventBytes = null; r.observations.executionMs = null;
    expect(validateSdkNativeCallRecord(r, configuration()).status).toBe('not_dispatched');
    r.observations.rawUsage.output_tokens = 0;
    expect(() => validateSdkNativeCallRecord(r, configuration())).toThrow('claims execution');
  });
  it('retains failed unauthorized dispatch and provider overshoot as violations rather than dropping their accounting', () => {
    const r = record(); r.status = 'failed'; r.failure = 'Dispatch violated monetary admission and provider-call policy';
    r.monetaryAdmission = { status: 'blocked', reason: 'not_authorized', detail: 'Authorization absent' };
    r.observations.providerCalls = 2; r.observations.armProviderCalls = 2;
    expect(validateSdkNativeCallRecord(r, configuration())).toEqual(r);
    r.status = 'completed'; r.failure = null;
    expect(() => validateSdkNativeCallRecord(r, configuration())).toThrow('monetary admission');
  });
  it('records shared diagnosis once without inventing a physical arm charge', () => {
    const config = configuration(), r = record(config); r.role = 'diagnosis'; r.arm = null;
    r.requestedSettings = { ...config.roles.diagnosis }; r.appliedSettings = { ...config.roles.diagnosis };
    r.observations.armDispatchedAttempts = null; r.observations.armProviderCalls = null; r.observations.armElapsedMsIncludingSharedDiagnosis = null;
    expect(validateSdkNativeCallRecord(r, config).arm).toBeNull();
    r.observations.armProviderCalls = 1; expect(() => validateSdkNativeCallRecord(r, config)).toThrow('separate standalone allocation');
  });
  it.each(['not_evaluated', 'blocked'] as const)('cannot label an attempt completed when monetary admission is %s', status => {
    expect(check(r => { r.monetaryAdmission = status === 'not_evaluated' ? { status } : { status, reason: 'not_authorized', detail: 'Authorization absent' }; })).toThrow('monetary admission');
  });
  it('requires exact hard ceiling evidence, including reservations, currency and limit', () => {
    const r: any = record(); r.monetaryAdmission.maxCostMicros++;
    expect(() => validateSdkNativeCallRecord(r, configuration())).toThrow('hard ceiling');
    r.monetaryAdmission.maxCostMicros--; r.monetaryAdmission.currency = 'EUR';
    expect(() => validateSdkNativeCallRecord(r, configuration())).toThrow('hard ceiling');
    r.monetaryAdmission.currency = 'USD'; delete r.monetaryAdmission.inFlightReservationEvidenceDigest;
    expect(() => validateSdkNativeCallRecord(r, configuration())).toThrow();
    expect(check(r => { r.observations.cost = { status: 'authoritative_billing', costMicros: 10_001, currency: 'USD', billingRecordDigest: digest }; })).toThrow('monetary ceiling');
  });
  it('cannot substitute an exposure authorization for a hard ceiling and requires its exact policy', () => {
    const config = configuration(), r = record(config);
    r.monetaryAdmission = { status: 'external_exposure_authorization_recorded', authorizationEvidenceDigest: digest,
      stopPolicyDigest: digest, reconciliationPolicyDigest: digest };
    expect(() => validateSdkNativeCallRecord(r, config)).toThrow('exposure authorization/policy');
    config.monetaryPolicy = { kind: 'explicit_exposure_authorization_required', stopPolicyDigest: digest, reconciliationPolicyDigest: digest };
    r.configurationDigest = digestOf(config);
    expect(validateSdkNativeCallRecord(r, config).monetaryAdmission.status).toBe('external_exposure_authorization_recorded');
    r.monetaryAdmission.stopPolicyDigest = digestOf('different policy');
    expect(() => validateSdkNativeCallRecord(r, config)).toThrow('exposure authorization/policy');
  });
});

it('preserves authored packets and old unsupported-control preflight without admitting the native profile to dispatch', async () => {
  const f = createMatchedFixture(), controls = { sampler: f.packet.episode.settings.sampler, maxOutputTokens: 10 };
  expect(validatePacket(f.packet, f.future).episode).toEqual(f.packet.episode);
  expect(preflightMatchedCodexControls(controls)).toMatchObject({ supported: false,
    unsupportedControls: ['sampler.temperature', 'sampler.seed', 'maxOutputTokens'] });
  expect(() => enforceMatchedCodexExecution({ kind: 'enforce-frozen-controls', ...controls }, 'isolated-runtime')).toThrow('unsupported before dispatch');
  expect(() => enforceMatchedCodexExecution({ kind: 'authored-script-controls-not-enforced' }, 'isolated-runtime')).toThrow('authored executable boundary');
  expect(MatchedCodexExecutionSchema.safeParse(configuration()).success).toBe(false);
  expect(MatchedModelRequestSchema.safeParse(configuration()).success).toBe(false);
  const execute = vi.fn(f.transport.execute);
  expect(await runMatchedRevision({ mode: 'production', ...f, transport: { ...f.transport, execute } }))
    .toMatchObject({ execution: 'not_run', reason: 'production_adapter_unconfigured' });
  expect(execute).not.toHaveBeenCalled();
});

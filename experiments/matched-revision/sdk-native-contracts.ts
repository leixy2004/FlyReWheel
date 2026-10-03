import { z } from 'zod';
import { CodexModelReasoningEffortSchema } from '../../src/core/codex-model-settings.js';
import { DigestSchema, IdSchema } from '../../src/core/model.js';
import { CodexWorkspaceLimits } from '../../src/workspace/codex-runner.js';
import { MATCHED_CODEX_CAPABILITIES } from '../../src/workspace/matched-codex-policy.js';
import { WorkspaceWorkerUsage } from '../../src/workspace/worker-protocol.js';
import { ARMS } from './contracts.js';

/** A research configuration/receipt contract, not a worker protocol or launch permission. */
export const SDK_NATIVE_PROFILE_VERSION = 'paired-restriction-sdk-native-v1-draft';
export const SDK_NATIVE_ROLES = ['construction', 'diagnosis', 'proposal', 'review'] as const;
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Positive = Count.min(1);
const Text = z.string().min(1).max(8192).refine(s => !!s.trim(), 'Expected nonblank text');
const Currency = z.string().regex(/^[A-Z]{3}$/);

export const SdkNativeRoleSettingsSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
  // Omission is unspecified, never a guessed default or evidence of backend acceptance.
  modelReasoningEffort: CodexModelReasoningEffortSchema.optional(),
}).strict();
const UnsupportedControl = z.object({ availability: z.literal('unsupported_in_pinned_typed_sdk') }).strict();
export const SdkNativeGenerationControlsSchema = z.object({
  temperature: UnsupportedControl, generationSeed: UnsupportedControl, maxOutputTokens: UnsupportedControl,
}).strict();

/** Required ceilings, not evidence that an implementation actually enforced them.
 * Existing supervisor maxima are reused; final-answer/state bytes are distinct from streams. */
export const SdkNativeLimitsSchema = z.object({
  serializedRequestBytes: CodexWorkspaceLimits.shape.maxInputBytes,
  outputSchemaBytes: CodexWorkspaceLimits.shape.maxInputBytes,
  renderedPersistentStateBytes: Positive.max(2_097_152),
  answerBytes: z.object({ construction: Positive.max(8_388_608), diagnosis: Positive.max(8_388_608),
    proposal: Positive.max(8_388_608), review: Positive.max(8_388_608) }).strict(),
  combinedStdoutStderrBytes: CodexWorkspaceLimits.shape.maxOutputBytes,
  forwardedEventBytes: CodexWorkspaceLimits.shape.maxOutputBytes,
  deadlineMsPerCall: CodexWorkspaceLimits.shape.timeoutMs,
  cleanupTimeoutMs: CodexWorkspaceLimits.shape.cleanupTimeoutMs,
  dispatchedAttemptsPerRole: z.object({ construction: Positive, diagnosis: z.literal(1),
    proposal: z.literal(1), review: Positive }).strict(),
  dispatchedAttemptsPerArm: Positive, providerCallsPerArm: Positive, elapsedMsPerArm: Positive,
}).strict();

export const SdkNativeMonetaryPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hard_ceiling'), currency: Currency, maxCostMicros: Count,
    scope: z.literal('whole_study_including_in_flight') }).strict(),
  z.object({ kind: z.literal('explicit_exposure_authorization_required'),
    stopPolicyDigest: DigestSchema, reconciliationPolicyDigest: DigestSchema }).strict(),
]);

export const SdkNativeConfigurationSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('matched-revision-sdk-native-configuration'),
  profileVersion: z.literal(SDK_NATIVE_PROFILE_VERSION),
  runtimePins: z.object({ sdk: z.literal(MATCHED_CODEX_CAPABILITIES.sdk),
    sdkVersion: z.literal(MATCHED_CODEX_CAPABILITIES.version), cliVersion: Text, providerRoute: Text,
    sdkDeclarationDigest: DigestSchema, runtimeDigest: DigestSchema, configurationDigest: DigestSchema }).strict(),
  // One map, shared across all arms: no per-arm model, effort or budget override exists.
  roles: z.object({ construction: SdkNativeRoleSettingsSchema, diagnosis: SdkNativeRoleSettingsSchema,
    proposal: SdkNativeRoleSettingsSchema, review: SdkNativeRoleSettingsSchema }).strict(),
  generationControls: SdkNativeGenerationControlsSchema,
  scheduling: z.object({ schedulingSeed: Count, seedPurpose: z.literal('assignment_and_order_only'),
    repetitions: Positive, algorithm: Text, algorithmDigest: DigestSchema,
    blockRosterDigest: DigestSchema, targetScheduleDigest: DigestSchema }).strict(),
  limits: SdkNativeLimitsSchema,
  countingRules: z.object({ serialization: z.literal('canonical-json-utf8-v1'),
    persistentState: z.literal('rendered-utf8-including-initial-lesson-delta-and-overhead'),
    attempt: z.literal('every-dispatch-including-failure-invalid-abstention'),
    elapsed: z.literal('setup-execution-cleanup-and-allocated-shared-diagnosis'),
    providerInternalCalls: z.enum(['disabled', 'separately-recorded-and-budgeted']),
    retries: z.literal(0), freshThreadPerCall: z.literal(true), outputCacheReuse: z.literal(false) }).strict(),
  monetaryPolicy: SdkNativeMonetaryPolicySchema,
}).strict();
export type SdkNativeConfiguration = z.infer<typeof SdkNativeConfigurationSchema>;

/** The SDK's raw names are preserved. Missing fields are null, not zero; fields
 * may overlap, so no token total or billing estimate is derived from them. */
export const SdkNativeObservedUsageSchema = z.object({
  input_tokens: WorkspaceWorkerUsage.shape.input_tokens.max(Number.MAX_SAFE_INTEGER).nullable(),
  cached_input_tokens: WorkspaceWorkerUsage.shape.cached_input_tokens.max(Number.MAX_SAFE_INTEGER).nullable(),
  cache_write_input_tokens: WorkspaceWorkerUsage.shape.cache_write_input_tokens.max(Number.MAX_SAFE_INTEGER).nullable(),
  output_tokens: WorkspaceWorkerUsage.shape.output_tokens.max(Number.MAX_SAFE_INTEGER).nullable(),
  reasoning_output_tokens: WorkspaceWorkerUsage.shape.reasoning_output_tokens.max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();
export const SdkNativeObservedCostSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown'), costMicros: z.null(), currency: z.null() }).strict(),
  z.object({ status: z.literal('authoritative_billing'), costMicros: Count, currency: Currency,
    billingRecordDigest: DigestSchema }).strict(),
  z.object({ status: z.literal('estimate'), costMicros: Count, currency: Currency,
    assumptionsDigest: DigestSchema }).strict(),
]);

/** These are external admission *claims* in an audit record. Parsing one never
 * verifies its authority or grants permission; there is no operational native dispatch API. */
export const SdkNativeMonetaryAdmissionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_evaluated') }).strict(),
  z.object({ status: z.literal('blocked'), reason: z.enum(['not_authorized', 'hard_ceiling_unavailable',
    'unknown_usage', 'reconciliation_required']), detail: Text }).strict(),
  z.object({ status: z.literal('external_admission_recorded'), mode: z.literal('hard_ceiling'),
    authorizationEvidenceDigest: DigestSchema, mechanismEvidenceDigest: DigestSchema,
    inFlightReservationEvidenceDigest: DigestSchema, stopAndOvershootPolicyDigest: DigestSchema,
    currency: Currency, maxCostMicros: Count }).strict(),
  z.object({ status: z.literal('external_exposure_authorization_recorded'),
    authorizationEvidenceDigest: DigestSchema, stopPolicyDigest: DigestSchema,
    reconciliationPolicyDigest: DigestSchema }).strict(),
]);
const ClaimedEnforcement = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_started') }).strict(),
  z.object({ status: z.literal('unverified'), detail: Text }).strict(),
  z.object({ status: z.literal('reported_enforced'), limitsDigest: DigestSchema,
    enforcementEvidenceDigest: DigestSchema }).strict(),
  z.object({ status: z.literal('authored_supervised'), limitsDigest: DigestSchema,
    enforcementEvidenceDigest: DigestSchema }).strict(),
]);

/** One call/attempt record. This is not a full research record, failure roster,
 * aggregate ledger, empirical packet, runtime receipt or execution freeze. */
export const SdkNativeCallRecordSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('matched-revision-sdk-native-call-record'),
  profileVersion: z.literal(SDK_NATIVE_PROFILE_VERSION), configurationDigest: DigestSchema,
  callId: IdSchema, blockId: IdSchema, repetition: Positive,
  role: z.enum(SDK_NATIVE_ROLES), arm: z.enum(ARMS).nullable(),
  status: z.enum(['not_dispatched', 'completed', 'authored_completed', 'failed', 'cancelled']),
  executionKind: z.literal('authored_sdk_no_model').optional(),
  requestedSettings: SdkNativeRoleSettingsSchema, appliedSettings: SdkNativeRoleSettingsSchema.nullable(),
  launchSettingsReceiptDigest: DigestSchema.nullable(), effectiveConfigurationEvidenceDigest: DigestSchema.nullable(),
  monetaryAdmission: SdkNativeMonetaryAdmissionSchema, enforcement: ClaimedEnforcement,
  observations: z.object({
    serializedRequestBytes: Count.nullable(), outputSchemaBytes: Count.nullable(),
    renderedPersistentStateBytes: Count.nullable(), answerBytes: Count.nullable(),
    stdoutBytes: Count.nullable(), stderrBytes: Count.nullable(), forwardedEventBytes: Count.nullable(),
    setupMs: Count.nullable(), executionMs: Count.nullable(), cleanupMs: Count.nullable(),
    // SDK invocations are not automatically provider/billable model calls.
    sdkInvocations: Count, providerCalls: Count.nullable(),
    roleDispatchedAttempts: Count, armDispatchedAttempts: Count.nullable(),
    armProviderCalls: Count.nullable(), armElapsedMsIncludingSharedDiagnosis: Count.nullable(),
    rawUsage: SdkNativeObservedUsageSchema, cost: SdkNativeObservedCostSchema,
  }).strict(),
  // SDK policy, application checks and external containment are distinct evidence.
  isolationEvidence: z.object({ sdkPolicyDigest: DigestSchema.nullable(),
    applicationChecksDigest: DigestSchema.nullable(), externalRuntimeEvidenceDigest: DigestSchema.nullable(),
    processGroupStopped: z.boolean().nullable(), wholeRuntimeDestroyed: z.boolean().nullable(),
    remoteGenerationStopped: z.boolean().nullable() }).strict(),
  failure: Text.nullable(),
}).strict();
export type SdkNativeCallRecord = z.infer<typeof SdkNativeCallRecordSchema>;

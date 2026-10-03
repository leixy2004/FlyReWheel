import { canonicalJson, digestOf } from '../../src/core/identity.js';
import { freeze } from '../../src/workspace/execution-receipt.js';
import { SdkNativeCallRecordSchema, SdkNativeConfigurationSchema, type SdkNativeConfiguration } from './sdk-native-contracts.js';

export function validateSdkNativeConfiguration(raw: unknown) {
  const configuration = SdkNativeConfigurationSchema.parse(raw);
  // Prevent explicit undefined (which has no JSON representation) being silently
  // treated as an omitted optional setting in an identity-bound contract.
  canonicalJson(raw);
  return freeze(configuration);
}

/** Pure consistency validation of declared records. Digests bind bytes, not
 * provenance/authority. No I/O, runtime verification, dispatch or scoring. */
export function validateSdkNativeCallRecord(raw: unknown, configuration: SdkNativeConfiguration) {
  const config = validateSdkNativeConfiguration(configuration), record = SdkNativeCallRecordSchema.parse(raw);
  canonicalJson(raw);
  if (record.configurationDigest !== digestOf(config)) throw new Error('Native configuration digest mismatch');
  if (record.repetition > config.scheduling.repetitions) throw new Error('Repetition is outside the frozen schedule');
  const shared = record.role === 'construction' || record.role === 'diagnosis';
  if (shared !== (record.arm === null) || (record.arm === 'F' && record.role === 'proposal')) throw new Error('Native role/arm mismatch');
  if (digestOf(record.requestedSettings) !== digestOf(config.roles[record.role])) throw new Error('Requested role settings differ from the shared configuration');
  const admission = record.monetaryAdmission, policy = config.monetaryPolicy;
  if (admission.status === 'external_admission_recorded'
    && (policy.kind !== 'hard_ceiling' || admission.currency !== policy.currency || admission.maxCostMicros !== policy.maxCostMicros)) {
    throw new Error('Monetary admission does not match the requested hard ceiling');
  }
  if (admission.status === 'external_exposure_authorization_recorded'
    && (policy.kind !== 'explicit_exposure_authorization_required' || admission.stopPolicyDigest !== policy.stopPolicyDigest
      || admission.reconciliationPolicyDigest !== policy.reconciliationPolicyDigest)) {
    throw new Error('Monetary exposure authorization/policy mismatch');
  }
  if ((record.enforcement.status === 'reported_enforced' || record.enforcement.status === 'authored_supervised')
    && record.enforcement.limitsDigest !== digestOf(config.limits)) {
    throw new Error('Enforcement record changes the frozen limits');
  }
  const observed = record.observations;
  const authored = record.executionKind === 'authored_sdk_no_model';
  if (authored) {
    if (record.status === 'completed' || record.enforcement.status === 'reported_enforced'
      || admission.status !== 'not_evaluated' || observed.providerCalls !== 0
      || observed.cost.status !== 'unknown' || record.appliedSettings !== null || record.effectiveConfigurationEvidenceDigest !== null
      || record.isolationEvidence.externalRuntimeEvidenceDigest !== null || record.isolationEvidence.wholeRuntimeDestroyed !== null
      || record.isolationEvidence.remoteGenerationStopped !== null || (!shared && observed.armProviderCalls !== 0)) {
      throw new Error('Authored SDK mechanics cannot claim model, billing, admission or external-runtime evidence');
    }
  } else if (record.status === 'authored_completed' || record.enforcement.status === 'authored_supervised') {
    throw new Error('Authored status requires the explicit no-model execution kind');
  }
  if (shared && [observed.armDispatchedAttempts, observed.armProviderCalls, observed.armElapsedMsIncludingSharedDiagnosis].some(x => x !== null)) {
    throw new Error('Shared calls require separate standalone allocation, not an invented arm charge');
  }
  if (record.status === 'not_dispatched') {
    if (observed.sdkInvocations !== 0 || (observed.providerCalls !== null && observed.providerCalls !== 0)
      || record.appliedSettings !== null || record.launchSettingsReceiptDigest !== null
      || record.effectiveConfigurationEvidenceDigest !== null || record.enforcement.status !== 'not_started'
      || Object.values(observed.rawUsage).some(value => value !== null) || observed.cost.status !== 'unknown'
      || [observed.answerBytes, observed.stdoutBytes, observed.stderrBytes, observed.forwardedEventBytes, observed.executionMs].some(value => value !== null)) {
      throw new Error('Undispatched record claims execution');
    }
  } else {
    if (observed.sdkInvocations !== 1 || observed.roleDispatchedAttempts < 1) throw new Error('Each dispatched record requires one SDK attempt; no retries');
    if (!shared && (observed.armDispatchedAttempts === null || observed.armDispatchedAttempts < observed.roleDispatchedAttempts)) {
      throw new Error('Arm attempt accounting is absent or inconsistent');
    }
    if (!shared && observed.providerCalls !== null && observed.armProviderCalls !== null && observed.armProviderCalls < observed.providerCalls) {
      throw new Error('Arm provider-call total omits this call');
    }
  }
  if (record.status === 'completed' || record.status === 'authored_completed') {
    if (!authored && admission.status !== 'external_admission_recorded' && admission.status !== 'external_exposure_authorization_recorded') {
      throw new Error('Completed call lacks an external monetary admission record');
    }
    if (observed.providerCalls !== null && config.countingRules.providerInternalCalls === 'disabled' && observed.providerCalls > 1) {
      throw new Error('Provider internal calls contradict the disabled policy');
    }
    if (record.failure !== null || record.launchSettingsReceiptDigest === null || (!authored && (record.appliedSettings === null
      || digestOf(record.appliedSettings) !== digestOf(record.requestedSettings) || record.effectiveConfigurationEvidenceDigest === null))) {
      throw new Error('Completed call requires matching applied settings and configuration evidence');
    }
    if (record.enforcement.status !== (authored ? 'authored_supervised' : 'reported_enforced')) throw new Error('Completed call lacks an enforcement record');
    if (authored && record.isolationEvidence.processGroupStopped !== true) throw new Error('Authored call lacks a verified process-group stop');
    const limits = config.limits;
    const bound = (value: number | null, maximum: number, name: string) => {
      if (value === null || value > maximum) throw new Error(`Completed call has missing or exceeded ${name}`);
    };
    bound(observed.serializedRequestBytes, limits.serializedRequestBytes, 'request bytes');
    bound(observed.outputSchemaBytes, limits.outputSchemaBytes, 'schema bytes');
    if (!shared) bound(observed.renderedPersistentStateBytes, limits.renderedPersistentStateBytes, 'persistent-state bytes');
    bound(observed.answerBytes, limits.answerBytes[record.role], 'answer bytes');
    bound(observed.stdoutBytes === null || observed.stderrBytes === null ? null : observed.stdoutBytes + observed.stderrBytes,
      limits.combinedStdoutStderrBytes, 'stdout/stderr bytes');
    bound(observed.forwardedEventBytes, limits.forwardedEventBytes, 'forwarded/event bytes');
    if (observed.forwardedEventBytes! > observed.stdoutBytes! + observed.stderrBytes!) throw new Error('Forwarded bytes exceed raw streams');
    bound(observed.setupMs === null || observed.executionMs === null || observed.cleanupMs === null ? null
      : observed.setupMs + observed.executionMs + observed.cleanupMs, limits.deadlineMsPerCall, 'call elapsed time');
    bound(observed.cleanupMs, limits.cleanupTimeoutMs, 'cleanup time');
    bound(observed.roleDispatchedAttempts, limits.dispatchedAttemptsPerRole[record.role], 'role attempts');
    if (!shared) {
      bound(observed.armDispatchedAttempts, limits.dispatchedAttemptsPerArm, 'arm attempts');
      bound(observed.armProviderCalls, limits.providerCallsPerArm, 'arm provider calls');
      bound(observed.armElapsedMsIncludingSharedDiagnosis, limits.elapsedMsPerArm, 'arm elapsed time');
      if (observed.armElapsedMsIncludingSharedDiagnosis! < observed.setupMs! + observed.executionMs! + observed.cleanupMs!) {
        throw new Error('Arm elapsed time omits this call');
      }
    }
    if (!authored && (observed.providerCalls === null || observed.providerCalls < 1)) throw new Error('Completed call lacks provider-call accounting');
    if (observed.cost.status === 'authoritative_billing' && policy.kind === 'hard_ceiling'
      && (observed.cost.currency !== policy.currency || observed.cost.costMicros > policy.maxCostMicros)) {
      throw new Error('Billed call contradicts the monetary ceiling; retain as a failure');
    }
  } else if (record.status !== 'not_dispatched' && record.failure === null) {
    throw new Error('Failed/cancelled call must retain its failure');
  }
  // Null usage/currency is intentionally retained even on a completed call.
  // This never authorizes a next call or clears the existing unknown-usage blocker.
  return freeze(record);
}

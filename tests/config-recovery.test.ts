import { expect, test, vi } from 'vitest';
import { demoInputs } from '../src/demo.js';
import { QualEvoStore } from '../src/storage/index.js';
import { replayDataset, type Adjudicator } from '../src/pipeline.js';
import { configuredCodex, resolveCodexExecutionConfig } from '../src/model-runtime.js';
import { ReplayJobSchema, replayJobId } from '../src/jobs.js';
import { failedOutcome, type SemanticOutcome } from '../src/adapters/semantic.js';
import { ExecutionMetadataSchema } from '../src/core/index.js';

const environment = {
  QE_ENABLE_MODEL: 'true', QE_CODEX_AUTH_MODE: 'api', QE_CODEX_MODEL: 'test-model',
  QE_CODEX_API_KEY: 'explicit-test-placeholder',
};
const modelConfig = resolveCodexExecutionConfig(environment);
const success: SemanticOutcome = {
  execution: 'succeeded', adjudication: { decision: 'violation', source: 'agent', reasoning: 'Explicit test prediction', evidenceRefs: ['context:learning-bug'] },
  missingEvidence: [], error: null,
  metadata: { mode: 'codex_sdk', origin: 'model', model: 'test-model', sessionId: 'test-session', costUsd: null, usage: { inputTokens: 100, outputTokens: 20 } },
};

test('failed attempts stay immutable; a new explicit attempt recomputes and retains the failed audit trail', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const { bundle, dataset } = demoInputs();
    dataset.samples = dataset.samples.slice(0, 2);
    const adjudicator = vi.fn<Adjudicator>().mockResolvedValue(failedOutcome('codex_sdk', 'Transient test provider failure', 'test-model'));
    const options = { store, bundle, dataset, mode: 'model' as const, modelConfig, adjudicator };
    const first = await replayDataset(options);
    expect(first.report.metrics.executionErrors).toBe(1);
    expect(first.observations[0]!.executionMetadata).toMatchObject({ mode: 'codex_sdk', origin: 'execution_error', model: 'test-model', costUsd: null });
    expect(adjudicator).toHaveBeenCalledTimes(1);

    adjudicator.mockResolvedValue(success);
    const sameAttempt = await replayDataset(options);
    expect(sameAttempt.evaluationId).toBe(first.evaluationId);
    expect(sameAttempt.observations).toEqual(first.observations);
    expect(adjudicator).toHaveBeenCalledTimes(1);

    const recovered = await replayDataset({ ...options, attempt: 'retry-after-provider-recovery' });
    expect(recovered.evaluationId).not.toBe(first.evaluationId);
    expect(recovered.observations[0]!.runId).not.toBe(first.observations[0]!.runId);
    expect(recovered.report.metrics.executionErrors).toBe(0);
    expect(recovered.observations[0]!.candidateState).toBe('passed');
    expect(recovered.observations[0]!.executionMetadata).toEqual(success.metadata);
    expect((await store.getFinding(recovered.observations[0]!.id)).finding.executionMetadata).toEqual(success.metadata);
    expect(adjudicator).toHaveBeenCalledTimes(2);
    expect((await store.getFinding(first.observations[0]!.id)).finding.candidateState).toBe('execution_error');

    const changedConfig = await replayDataset({ ...options, modelConfig: { ...modelConfig, timeoutMs: modelConfig.timeoutMs + 1 } });
    expect(changedConfig.configDigest).not.toBe(first.configDigest);
    expect(changedConfig.observations[0]!.runId).not.toBe(first.observations[0]!.runId);
    expect(adjudicator).toHaveBeenCalledTimes(3);
  } finally { await store.close(); }
}, 30000);

test('job identity freezes all nonsecret model settings and explicit attempts', () => {
  const payload = { ...demoInputs(), mode: 'model' as const, modelConfig };
  expect(ReplayJobSchema.parse(payload)).toMatchObject({ attempt: 'initial', modelConfig });
  expect(replayJobId({ ...payload, attempt: 'initial' })).toBe(replayJobId(payload));
  expect(replayJobId({ ...payload, attempt: 'second' })).not.toBe(replayJobId(payload));
  for (const change of [
    { timeoutMs: modelConfig.timeoutMs + 1 },
    { maxReportedTokens: modelConfig.maxReportedTokens + 1 },
    { maxInputBytes: modelConfig.maxInputBytes + 1 },
    { model: 'another-test-model' },
    { authMode: 'account' as const },
  ]) {
    expect(replayJobId({ ...payload, modelConfig: { ...modelConfig, ...change } })).not.toBe(replayJobId(payload));
  }
  expect(() => ReplayJobSchema.parse({ ...payload, modelConfig: undefined })).toThrow();
  expect(() => ReplayJobSchema.parse({ ...payload, modelConfig: { ...modelConfig, apiKey: 'must-not-be-stored' } })).toThrow();
  expect(() => ReplayJobSchema.parse({ ...payload, modelConfig: { ...modelConfig, adapterRevision: 'unsupported-revision' } })).toThrow();
  expect(() => ReplayJobSchema.parse({ ...payload, mode: 'offline_fixture' })).toThrow();
  expect(() => ReplayJobSchema.parse({ ...payload, attempt: ' ' })).toThrow();
});

test('execution metadata rejects credential-shaped fields and invalid provider usage', () => {
  expect(() => ExecutionMetadataSchema.parse({ ...success.metadata, apiKey: 'must-not-be-stored' })).toThrow();
  expect(() => ExecutionMetadataSchema.parse({ ...success.metadata, usage: { inputTokens: -1, outputTokens: 20 } })).toThrow();
  expect(() => ExecutionMetadataSchema.parse({ ...success.metadata, costUsd: -1 })).toThrow();
});

test('cancellation stops between cases without poisoning unstarted observations and same-attempt resume reuses completed work', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const { bundle, dataset } = demoInputs();
    dataset.samples = dataset.samples.slice(0, 3);
    const controller = new AbortController();
    const adjudicator = vi.fn<Adjudicator>().mockImplementation(async () => { controller.abort(); return success; });
    const options = { store, bundle, dataset, mode: 'model' as const, modelConfig, adjudicator };
    await expect(replayDataset({ ...options, signal: controller.signal })).rejects.toThrow('Replay cancelled');
    expect(adjudicator).toHaveBeenCalledTimes(1);
    adjudicator.mockResolvedValue(success);
    const resumed = await replayDataset(options);
    // Only the new-unbounded case needs a new call; the first completed model result is reused.
    expect(adjudicator).toHaveBeenCalledTimes(2);
    expect(resumed.observations.map(item => item.candidateState)).toEqual(['passed', 'not_recalled', 'passed']);
    expect(resumed.report.metrics.executionErrors).toBe(0);
  } finally { await store.close(); }
}, 30000);

test('worker rejects configuration drift before model execution and never falls back between billing modes', () => {
  expect(configuredCodex(environment, modelConfig).executionConfig).toEqual(modelConfig);
  expect(() => configuredCodex({ ...environment, QE_MODEL_TIMEOUT_MS: '250000' }, modelConfig)).toThrow('differs from the frozen job configuration');
  expect(() => configuredCodex({ ...environment, QE_CODEX_AUTH_MODE: 'account', QE_CODEX_HOME: '/unused-test-home' }, modelConfig)).toThrow('differs from the frozen job configuration');
  expect(() => configuredCodex({ ...environment, QE_CODEX_AUTH_MODE: 'account' })).toThrow('Account mode requires');
  expect(() => configuredCodex({ ...environment, QE_CODEX_API_KEY: undefined, OPENAI_API_KEY: 'ambient-placeholder' })).toThrow('Explicit API mode requires');
  expect(() => configuredCodex({ ...environment, QE_CODEX_AUTH_MODE: undefined })).toThrow('Choose QE_CODEX_AUTH_MODE');
  expect(() => configuredCodex({ ...environment, QE_ENABLE_MODEL: 'false' })).toThrow('QE_ENABLE_MODEL=true');
});

test('credential rotation and login-home paths do not enter persisted configuration', () => {
  const account = { ...environment, QE_CODEX_AUTH_MODE: 'account', QE_CODEX_HOME: '/sensitive/login-home' };
  const resolved = resolveCodexExecutionConfig(account);
  expect(resolveCodexExecutionConfig({ ...account, QE_CODEX_HOME: '/another/login-home', QE_CODEX_API_KEY: 'rotated-test-placeholder' })).toEqual(resolved);
  const serialized = JSON.stringify(resolved);
  for (const secret of ['sensitive', 'login-home', 'placeholder', 'QE_CODEX_HOME', 'apiKey']) expect(serialized).not.toContain(secret);
  expect(resolved).toMatchObject({ adapterRevision: 'codex-sdk-adapter-v1', sdkVersion: '0.159.2', toolPolicyRevision: 'isolated-readonly-no-tools-v1', reasoningEffort: 'low' });
  expect(resolved.promptDigest).toMatch(/^[a-f0-9]{64}$/);
});

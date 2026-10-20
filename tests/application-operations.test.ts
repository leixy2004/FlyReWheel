import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PrMiningRequestInput } from '../src/core/pr-mining.js';
import { ApplicationJobSchema, applicationJobDigest, type ApplicationJob } from '../src/application-job-contract.js';
import { prepareMiningApplicationJob, preflightApplicationJob, inspectApplicationOperation } from '../src/application-preflight.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { QualEvoStore } from '../src/storage/store.js';
import { revisionGenerationFixture } from './helpers/revision-generation-fixture.js';
import { buildRevisionModelInput } from '../src/revision-generation.js';

let db: Database;
let store: QualEvoStore;
const records: Array<{ number: number; input: PrMiningRequestInput; mergeBase: string }> = [];
const defaultIssues = ['disabled', 'model_required', 'generation_limits_required', 'runtime_required',
  'lifecycle_authority_required', 'workspace_resolver_required'];
const fixedTime = '2026-10-03T22:52:07Z';
const fixtureRoot = new URL('../experiments/temporal-pilot/w0-first-three/', import.meta.url);
const requestInput = async (number: number) => JSON.parse(await readFile(new URL(`mining-preparation/request-input-${number}.json`, fixtureRoot), 'utf8'));
const counts = async () => ({
  jobs: Number((await db.query('SELECT count(*) AS count FROM qe_application_jobs')).rows[0].count),
  requests: Number((await db.query('SELECT count(*) AS count FROM qe_pr_mining_requests')).rows[0].count),
  cases: Number((await db.query('SELECT count(*) AS count FROM qe_problem_cases')).rows[0].count),
  candidates: Number((await db.query('SELECT count(*) AS count FROM qe_pr_mining_candidates')).rows[0].count),
});
const isolatedJob = (attempt: string): ApplicationJob => ApplicationJobSchema.parse({
  schemaVersion: 1, kind: 'pr-mining', workspaceId: 'w0-authorized-workspace', attempt,
  requestDigest: 'a'.repeat(64), candidateCreatedAt: fixedTime,
});

beforeAll(async () => {
  db = await openPGliteDatabase();
  store = await QualEvoStore.initialize(db);
  for (const number of [3035, 3031, 3036]) {
    const pkg = JSON.parse(await readFile(new URL(`proxy-attempt-1/package-${number}.json`, fixtureRoot), 'utf8'));
    await store.importGithubPrEvidence(pkg.evidence.evidence);
    records.push({ number, input: await requestInput(number), mergeBase: pkg.evidence.evidence.snapshot.mergeBase });
  }
}, 30_000);
afterAll(async () => { await store?.close(); });

it('prepares all three frozen real W0 requests without a queue claim or model call', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NETWORK_FORBIDDEN'); });
  try {
    for (const record of records) {
      const prepared = await prepareMiningApplicationJob(store, record.input, {
        workspaceId: 'w0-authorized-workspace', candidateCreatedAt: fixedTime,
      });
      expect(ApplicationJobSchema.safeParse(prepared.job).success).toBe(true);
      const report = await preflightApplicationJob(store, prepared.job);
      expect(report.status).toBe('blocked');
      expect(report.execution).toBe('not_run');
      expect(report.workspace).toMatchObject({ repository: 'github:encode/httpx', expectedSha: record.mergeBase });
      expect(report.issues.map(issue => issue.code)).toEqual(defaultIssues);
      expect(report.jobStateChecked).toBe(false);
      expect(report.workspaceVerification).toBe('not_run');
      expect(JSON.stringify(prepared.job)).not.toMatch(/repoPath|runtimeModule|apiKey|model/);
    }
    expect(await counts()).toEqual({ jobs: 0, requests: 3, cases: 8, candidates: 0 });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
}, 30_000);

it('rejects queue-authority injection before reading domain records or creating claims', async () => {
  const before = await counts();
  const lookup = vi.spyOn(store, 'getPrMiningRequest');
  try {
    for (const extra of [
      { model: 'unauthorized' }, { repoPath: '/untrusted' }, { backend: 'untrusted' },
      { runtimeModule: '/tmp/untrusted.mjs' }, { credentials: { token: 'AUTHORED_SENTINEL' } },
      { bootstrapConfig: { enabled: true } }, { resolveWorkspace: '/untrusted' },
    ]) {
      await expect(preflightApplicationJob(store, { ...isolatedJob('invalid'), ...extra })).rejects.toThrow();
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  } finally { lookup.mockRestore(); }
});

it('rejects preparation identity overrides and timestamps before persisting a request', async () => {
  const before = await counts();
  const input = { ...records[0].input, id: 'must-not-persist-invalid-selection' };
  const selection = { workspaceId: 'w0-authorized-workspace', candidateCreatedAt: fixedTime };
  for (const extra of [{ requestDigest: 'f'.repeat(64) }, { schemaVersion: 1 }, { kind: 'pr-mining' }, { model: 'untrusted' }]) {
    await expect(prepareMiningApplicationJob(store, input, { ...selection, ...extra })).rejects.toThrow();
  }
  await expect(prepareMiningApplicationJob(store, input, { ...selection, candidateCreatedAt: '2020-01-01T00:00:00Z' }))
    .rejects.toThrow('CANDIDATE_PREDATES_REQUEST');
  expect(await counts()).toEqual(before);
});

it('reports missing dependencies and early candidate timestamps without exposing database errors', async () => {
  const missing = await preflightApplicationJob(store, isolatedJob('missing-record'));
  expect(missing.issues.map(issue => issue.code)).toEqual(['domain_record_missing', ...defaultIssues]);
  expect(missing.workspace).toBeNull();
  const prepared = await prepareMiningApplicationJob(store, records[0].input, {
    workspaceId: 'w0-authorized-workspace', candidateCreatedAt: fixedTime,
  });
  const early = await preflightApplicationJob(store, ApplicationJobSchema.parse({ ...prepared.job, candidateCreatedAt: '2020-01-01T00:00:00Z' }));
  expect(early.issues.map(issue => issue.code)).toEqual(['candidate_predates_request', ...defaultIssues]);
  expect(early.workspace?.expectedSha).toBe(records[0].mergeBase);
  const lookup = vi.spyOn(store, 'getPrMiningRequest').mockRejectedValue(new Error('postgres://PRIVATE_PASSWORD@privatehost SQL_PRIVATE'));
  try {
    const rejected = await preflightApplicationJob(store, prepared.job);
    expect(rejected.issues.map(issue => issue.code)).toEqual(['domain_contract_rejected', ...defaultIssues]);
    expect(JSON.stringify(rejected)).not.toMatch(/PRIVATE_PASSWORD|privatehost|SQL_PRIVATE/);
  } finally { lookup.mockRestore(); }
});

it('distinguishes untouched, active-owner and cleanup-safe retry states without taking a claim', async () => {
  const job = isolatedJob('lease-state-flow'), owner = randomUUID();
  expect(await inspectApplicationOperation(store, job)).toMatchObject({ state: 'not_started', attempts: 0,
    recovery: { action: 'preflight_then_enqueue', automaticRetryAllowed: false } });
  await store.claimApplicationJob(job, owner);
  expect(await inspectApplicationOperation(store, job)).toMatchObject({ state: 'running', attempts: 1,
    recovery: { action: 'wait_for_owner', automaticRetryAllowed: false } });
  expect(await store.claimApplicationJob(job, randomUUID())).toEqual({ state: 'busy' });
  await store.failApplicationJob(job, owner, { status: 'failed', modelExecution: 'not_run', cleanup: 'not_started', reason: 'cancelled' });
  expect(await inspectApplicationOperation(store, job)).toMatchObject({ state: 'retryable', attempts: 1,
    recovery: { action: 'inspect_then_reenqueue_same_job', automaticRetryAllowed: false } });
  // Inspection never claims the retry. Only this explicit test operation increments attempts.
  expect((await store.getApplicationJob(applicationJobDigest(job)))?.attempts).toBe(1);
  const nextOwner = randomUUID();
  expect(await store.claimApplicationJob(job, nextOwner)).toEqual({ state: 'claimed', owner: nextOwner });
  expect((await store.getApplicationJob(applicationJobDigest(job)))?.attempts).toBe(2);
});

it('keeps finished blocked outcomes immutable and requires explicit recovery before a new identity', async () => {
  const job = isolatedJob('sticky-blocked'), owner = randomUUID();
  await store.claimApplicationJob(job, owner);
  const result = { status: 'blocked' as const, modelExecution: 'not_run' as const, cleanup: 'not_started' as const, reason: 'runtime_unavailable' as const };
  await store.completeApplicationJob(job, owner, result);
  const status = await inspectApplicationOperation(store, job);
  expect(status).toMatchObject({ state: 'finished', attempts: 1, result,
    recovery: { action: 'fix_prerequisites_then_explicit_new_attempt', automaticRetryAllowed: false } });
  expect(status.recovery.nextAction).toContain('immutable');
  expect(status.recovery.nextAction).toContain('old job');
  expect((await store.claimApplicationJob(job, randomUUID())).state).toBe('finished');
  const newJob = { ...job, attempt: 'deliberate-new-attempt' };
  expect(applicationJobDigest(newJob)).not.toBe(applicationJobDigest(job));
  expect((await inspectApplicationOperation(store, newJob)).state).toBe('not_started');
  expect((await store.getApplicationJob(applicationJobDigest(job)))?.result).toEqual(result);
});

it('leaves expired claims untouched in preflight but explicitly reconciles them in recovery', async () => {
  const prepared = await prepareMiningApplicationJob(store, records[0].input, {
    workspaceId: 'w0-authorized-workspace', candidateCreatedAt: fixedTime, attempt: 'expired-recovery',
  });
  const job = prepared.job, owner = randomUUID(), digest = applicationJobDigest(job);
  await store.claimApplicationJob(job, owner);
  // Controlled local PGlite fault; no host clock changes or production record writes.
  await db.transaction(async tx => {
    await tx.query('ALTER TABLE qe_application_jobs DISABLE TRIGGER qe_application_jobs_transition');
    await tx.query("UPDATE qe_application_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_digest=$1", [digest]);
    await tx.query('ALTER TABLE qe_application_jobs ENABLE TRIGGER qe_application_jobs_transition');
  });
  const before = await preflightApplicationJob(store, job);
  expect(before.jobStateChecked).toBe(false);
  expect((await db.query('SELECT state FROM qe_application_jobs WHERE job_digest=$1', [digest])).rows[0].state).toBe('running');
  const recovery = await inspectApplicationOperation(store, job);
  expect(recovery).toMatchObject({ state: 'finished', attempts: 1,
    reconciliation: 'expired-claims-may-be-terminally-blocked',
    result: { status: 'blocked', modelExecution: 'unknown', cleanup: 'retained-for-recovery', reason: 'interrupted_execution_requires_recovery' },
    recovery: { action: 'recover_retained_runtime', automaticRetryAllowed: false } });
  expect(recovery.recovery.nextAction).toContain('prior model activity');
  expect(recovery.recovery.nextAction).toContain('cannot perform');
  await expect(store.completeApplicationJob(job, owner, { status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason: 'cancelled' }))
    .rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  expect((await store.claimApplicationJob(job, randomUUID())).state).toBe('finished');
  expect(await inspectApplicationOperation(store, job)).toEqual(recovery);
});

it('does not let complete deployment JSON claim lifecycle authority or workspace resolution', async () => {
  const prepared = await prepareMiningApplicationJob(store, records[0].input, {
    workspaceId: 'w0-authorized-workspace', candidateCreatedAt: fixedTime,
  });
  const bootstrapConfig = {
    schemaVersion: 1, enabled: true, model: 'explicit-authored-test-model',
    generationLimits: { maxInputBytes: 262144, maxOutputBytes: 131072, timeoutMs: 30000 },
    runtime: {
      id: 'explicit-test-runtime', backend: 'opensandbox', endpoint: 'https://sandbox.example.invalid',
      apiKeyEnv: 'TEST_SANDBOX_KEY', image: `registry.example.invalid/worker@sha256:${'a'.repeat(64)}`,
      cpu: '1000m', memory: '512Mi', maxBundleBytes: 1048576,
      workerExecutable: '/opt/flyrewheel/bin/workspace-worker', gatewayHost: 'gateway.example.invalid',
      limits: { maxInputBytes: 262144, maxOutputBytes: 131072, timeoutMs: 30000,
        cleanupTimeoutMs: 1000, maxArtifactBytes: 1024, maxArtifacts: 1 },
    },
  };
  const before = await counts();
  const report = await preflightApplicationJob(store, prepared.job, { bootstrapConfig,
    bootstrapDependencies: { environment: { TEST_SANDBOX_KEY: 'AUTHORED_PRIVATE_SENTINEL' } } });
  expect(report.status).toBe('blocked');
  expect(report.issues.map(issue => issue.code)).toEqual(['lifecycle_authority_required', 'workspace_resolver_required']);
  expect(report.execution).toBe('not_run');
  expect(JSON.stringify(report)).not.toContain('AUTHORED_PRIVATE_SENTINEL');
  const injected = await preflightApplicationJob(store, prepared.job, {
    bootstrapConfig: { ...bootstrapConfig, authority: { approved: true }, resolveWorkspace: '/untrusted' },
  });
  expect(injected.issues.map(issue => issue.code)).toEqual(['invalid_configuration']);
  expect(await counts()).toEqual(before);
});


it('preflights the same revision timestamp and selected-snapshot constraints as generation', async () => {
  // Authored offline review/feedback graph, not a real model result.
  const fixture = await revisionGenerationFixture();
  try {
    const earlyDate = '2020-01-01T00:00:00Z';
    expect(() => buildRevisionModelInput({ ...fixture.input, candidateCreatedAt: earlyDate },
      { model: 'authored-no-live-model' })).toThrow('Revision candidate predates the request');
    const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'revision-generation',
      workspaceId: 'authored-revision-workspace', requestDigest: fixture.request.digest,
      snapshotDigest: fixture.snapshot.digest, candidateCreatedAt: earlyDate });
    const early = await preflightApplicationJob(fixture.store, job);
    expect(early.issues.map(issue => issue.code)).toEqual(['candidate_predates_request', ...defaultIssues]);
    expect(early.workspace?.expectedSha).toBe(fixture.head);
    const invalidSnapshot = await preflightApplicationJob(fixture.store, ApplicationJobSchema.parse({
      ...job, snapshotDigest: 'f'.repeat(64), candidateCreatedAt: fixedTime,
    }));
    expect(invalidSnapshot.issues.map(issue => issue.code)).toEqual(['revision_snapshot_not_selected', ...defaultIssues]);
    expect(invalidSnapshot.workspace).toBeNull();
    expect(fixture.calls).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 30_000);

it.each(['valid-blocked', 'early-time', 'wrong-snapshot'] as const)(
  'revision preflight %s leaves selected unregistered feedback sources available for holdout registration', async scenario => {
    const fixture = await revisionGenerationFixture(undefined, true);
    try {
      const heldout = { ...fixture.cases[1], id: 'preflight-future-holdout', lineageId: 'preflight-future-holdout',
        split: 'holdout' as const, expected: 'unknown' as const };
      const sourceRows = async () => (await fixture.db.query('SELECT digest,split FROM qe_source_splits ORDER BY digest')).rows;
      const before = await sourceRows();
      expect(before.some(row => row.digest === heldout.sourceDigest)).toBe(false);
      const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'revision-generation', workspaceId: 'authored-revision-workspace',
        requestDigest: fixture.request.digest, snapshotDigest: scenario === 'wrong-snapshot' ? 'f'.repeat(64) : fixture.snapshot.digest,
        candidateCreatedAt: scenario === 'early-time' ? '2020-01-01T00:00:00Z' : fixedTime });
      const report = await preflightApplicationJob(fixture.store, job);
      expect(report).toMatchObject({ status: 'blocked', execution: 'not_run', modelExecution: 'not_run' });
      expect(report.issues.map(issue => issue.code)).toEqual([
        ...(scenario === 'early-time' ? ['candidate_predates_request'] : scenario === 'wrong-snapshot' ? ['revision_snapshot_not_selected'] : []),
        ...defaultIssues,
      ]);
      expect(await sourceRows()).toEqual(before);
      expect(fixture.calls).toEqual([]);
      expect((await fixture.db.query('SELECT job_digest FROM qe_application_jobs')).rows).toEqual([]);
      await fixture.store.importProblemCase(heldout);
      expect((await fixture.store.getProblemCase(heldout.id)).split).toBe('holdout');
      const afterHoldout = await sourceRows();
      const rejected = await preflightApplicationJob(fixture.store, ApplicationJobSchema.parse({ ...job, snapshotDigest: fixture.snapshot.digest, candidateCreatedAt: fixedTime }));
      expect(rejected.issues.map(issue => issue.code)).toEqual(['domain_contract_rejected', ...defaultIssues]);
      expect(rejected.workspace).toBeNull();
      expect(await sourceRows()).toEqual(afterHoldout);
      expect(fixture.calls).toEqual([]);
    } finally { await fixture.cleanup(); }
  }, 30_000);

it('actual revision preparation still reserves selected feedback sources against later holdout import', async () => {
  const fixture = await revisionGenerationFixture(undefined, true);
  try {
    const heldout = { ...fixture.cases[1], id: 'after-preparation-holdout', lineageId: 'after-preparation-holdout',
      split: 'holdout' as const, expected: 'unknown' as const };
    const selected = async () => (await fixture.db.query('SELECT split FROM qe_source_splits WHERE digest=$1', [heldout.sourceDigest])).rows;
    expect(await selected()).toEqual([]);
    await fixture.store.prepareRevisionGeneration(fixture.request.digest);
    expect(await selected()).toEqual([{ split: 'training' }]);
    await expect(fixture.store.importProblemCase(heldout)).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
    await expect(fixture.store.getProblemCase(heldout.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fixture.calls).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 30_000);

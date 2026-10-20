import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { PgBoss } from 'pg-boss';
import { startWorkerService } from '../src/worker-service.js';
import { APPLICATION_QUEUE, REPLAY_QUEUE } from '../src/jobs.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sandbox from '../src/adapters/opensandbox-workspace.js';
import { loadWorkerApplication, parseWorkerLaunchOptions, startWorkerFromOptions } from '../src/worker-launch.js';
import { createApplicationJobDispatcher } from '../src/application-dispatcher.js';
import { type ApplicationJobInput, type ApplicationJobResult, applicationJobDigest } from '../src/application-job-contract.js';
import { QualEvoStore } from '../src/storage/store.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';

// Integration boundary: real bootstrap configuration, dispatcher/adapters, worker
// protocol, official SDK with authored executable, and file-backed PGlite. The
// OpenSandbox factory supplies an authored backend; queue delivery and HTTP
// listening are authored seams around the real service. No isolation, live
// service, actual PostgreSQL, model execution, or credential access is claimed.
vi.mock('node:http', async importOriginal => ({ ...await importOriginal<typeof import('node:http')>(), createServer: vi.fn() }));
type Callback = (jobs: Array<{ data: ApplicationJobInput; signal: AbortSignal }>) => Promise<ApplicationJobResult>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { while (cleanups.length) await cleanups.pop()!(); }
  finally { vi.restoreAllMocks(); }
});
async function fixture(withService = false) {
  const f = await applicationJobsFixture();
  cleanups.push(f.cleanup);
  const factory = vi.spyOn(sandbox, 'createOpenSandboxWorkspaceBackend').mockReturnValue(f.backend);
  const forbidden = async () => { throw new Error('No live lifecycle operation allowed'); };
  const config = { enabled: true, model: f.config.model,
    generationLimits: { maxInputBytes: f.dependency.limits.maxInputBytes, maxOutputBytes: f.dependency.limits.maxOutputBytes, timeoutMs: f.dependency.limits.timeoutMs },
    runtime: { id: f.dependency.id, backend: 'opensandbox', endpoint: 'https://sandbox.example.invalid',
      apiKeyEnv: 'AUTHORED_TEST_KEY', image: `registry.example.invalid/worker@sha256:${'a'.repeat(64)}`,
      cpu: '1000m', memory: '512Mi', maxBundleBytes: 1048576,
      workerExecutable: '/opt/flyrewheel/bin/workspace-worker', gatewayHost: 'gateway.example.invalid',
      limits: f.dependency.limits } };
  const dependencies = {
    authority: { preflight: forbidden, stopAndVerify: forbidden, destroyAndVerify: forbidden,
      collectFrozen: async function* () { throw new Error('No live artifact collection allowed'); } },
    resolveWorkspace: f.resolveWorkspace,
  };
  // Trusted authored module, explicitly selected and pinned through the same CLI
  // parser/loader as deployment. Its code-only dependency slot is removed even
  // when composition throws; nothing is loaded from a queue or environment path.
  const slot = `__authored_worker_dependencies_${randomUUID().replaceAll('-', '')}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[slot] = dependencies;
  const moduleBytes = `export const config = ${JSON.stringify(config)};\nexport const dependencies = globalThis[${JSON.stringify(slot)}];\n`;
  const modulePath = join(f.directory, 'reviewed-bootstrap.mjs');
  await writeFile(modulePath, moduleBytes);
  let application;
  let service: Awaited<ReturnType<typeof startWorkerService>> | undefined;
  const handlers = new Map<string, Callback>();
  const options = parseWorkerLaunchOptions(['--enable-application-execution',
      '--application-bootstrap', modulePath, '--application-bootstrap-sha256', createHash('sha256').update(moduleBytes).digest('hex')]);
  const environment = { AUTHORED_TEST_KEY: 'authored-placeholder-no-credential', QE_ENABLE_MODEL: 'false', QE_S3_ENABLED: 'false',
    DATABASE_URL: 'postgresql://authored@database.example.invalid/authored' };
  try {
    if (withService) {
      const health = Object.assign(new EventEmitter(), {
        listen(_port: number, _host: string, callback: () => void) { callback(); return this; },
        close(callback: () => void) { callback(); return this; },
      });
      vi.mocked(createServer).mockReturnValue(health as unknown as ReturnType<typeof createServer>);
      const boss = Object.assign(new EventEmitter(), {
        work: async (name: string, _options: unknown, callback: Callback) => { handlers.set(name, callback); return name; },
        getQueue: async (name: string) => ({ name }), stop: async () => {},
      });
      const originalClose = f.store.close.bind(f.store);
      let closed = false;
      vi.spyOn(f.store, 'close').mockImplementation(async () => { if (!closed) { closed = true; await originalClose(); } });
      service = await startWorkerFromOptions(options, environment, {
        openStore: async () => f.store, openQueue: async () => boss as unknown as PgBoss,
        startService: async serviceOptions => {
          application = serviceOptions.application;
          return startWorkerService({ ...serviceOptions, onResult: () => {} });
        },
      });
      cleanups.push(() => service!.stop());
      expect(service.applicationRuntime).toBe('configured');
      expect([...handlers.keys()]).toEqual([REPLAY_QUEUE, APPLICATION_QUEUE]);
    } else { application = await loadWorkerApplication(options, environment); }
  } finally { delete globals[slot]; }
  expect(application).toBeDefined();
  expect(factory).toHaveBeenCalledOnce();
  expect(application!.runtime?.backend.kind).toBe('authored-test-no-isolation');
  return { ...f, application, service, handlers };
}
async function reopen(path: string) {
  const store = await QualEvoStore.openPGlite(path);
  cleanups.push(() => store.close());
  return store;
}

describe('opt-in worker adapter composition durable authored integration', () => {
  it('routes persisted mining/review/revision inputs and returns committed results after reopen without transport', async () => {
    const f = await fixture(true);
    const dispatch = (job: ApplicationJobInput, signal: AbortSignal) => f.handlers.get(APPLICATION_QUEUE)!([{ data: job, signal }]);
    const jobs = [f.jobs.mining, f.jobs.review, f.jobs.revision];
    const outputs = [];
    for (const job of jobs) outputs.push(await dispatch(job, new AbortController().signal));
    expect(outputs.map(result => result.outcome?.kind)).toEqual(['pr-mining-candidate', 'semantic-review', 'revision-candidate']);
    for (const output of outputs) expect(output).toMatchObject({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified' });
    expect(f.executions).toEqual(['pr-mining-v1', 'semantic-review-v2', 'rule-revision-v2']);
    for (const job of jobs) {
      expect(f.resolved).toContainEqual(expect.objectContaining({ kind: job.kind, workspaceId: job.workspaceId, jobDigest: applicationJobDigest(job) }));
      expect(await f.store.getApplicationJob(applicationJobDigest(job))).toMatchObject({ state: 'finished', attempts: 1 });
    }
    const mining = await f.store.listPrMiningCandidates();
    const revisions = await f.store.listRevisionCandidates();
    const review = (await f.store.listSemanticReviews()).find(item => item.ruleDigest === f.reviewRule.digest)!;
    expect(mining).toHaveLength(1); expect(revisions).toHaveLength(1); expect(review).toBeDefined();
    expect(await f.store.getActive(f.baseRule.rule.ruleId)).toBeNull();
    expect(await f.store.getActive(f.reviewRule.rule.ruleId)).toBeNull();
    await f.service?.stop();
    await f.closeStore();
    const store = await reopen(f.storePath);
    expect(await store.getPrMiningRequest(f.jobs.mining.requestDigest)).toEqual(f.miningRequest);
    expect(await store.getRevisionRequest(f.jobs.revision.requestDigest)).toEqual(f.request);
    // No runtime/resolver dependency exists in the fresh dispatcher: durable
    // terminal records, rather than in-memory memoization, must satisfy replay.
    const replay = createApplicationJobDispatcher({ store });
    for (let i = 0; i < jobs.length; i++) expect(await replay(jobs[i], new AbortController().signal)).toEqual(outputs[i]);
    expect(await store.listPrMiningCandidates()).toEqual(mining);
    expect(await store.listRevisionCandidates()).toEqual(revisions);
    expect(await store.getSemanticReview(review.id)).toEqual(review);
    expect(f.executions).toHaveLength(3); expect(f.resolved).toHaveLength(3);
  }, 90_000);

  it('recovers a cleanup-verified failed execution from persisted retry state across store reopen', async () => {
    const f = await fixture();
    f.faults.executeFailures = 1;
    const dispatch = createApplicationJobDispatcher({ store: f.store, ...f.application });
    await expect(dispatch(f.jobs.mining, new AbortController().signal)).rejects.toThrow();
    expect(await f.store.getApplicationJob(applicationJobDigest(f.jobs.mining))).toMatchObject({ state: 'retryable', attempts: 1,
      result: { status: 'failed', cleanup: 'verified', modelExecution: 'not_run', reason: 'runtime_failed' } });
    expect(await f.store.listPrMiningCandidates()).toEqual([]);
    expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
    await f.closeStore();
    const store = await reopen(f.storePath);
    const resumed = createApplicationJobDispatcher({ store, ...f.application });
    const result = await resumed(f.jobs.mining, new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', cleanup: 'verified', modelExecution: 'not_run' });
    expect(await store.getApplicationJob(applicationJobDigest(f.jobs.mining))).toMatchObject({ state: 'finished', attempts: 2 });
    expect(await store.listPrMiningCandidates()).toHaveLength(1);
    expect(f.executions).toEqual(['pr-mining-v1', 'pr-mining-v1']);
    expect(await resumed(f.jobs.mining, new AbortController().signal)).toEqual(result);
    expect(f.executions).toHaveLength(2);
  }, 60_000);

  it('retains unverified runtime cleanup across reopen and never retries or publishes its output', async () => {
    const f = await fixture();
    const digest = applicationJobDigest(f.jobs.mining);
    f.faults.destroyFailure = true;
    const dispatch = createApplicationJobDispatcher({ store: f.store, ...f.application });
    const blocked = await dispatch(f.jobs.mining, new AbortController().signal);
    expect(blocked).toEqual({ status: 'blocked', modelExecution: 'not_run',
      cleanup: 'retained-for-recovery', reason: 'cleanup_not_verified' });
    expect(await f.store.listPrMiningCandidates()).toEqual([]);
    await f.closeStore();
    const store = await reopen(f.storePath);
    await store.reconcileExpiredApplicationJobs();
    const resumed = createApplicationJobDispatcher({ store, ...f.application });
    expect(await resumed(f.jobs.mining, new AbortController().signal)).toEqual(blocked);
    expect(await store.getApplicationJob(digest)).toMatchObject({ state: 'finished', attempts: 1 });
    expect(await store.listPrMiningCandidates()).toEqual([]);
    expect(f.executions).toEqual(['pr-mining-v1']); expect(f.resolved).toHaveLength(1);
  }, 60_000);
});

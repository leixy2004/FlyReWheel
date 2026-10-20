import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import * as workspaceApi from '../src/workspace/index.js';
import { runLocalGovernanceLoop } from '../src/local-governance-loop.js';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { while (directories.length) await rm(directories.pop()!, { recursive: true, force: true }); });
async function fresh() { const root = await mkdtemp(join(tmpdir(), 'governance-loop-test-')); directories.push(root); return root; }
it('runs the actual source CLI, persists governed execution, and reopens identically in another process', async () => {
  const root = await fresh(); await mkdir(join(root, 'home'));
  const out = join(root, 'demo');
  const args = ['--import', 'tsx', resolve('src/cli.ts'), 'closed-loop', 'governance-demo', '--out-dir', out];
  const environment = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: root, QE_ENABLE_MODEL: 'false', QE_S3_ENABLED: 'false' };
  const first = JSON.parse((await exec(process.execPath, args, { env: environment, timeout: 90000, maxBuffer: 2_000_000 })).stdout);
  expect(first).toMatchObject({ status: 'succeeded', modelExecution: 'not_run', humanVerdicts: 'Unknown', productionActivation: 'not_performed', governanceEvents: 5,
    checks: { rejectionBlocked: true, stalePlanBlockedBeforeAdmission: true, reopenedIdentically: true, fixtureFeedbackCount: 2 } });
  expect(first.nextReview.ruleDigest).toBe(first.successorRuleDigest);
  expect(first.nextReview.admission.planDigest).toBe(first.successorPlanDigest);
  const execution = await readFile(join(out, 'runtime/execution.json'), 'utf8');
  const candidateBytes = await readFile(join(out, 'source-loop/artifacts/compatible-revision-candidate.json'), 'utf8');
  const second = JSON.parse((await exec(process.execPath, args, { env: environment, timeout: 90000, maxBuffer: 2_000_000 })).stdout);
  expect(second).toEqual(first);
  expect(await readFile(join(out, 'runtime/execution.json'), 'utf8')).toBe(execution);
  expect(await readFile(join(out, 'source-loop/artifacts/compatible-revision-candidate.json'), 'utf8')).toBe(candidateBytes);
  const review = JSON.parse(await readFile(join(out, 'artifacts/governed-review.json'), 'utf8'));
  expect(review.executionReceipt).toMatchObject({ execution: 'completed', modelExecution: 'not_run', cleanup: 'verified' });
  expect(review.ruleDigest).toBe(first.successorRuleDigest);
  expect(JSON.parse(await readFile(join(out, 'artifacts/stale-status.json'), 'utf8')).jobs[0]).toMatchObject({ admission: null, result: { reason: 'stale_governance_plan' } });
  const report = join(out, 'report.json'); await writeFile(report, '{}\n');
  await expect(exec(process.execPath, args, { env: environment, timeout: 90000 })).rejects.toThrow('Immutable artifact changed');
  expect(await readFile(report, 'utf8')).toBe('{}\n');
  expect(JSON.parse(await readFile(join(out, 'last-run.json'), 'utf8'))).toMatchObject({ status: 'failed', error: expect.stringContaining('Immutable artifact changed') });
}, 180000);
it('refuses an unrelated output directory without modifying its contents', async () => {
  const root = await fresh(); await writeFile(join(root, 'keep.txt'), 'user content');
  await expect(runLocalGovernanceLoop({ outDir: root })).rejects.toThrow('empty --out-dir');
  expect(await readdir(root)).toEqual(['keep.txt']);
  expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('user content');
});

it.each(['before-cleanup', 'after-cleanup'])('finalizes committed outcomes after %s failure in a fresh CLI process', async stage => {
  const root = await fresh(); await mkdir(join(root, 'home'));
  const out = join(root, 'demo');
  const cleanup = workspaceApi.cleanupWorkspace;
  let identity: Parameters<typeof cleanup>[0] | undefined;
  const fault = vi.spyOn(workspaceApi, 'cleanupWorkspace').mockImplementation(async input => {
    if (input.runId !== 'authored-local-governance-loop-v1') return cleanup(input);
    identity = input;
    if (stage === 'after-cleanup') await cleanup(input);
    throw new Error('Injected committed-finalization failure');
  });
  try { await expect(runLocalGovernanceLoop({ outDir: out })).rejects.toThrow('Injected committed-finalization failure'); }
  finally { fault.mockRestore(); }
  expect(identity).toBeDefined();
  await expect(readFile(join(out, 'report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const marker = await readFile(join(out, 'runtime/execution.json'), 'utf8');
  const args = ['--import', 'tsx', resolve('src/cli.ts'), 'closed-loop', 'governance-demo', '--out-dir', out];
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: root, QE_ENABLE_MODEL: 'false', QE_S3_ENABLED: 'false' };
  if (stage === 'before-cleanup') {
    const inspected = await workspaceApi.inspectWorkspace(identity!);
    const lease = join(dirname(inspected.manifestPath), 'active-execution');
    await mkdir(lease);
    await expect(exec(process.execPath, args, { env, timeout: 90000 })).rejects.toThrow('execution lease is active');
    await rm(lease, { recursive: true });
    const original = await readFile(inspected.manifestPath, 'utf8');
    await writeFile(inspected.manifestPath, JSON.stringify({ ...inspected.record, status: 'cleanup-unverified' }));
    await expect(exec(process.execPath, args, { env, timeout: 90000 })).rejects.toThrow('explicit recovery');
    await writeFile(inspected.manifestPath, original);
    const path = inspected.record.worktreePath;
    await rename(path, path + '-retained');
    try { await expect(exec(process.execPath, args, { env, timeout: 90000 })).rejects.toThrow('identity changed or missing'); }
    finally { await rename(path + '-retained', path); }
    await expect(readFile(join(out, 'report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(out, 'last-run.json'), 'utf8')).status).toBe('failed');
  }
  if (stage === 'after-cleanup') {
    const inspected = await workspaceApi.inspectWorkspace(identity!);
    const ref = `refs/heads/${inspected.record.branch}`;
    const originalSha = inspected.record.baseSha;
    const parentSha = (await exec('git', ['-C', identity!.repoPath, 'rev-parse', `${originalSha}^`], { env })).stdout.trim();
    expect(parentSha).not.toBe(originalSha);
    await exec('git', ['-C', identity!.repoPath, 'update-ref', ref, parentSha, originalSha], { env });
    try {
      await expect(exec(process.execPath, args, { env, timeout: 90000 })).rejects.toThrow('Retained workspace branch SHA changed');
      await expect(readFile(join(out, 'report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await readFile(join(out, 'last-run.json'), 'utf8')).status).toBe('failed');
    } finally { await exec('git', ['-C', identity!.repoPath, 'update-ref', ref, originalSha, parentSha], { env }); }
  }
  const recovered = JSON.parse((await exec(process.execPath, args, { env, timeout: 90000, maxBuffer: 2_000_000 })).stdout);
  expect(recovered.status).toBe('succeeded');
  expect(await readFile(join(out, 'runtime/execution.json'), 'utf8')).toBe(marker);
  expect((await workspaceApi.inspectWorkspace(identity!)).record.status).toBe('closed-clean');
}, 120000);

it('does not promote an uncommitted worker result to success on reopen', async () => {
  const root = await fresh(); await mkdir(join(root, 'home'));
  const out = join(root, 'demo');
  const complete = QualEvoStore.prototype.completeApplicationJob;
  const fault = vi.spyOn(QualEvoStore.prototype, 'completeApplicationJob').mockImplementation(async function (this: QualEvoStore, ...args) {
    if (args[0].kind === 'semantic-review' && args[2].status === 'completed') throw new Error('Injected before domain/outcome commit');
    return complete.apply(this, args);
  });
  try { await expect(runLocalGovernanceLoop({ outDir: out })).rejects.toThrow('persistence_failed'); }
  finally { fault.mockRestore(); }
  const marker = await readFile(join(out, 'runtime/execution.json'), 'utf8');
  const plan = JSON.parse(await readFile(join(out, 'artifacts/successor-plan.json'), 'utf8'));
  const { governedReviewJobs } = await import('../src/governed-semantic-review.js');
  const { applicationJobDigest } = await import('../src/application-job-contract.js');
  const job = governedReviewJobs(plan)[0]!;
  const store = await QualEvoStore.openPGlite(join(out, 'source-loop/db'));
  try {
    const record = await store.getApplicationJob(applicationJobDigest(job));
    expect(record).toMatchObject({ state: 'retryable', result: { reason: 'persistence_failed' } });
    expect(record?.result?.outcome).toBeUndefined();
    expect((await store.listSemanticReviews()).filter(review => review.executionReceipt !== undefined)).toHaveLength(0);
  } finally { await store.close(); }
  const args = ['--import', 'tsx', resolve('src/cli.ts'), 'closed-loop', 'governance-demo', '--out-dir', out];
  await expect(exec(process.execPath, args, { env: { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: root }, timeout: 90000 })).rejects.toThrow('Application job requires retry');
  await expect(readFile(join(out, 'report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(join(out, 'last-run.json'), 'utf8')).status).toBe('failed');
  expect(await readFile(join(out, 'runtime/execution.json'), 'utf8')).toBe(marker);
}, 120000);

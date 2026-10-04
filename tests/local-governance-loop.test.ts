import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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

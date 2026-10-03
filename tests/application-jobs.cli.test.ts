import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { applicationJobDigest, applicationJobId, ApplicationJobSchema } from '../src/application-job-contract.js';
import { QualEvoStore } from '../src/storage/store.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, DATABASE_URL: '', QE_ENABLE_MODEL: 'true', QE_CODEX_AUTH_MODE: 'not-configured', QE_CODEX_MODEL: 'must-not-run' };
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 500_000, env });
const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'approved-workspace',
  ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), repositoryContextDigests: ['c'.repeat(64)] });

it('validates logical queue jobs offline and reports persisted blocked status across CLI processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'application-cli-'));
  try {
    const file = join(directory, 'job.json'), db = join(directory, 'db');
    await writeFile(file, JSON.stringify(job));
    expect(JSON.parse((await run(['application-jobs', 'validate', '--file', file])).stdout)).toEqual({
      job, reviewSelection: 'explicit-digest-replay-not-governance-governed', jobDigest: applicationJobDigest(job), jobId: applicationJobId(job), execution: 'not_run' });
    expect(JSON.parse((await run(['application-jobs', 'status', '--file', file, '--db', db])).stdout)).toMatchObject({
      state: 'not_started', queueState: null, attempts: 0, result: null });
    const store = await QualEvoStore.openPGlite(db), owner = randomUUID();
    try {
      await store.claimApplicationJob(job, owner);
      await store.completeApplicationJob(job, owner, { status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_unavailable' });
    } finally { await store.close(); }
    expect(JSON.parse((await run(['application-jobs', 'status', '--file', file, '--db', db])).stdout)).toMatchObject({
      state: 'finished', attempts: 1, result: { status: 'blocked', modelExecution: 'not_run', reason: 'runtime_unavailable' } });
    await expect(run(['application-jobs', 'enqueue', '--file', file])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('DATABASE_URL') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('rejects queue authority fields before opening storage and worker --check never opens runtime services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'application-cli-invalid-'));
  try {
    const file = join(directory, 'job.json'), db = join(directory, 'never-created');
    await writeFile(file, JSON.stringify({ ...job, repoPath: '/untrusted' }));
    await expect(run(['application-jobs', 'status', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/worker.ts', '--check'], { cwd: root, timeout: 15_000, env: { ...env, DATABASE_URL: 'must-not-connect' } });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'checked', queues: ['replay', 'application'], applicationRuntime: 'blocked' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

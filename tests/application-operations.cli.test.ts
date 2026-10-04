import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';

const exec = promisify(execFile);
const fixtures = 'experiments/temporal-pilot/w0-first-three';
const run = async (...args: string[]) => JSON.parse((await exec(process.execPath,
  ['--import', 'tsx', 'src/cli.ts', 'application-jobs', ...args], { timeout: 25_000, maxBuffer: 200_000 })).stdout);

it('prepares all three real W0 requests through the CLI, reopens, and explains each blocked job without execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'w0-operations-cli-')), db = join(root, 'db');
  try {
    const store = await QualEvoStore.openPGlite(db);
    try {
      for (const number of [3035, 3031, 3036]) {
        const pkg = JSON.parse(await readFile(`${fixtures}/proxy-attempt-1/package-${number}.json`, 'utf8'));
        await store.importGithubPrEvidence(pkg.evidence.evidence);
      }
    } finally { await store.close(); }
    for (const number of [3035, 3031, 3036]) {
      const file = join(root, `job-${number}.json`);
      const args = ['prepare-mining', '--db', db, '--request', `${fixtures}/mining-preparation/request-input-${number}.json`,
        '--workspace-id', `httpx-w0-${number}`, '--candidate-created-at', '2026-10-03T23:00:00Z', '--job-out', file];
      const prepared = await run(...args);
      expect(prepared).toMatchObject({ requestPersistence: 'stored', jobPersistence: 'not_enqueued', execution: 'not_run' });
      const job = JSON.parse(await readFile(file, 'utf8'));
      expect(job).toEqual(prepared.job);
      expect(await run(...args)).toEqual(prepared);
      const preflight = await run('preflight', '--db', db, '--file', file);
      expect(preflight).toMatchObject({ status: 'blocked', execution: 'not_run', modelExecution: 'not_run',
        workspace: { workspaceId: `httpx-w0-${number}`, repository: 'github:encode/httpx' }, jobStateChecked: false });
      expect(preflight.issues.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining([
        'disabled', 'lifecycle_authority_required', 'workspace_resolver_required',
      ]));
      expect(preflight.workspace.expectedSha).toBe(preflight.workspace.baseSha);
      const recovery = await run('recovery', '--db', db, '--file', file);
      expect(recovery).toMatchObject({ state: 'not_started', attempts: 0,
        recovery: { action: 'preflight_then_enqueue', automaticRetryAllowed: false } });
    }
    const reopened = await QualEvoStore.openPGlite(db);
    try {
      expect(await reopened.listPrMiningRequests()).toHaveLength(3);
      expect(await reopened.listPrMiningCandidates()).toEqual([]);
    } finally { await reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

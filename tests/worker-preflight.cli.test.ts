import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { semanticInputs } from './helpers/semantic-review-fixture.js';
import { applicationJobDigest } from '../src/application-job-contract.js';

it('compiled/configured batch preflight distinguishes exact declarations from missing config without claiming or resolving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-preflight-')), db = join(directory, 'db');
  let store: QualEvoStore | undefined;
  try {
    store = await QualEvoStore.openPGlite(db); const f = semanticInputs();
    await store.importRuleVersion(f.rule.rule, [f.problemCase]); await store.importChangeSnapshot(f.snapshot.snapshot);
    const stored = await store.createReviewBatch({ id: 'preflight', jobs: [{ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'prepared-test', ruleDigest: f.rule.digest, snapshotDigest: f.snapshot.digest }] });
    const job = stored.batch.input.jobs[0], digest = applicationJobDigest(job);
    await store.close(); store = undefined;
    const config = JSON.parse(await readFile('examples/worker/preflight-only.json', 'utf8'));
    config.preparedWorkspaces.entries.push({ selection: { workspaceId: job.workspaceId, jobDigest: digest, kind: job.kind, repository: f.snapshot.snapshot.repository.id,
      expectedSha: f.snapshot.snapshot.head, headSha: f.snapshot.snapshot.head, baseSha: f.snapshot.snapshot.mergeBase },
      workspace: { repoPath: '/nonexistent-preflight-only-no-authorization', runId: 'unused', attemptId: 'unused' }, manifestDigest: '0'.repeat(64) });
    const file = join(directory, 'config.json'); await writeFile(file, JSON.stringify(config));
    const cli = process.env.WORKER_PREFLIGHT_COMPILED === '1' ? ['dist/cli.js'] : ['--import', 'tsx', 'src/cli.ts'];
    const run = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [...cli, ...args], { timeout: 30_000 })).stdout);
    const prefix = ['reviews', 'batch', 'preflight', '--db', db, '--digest', stored.digest];
    const normal = await run([...prefix, '--config', file]);
    expect(normal).toMatchObject({ status: 'blocked', claims: 'not_created', workspaceInspection: 'not_run',
      bootstrap: { configuration: 'schema-valid', resolver: 'built-in-prepared-workspace-resolver', lifecycleAuthority: 'missing-no-built-in-production-factory', credential: { valueRead: false } },
      items: [{ workspaceBinding: 'exact-config-selection-not-verified' }] });
    expect(await run(prefix)).toMatchObject({ status: 'blocked', bootstrap: { status: 'disabled', resolver: 'missing' }, items: [{ workspaceBinding: 'missing-exact-selection' }] });
    await writeFile(file, JSON.stringify({ ...config, module: '/tmp/never-load.js' }));
    expect((await run([...prefix, '--config', file])).bootstrap.configuration).toBe('invalid');
    store = await QualEvoStore.openPGlite(db); expect(await store.getApplicationJob(digest)).toBeNull();
  } finally { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

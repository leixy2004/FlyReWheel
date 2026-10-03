import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { semanticInputs } from './helpers/semantic-review-fixture.js';
import { digestOf } from '../src/core/identity.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, DATABASE_URL: 'postgresql://authored:fixture@never-connect.invalid/test', QE_ENABLE_MODEL: 'false' };
const run = (args: string[], environment = env) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 2_500_000, env: environment });

it('plans, reopens and reports exact local governed selection through the CLI while labeling manual replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'governed-cli-')), db = join(dir, 'db'), file = join(dir, 'input.json');
  try {
    const f = semanticInputs(); let store = await QualEvoStore.openPGlite(db);
    const rule = await store.importRuleVersion(f.rule.rule, [f.problemCase]), snapshot = await store.importChangeSnapshot(f.snapshot.snapshot);
    const fields = { namespace: 'local-semantic-review' as const, ruleDigest: rule.digest, scopeDigest: digestOf(f.rule.rule.scope),
      actor: 'cli-fixture', source: 'fixture' as const, reason: 'Authored CLI fixture', createdAt: '2026-10-02T00:00:00Z' };
    const registered = await store.applySemanticGovernance({ ...fields, id: 'cli-register', action: 'register', expectedHeadDigest: null });
    const bootstrapped = await store.applySemanticGovernance({ ...fields, id: 'cli-bootstrap', action: 'bootstrap-shadow', expectedHeadDigest: registered.digest });
    await store.close();
    await writeFile(file, JSON.stringify({ id: 'cli-plan', repository: snapshot.snapshot.repository.id, paths: ['src/sample.ts'], snapshotDigest: snapshot.digest, workspaceId: 'approved-workspace' }));
    const planned = JSON.parse((await run(['reviews', 'governed', 'plan', '--file', file, '--db', db])).stdout);
    expect(planned).toMatchObject({ execution: 'not_run', plan: { selection: { selected: [{ ruleDigest: rule.digest, headDigest: bootstrapped.digest }] } },
      jobs: [{ governancePlanDigest: planned.digest, ruleDigest: rule.digest, snapshotDigest: snapshot.digest }] });
    expect(JSON.parse((await run(['reviews', 'governed', 'show', '--digest', planned.digest, '--db', db])).stdout)).toMatchObject({ digest: planned.digest, jobs: planned.jobs });
    expect(JSON.parse((await run(['reviews', 'governed', 'status', '--digest', planned.digest, '--db', db])).stdout)).toMatchObject({ state: 'pending', currentGovernance: 'matches-plan', jobs: [{ state: 'not_started', admission: null }] });
    store = await QualEvoStore.openPGlite(db);
    await store.applySemanticGovernance({ ...fields, id: 'cli-suspend', action: 'suspend', expectedHeadDigest: bootstrapped.digest });
    await store.close();
    expect(JSON.parse((await run(['reviews', 'governed', 'status', '--digest', planned.digest, '--db', db])).stdout)).toMatchObject({ currentGovernance: 'stale-plan' });
    expect(JSON.parse((await run(['reviews', 'governed', 'plan', '--file', file, '--db', db])).stdout)).toEqual(planned);
    const replay = JSON.parse((await run(['reviews', 'run', '--rule-digest', rule.digest, '--snapshot-digest', snapshot.digest, '--db', db])).stdout);
    expect(replay).toMatchObject({ reviewSelection: 'explicit-digest-replay-not-governance-governed', ruleDigest: rule.digest, snapshotDigest: snapshot.digest, notification: 'not_performed' });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 90_000);

it('governed CLI rejects conflicting or absent database selection and unknown plan fields before creating storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'governed-cli-reject-')), db = join(dir, 'never-created'), file = join(dir, 'bad.json');
  try {
    await writeFile(file, JSON.stringify({ id: 'bad', repository: 'repo', paths: ['src/a.ts'], snapshotDigest: 'a'.repeat(64), workspaceId: 'workspace', backend: 'forbidden' }));
    const args = ['reviews', 'governed', 'plan', '--file', file];
    await expect(run(args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Choose exactly one') });
    await expect(run([...args, '--db', db, '--postgres'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('never both') });
    await expect(run([...args, '--postgres'], { ...env, DATABASE_URL: '' })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('DATABASE_URL') });
    await expect(run([...args, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unrecognized key') });
    await expect(run(['reviews', 'governed', 'enqueue', '--digest', 'a'.repeat(64)])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--postgres') });
    await expect(run(['reviews', 'governed', 'enqueue', '--digest', 'a'.repeat(64), '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

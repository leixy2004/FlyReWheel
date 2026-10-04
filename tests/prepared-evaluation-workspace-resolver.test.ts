import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreparedEvaluationWorkspaceResolver } from '../src/prepared-evaluation-workspace-resolver.js';
import { exportEvaluationCheckout, type EvaluationVisibilityManifest } from '../src/workspace/evaluation-checkout.js';
import { prepareEvaluationWorkspace } from '../src/workspace/evaluation-workspace.js';
import { workspaceGit } from '../src/workspace/process.js';
import { digestOf } from '../src/core/identity.js';

// Local authored Git data only. A valid resolver result is not production runtime authority.
let root: string, sequence = 0;
const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NETWORK_FORBIDDEN'); });
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'prepared-evaluation-resolver-')); });
afterAll(async () => { expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
const signal = () => new AbortController().signal;
async function fixture() {
  const directory = join(root, String(++sequence)); await mkdir(directory);
  const source = join(directory, 'source'); await mkdir(source);
  await git(source, 'init', '--quiet', '--template=', '--initial-branch=main');
  await git(source, 'config', 'user.name', 'Authored Fixture');
  await git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, '.gitignore'), '.sandcastle/\nignored/\n');
  await writeFile(join(source, 'value.txt'), 'authored before\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'authored before');
  const sha = await git(source, 'rev-parse', 'HEAD');
  await writeFile(join(source, 'value.txt'), 'AUTHORED_FUTURE\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'authored future');
  const future = await git(source, 'rev-parse', 'HEAD');
  const storePath = join(directory, 'store');
  const manifest: EvaluationVisibilityManifest = { schemaVersion: 1, repositoryId: 'authored/evaluation',
    classification: 'development-fixture', allowedHeads: [sha], checkoutSha: sha,
    visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: null, evidenceDigests: [] } };
  const baseline = await exportEvaluationCheckout({ repoPath: source, storePath, manifest });
  const workspace = { repoPath: join(directory, 'derived'), runId: 'offline-study', attemptId: 'one' };
  const prepared = await prepareEvaluationWorkspace({ ...workspace, exportId: 'authored-export', storePath, manifest });
  const selection = { workspaceId: 'authored-workspace', jobDigest: 'a'.repeat(64), repository: manifest.repositoryId,
    kind: 'pr-mining' as const, baseSha: sha, headSha: sha, expectedSha: sha, evaluationExportId: 'authored-export' };
  const config = { schemaVersion: 1, purpose: 'offline-study', entries: [{ selection: { ...selection },
    workspace: { ...workspace }, manifestDigest: digestOf(prepared.record), evaluation: structuredClone(prepared.evaluation) }] };
  return { directory, source, future, baseline, workspace, prepared, selection, config,
    resolve: createPreparedEvaluationWorkspaceResolver(config) };
}

test('resolves an actual export and derived workspace after reopening registry JSON, without future objects', async () => {
  const f = await fixture();
  const path = join(f.directory, 'registry.json'); await writeFile(path, JSON.stringify(f.config));
  const reopened = createPreparedEvaluationWorkspaceResolver(JSON.parse(await readFile(path, 'utf8')));
  expect(await reopened(f.selection, signal())).toEqual({ workspace: f.workspace, evaluation: f.prepared.evaluation });
  await expect(git(f.workspace.repoPath, 'cat-file', '-e', `${f.future}^{commit}`)).rejects.toThrow();
  const originalManifest = await readFile(f.baseline.manifestPath, 'utf8');
  await reopened(f.selection, signal());
  expect(await readFile(f.baseline.manifestPath, 'utf8')).toBe(originalManifest);
}, 30_000);

test('copies caller configuration and returned nested evaluation bindings', async () => {
  const f = await fixture();
  f.config.entries[0].workspace.repoPath = '/mutated';
  f.config.entries[0].evaluation.inventory.digest = 'b'.repeat(64);
  f.config.entries[0].evaluation.allowedHeads.push(f.future);
  const result = await f.resolve(f.selection, signal());
  if (!('workspace' in result) || !result.evaluation) throw new Error('Expected explicit evaluation resolution');
  result.workspace.repoPath = '/mutated-result'; result.evaluation.allowedHeads.push(f.future);
  result.evaluation.inventory.digest = 'c'.repeat(64);
  expect(await f.resolve(f.selection, signal())).toEqual({ workspace: f.workspace, evaluation: f.prepared.evaluation });
}, 30_000);

test('rejects missing or production purpose, extra config authority, duplicate selection and changed selection dimensions', async () => {
  const f = await fixture();
  const { purpose: _purpose, ...missingPurpose } = f.config;
  for (const bad of [missingPurpose, { ...f.config, purpose: 'production' }, { ...f.config, authority: true },
    { ...f.config, entries: [f.config.entries[0], f.config.entries[0]] }]) {
    expect(() => createPreparedEvaluationWorkspaceResolver(bad)).toThrow();
  }
  for (const patch of [{ workspaceId: 'other' }, { jobDigest: 'b'.repeat(64) }, { repository: 'other/repo' },
    { kind: 'semantic-review' as const }, { baseSha: f.future }, { headSha: f.future }, { expectedSha: f.future },
    { evaluationExportId: 'other' }]) {
    await expect(f.resolve({ ...f.selection, ...patch }, signal())).rejects.toThrow();
  }
  const { evaluationExportId: _exportId, ...missingExport } = f.selection;
  await expect(f.resolve(missingExport, signal())).rejects.toThrow();
}, 30_000);

test('rejects changes to every complete evaluation binding dimension', async () => {
  const f = await fixture();
  for (const patch of [{ exportId: 'other' }, { repositoryId: 'other/repo' }, { requestDigest: 'b'.repeat(64) },
    { recordDigest: 'b'.repeat(64) }, { checkoutSha: f.future, allowedHeads: [f.future] },
    { allowedHeads: [f.prepared.evaluation.checkoutSha, f.future].sort() },
    { inventory: { ...f.prepared.evaluation.inventory, count: f.prepared.evaluation.inventory.count + 1 } },
    { inventory: { ...f.prepared.evaluation.inventory, expandedBytes: f.prepared.evaluation.inventory.expandedBytes + 1 } },
    { inventory: { ...f.prepared.evaluation.inventory, digest: 'b'.repeat(64) } }]) {
    const config = structuredClone(f.config); Object.assign(config.entries[0].evaluation, patch);
    await expect(async () => createPreparedEvaluationWorkspaceResolver(config)(f.selection, signal())).rejects.toThrow();
  }
}, 30_000);

test('rejects a rehashed ordinary manifest instead of treating missing evaluation as valid', async () => {
  const f = await fixture();
  const { evaluation: _evaluation, ...ordinary } = f.prepared.record;
  await writeFile(f.prepared.manifestPath, JSON.stringify(ordinary));
  const config = structuredClone(f.config); config.entries[0].manifestDigest = digestOf(ordinary);
  await expect(createPreparedEvaluationWorkspaceResolver(config)(f.selection, signal())).rejects.toThrow();
}, 30_000);

test('rejects tracked or ignored dirt and an added ref outside the allowed closure', async () => {
  const f = await fixture(), path = f.prepared.record.worktreePath;
  await writeFile(join(path, 'value.txt'), 'dirty\n');
  await expect(f.resolve(f.selection, signal())).rejects.toThrow();
  await writeFile(join(path, 'value.txt'), 'authored before\n');
  await mkdir(join(path, 'ignored')); await writeFile(join(path, 'ignored', 'hidden'), 'hidden dirt');
  await expect(f.resolve(f.selection, signal())).rejects.toThrow();
  await rm(join(path, 'ignored'), { recursive: true });
  await git(f.workspace.repoPath, 'update-ref', 'refs/heads/unapproved', f.selection.expectedSha);
  await expect(f.resolve(f.selection, signal())).rejects.toThrow();
}, 30_000);

test('rejects cancellation before reads and during asynchronous lookup', async () => {
  const f = await fixture(), before = new AbortController(); before.abort();
  await expect(f.resolve(f.selection, before.signal)).rejects.toThrow();
  const during = new AbortController(), pending = f.resolve(f.selection, during.signal); during.abort();
  await expect(pending).rejects.toThrow();
}, 30_000);

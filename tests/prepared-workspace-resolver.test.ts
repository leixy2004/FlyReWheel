import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreparedWorkspaceResolver } from '../src/prepared-workspace-resolver.js';
import { prepareWorkspace } from '../src/workspace/index.js';
import { workspaceGit } from '../src/workspace/process.js';
import { digestOf } from '../src/core/identity.js';
let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'prepared-resolver-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
async function fixture(name: string) {
  const repoPath = join(root, name); await mkdir(repoPath);
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Fixture');
  await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\nignored/\n');
  await writeFile(join(repoPath, 'value.txt'), 'fixture\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored fixture');
  const sha = await git(repoPath, 'rev-parse', 'HEAD');
  const workspace = { repoPath, runId: name, attemptId: 'one' };
  const prepared = await prepareWorkspace({ ...workspace, baseSha: sha });
  const selection = { workspaceId: 'logical-one', jobDigest: 'a'.repeat(64), repository: 'authored/repo',
    kind: 'pr-mining' as const, expectedSha: sha, baseSha: sha, headSha: sha };
  const config = { schemaVersion: 1, entries: [{ selection: { ...selection }, workspace: { ...workspace }, manifestDigest: digestOf(prepared.record) }] };
  return { workspace, prepared, selection, config, resolve: createPreparedWorkspaceResolver(config) };
}
const signal = () => new AbortController().signal;
test('resolves actual prepared Git workspace and snapshots admin JSON independently of caller mutation', async () => {
  const f = await fixture('valid');
  f.config.entries[0].workspace.repoPath = '/mutated'; f.config.entries[0].selection.repository = 'changed';
  const result = await f.resolve(f.selection, signal()); expect(result).toEqual(f.workspace);
  (result as typeof f.workspace).repoPath = '/mutated-result';
  expect(await f.resolve(f.selection, signal())).toEqual(f.workspace);
});
test('rejects each changed selection dimension and evaluation exports', async () => {
  const f = await fixture('selection');
  for (const patch of [{ workspaceId: 'other' }, { jobDigest: 'b'.repeat(64) }, { repository: 'other/repo' },
    { kind: 'semantic-review' as const }, { baseSha: 'b'.repeat(40) }, { headSha: 'b'.repeat(40) }, { expectedSha: 'b'.repeat(40) }]) {
    await expect(f.resolve({ ...f.selection, ...patch }, signal())).rejects.toThrow(/not authorized/);
  }
  await expect(f.resolve({ ...f.selection, evaluationExportId: 'export' }, signal())).rejects.toThrow(/does not support evaluation/);
});
test('rejects ignored dirt, changed HEAD and changed manifest', async () => {
  const f = await fixture('dirty'); const path = f.prepared.record.worktreePath;
  await mkdir(join(path, 'ignored')); await writeFile(join(path, 'ignored', 'hidden'), 'dirty');
  await expect(f.resolve(f.selection, signal())).rejects.toThrow(/not ready, clean/);
  await rm(join(path, 'ignored'), { recursive: true });
  await writeFile(join(path, 'value.txt'), 'changed'); await git(path, 'add', '.'); await git(path, 'commit', '-m', 'changed');
  await expect(f.resolve(f.selection, signal())).rejects.toThrow(/exact authorized SHA/);
  await writeFile(f.prepared.manifestPath, JSON.stringify({ ...f.prepared.record, updatedAt: 'changed' }));
  await expect(f.resolve(f.selection, signal())).rejects.toThrow(/manifest digest changed/);
});
test('rejects symbolic manifest and symbolic repository aliases', async () => {
  const f = await fixture('symlink'); const alias = join(root, 'alias');
  await symlink(f.workspace.repoPath, alias, 'dir');
  const config = structuredClone(f.config); config.entries[0].workspace.repoPath = alias;
  await expect(createPreparedWorkspaceResolver(config)(f.selection, signal())).rejects.toThrow(/not canonical/);
  await rename(f.prepared.manifestPath, `${f.prepared.manifestPath}.real`);
  await symlink(`${f.prepared.manifestPath}.real`, f.prepared.manifestPath);
  await expect(f.resolve(f.selection, signal())).rejects.toThrow(/Invalid workspace manifest/);
});
test('rejects cancellation before reads and after asynchronous lookup, duplicates and malformed configuration', async () => {
  const f = await fixture('abort'); const controller = new AbortController(); controller.abort();
  await expect(f.resolve(f.selection, controller.signal)).rejects.toThrow();
  const later = new AbortController(); const pending = f.resolve(f.selection, later.signal); later.abort();
  await expect(pending).rejects.toThrow();
  expect(() => createPreparedWorkspaceResolver({ ...f.config, entries: [f.config.entries[0], f.config.entries[0]] })).toThrow(/Duplicate/);
  expect(() => createPreparedWorkspaceResolver({ ...f.config, module: 'untrusted' })).toThrow();
});
test('rejects an authorized mapping to the wrong checkout, non-ready manifest and detached branch', async () => {
  const f = await fixture('identity');
  const config = structuredClone(f.config); config.entries[0].selection.expectedSha = 'b'.repeat(40);
  await expect(createPreparedWorkspaceResolver(config)(config.entries[0].selection, signal())).rejects.toThrow(/exact authorized SHA/);
  const notReady = { ...f.prepared.record, status: 'preserved-dirty' };
  await writeFile(f.prepared.manifestPath, JSON.stringify(notReady));
  const pendingConfig = structuredClone(f.config); pendingConfig.entries[0].manifestDigest = digestOf(notReady);
  await expect(createPreparedWorkspaceResolver(pendingConfig)(f.selection, signal())).rejects.toThrow(/not ready/);
  await writeFile(f.prepared.manifestPath, JSON.stringify(f.prepared.record));
  await git(f.prepared.record.worktreePath, 'checkout', '--detach');
  await expect(f.resolve(f.selection, signal())).rejects.toThrow(/not ready/);
});

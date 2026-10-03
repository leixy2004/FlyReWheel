import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, acquireWorkspaceExecutionLease } from '../src/workspace/index.js';
import { workspaceGit } from '../src/workspace/process.js';
import { transferSandcastleWorkspace } from '../src/workspace/sandcastle-transfer.js';

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-transfer-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
async function fixture(name: string) {
  const repoPath = join(root, name); await mkdir(repoPath);
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Fixture');
  await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(repoPath, 'value.txt'), 'base\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'base');
  const baseSha = await git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'value.txt'), 'future\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'future');
  const future = await git(repoPath, 'rev-parse', 'HEAD');
  const { record } = await prepareWorkspace({ repoPath, runId: name, attemptId: 'one', baseSha });
  const lease = await acquireWorkspaceExecutionLease({ repoPath: record.repoPath, runId: record.runId, attemptId: record.attemptId }, record.baseSha);
  return { record, future, lease };
}
it('uses real public Sandcastle bundle transfer in a clean child and preserves all refs/host workspace', async () => {
  const f = await fixture('bundle'); const commands: string[] = []; let bytes = Buffer.alloc(0);
  // Authored remote-protocol double. No command is executed remotely or locally.
  await transferSandcastleWorkspace(f.record, {
    async exec(command, cwd) {
      commands.push(command);
      expect(cwd === undefined || cwd === '/workspace/repo').toBe(true);
      return { stdout: command === 'mktemp -d -t sandcastle-XXXXXX' ? '/tmp/sandcastle-FAKE\n'
        : command === 'git rev-parse HEAD' ? f.record.baseSha + '\n' : '', stderr: '', exitCode: 0 };
    },
    async upload(path, chunks) {
      expect(path).toBe('/tmp/sandcastle-FAKE/repo.bundle');
      for await (const chunk of chunks) bytes = Buffer.concat([bytes, chunk]);
    },
  }, { maxBundleBytes: 1_000_000, signal: new AbortController().signal });
  expect(bytes.length).toBeGreaterThan(100);
  const bundle = join(root, 'transferred.bundle'); await writeFile(bundle, bytes);
  const refs = await git(f.record.repoPath, 'bundle', 'list-heads', bundle);
  expect(refs).toContain(f.record.baseSha); expect(refs).toContain(f.future);
  expect(commands).toContain('git clone "/tmp/sandcastle-FAKE/repo.bundle" "/workspace/repo_clone"');
  expect(commands).toContain(`git checkout "${f.record.branch}"`);
  expect(await readFile(join(f.record.worktreePath, 'value.txt'), 'utf8')).toBe('base\n');
}, 20_000);
it('rejects an oversized bundle before upload', async () => {
  const f = await fixture('oversize'); let uploaded = false;
  await expect(transferSandcastleWorkspace(f.record, {
    async exec() { return { stdout: '/tmp/sandcastle-FAKE\n', stderr: '', exitCode: 0 }; },
    async upload() { uploaded = true; },
  }, { maxBundleBytes: 1, signal: new AbortController().signal })).rejects.toThrow(/transfer failed/);
  expect(uploaded).toBe(false);
}, 20_000);
it('refuses Sandcastle env file without forwarding its contents', async () => {
  const f = await fixture('env'); await writeFile(join(f.record.repoPath, '.sandcastle', '.env'), 'UNTRUSTED_VALUE=do-not-read\n');
  let contacted = false;
  await expect(transferSandcastleWorkspace(f.record, {
    async exec() { contacted = true; throw new Error('must not run'); }, async upload() { contacted = true; },
  }, { maxBundleBytes: 1_000_000, signal: new AbortController().signal })).rejects.toThrow();
  expect(contacted).toBe(false);
}, 20_000);
it('retains unregistered orphan directories instead of letting upstream pruning delete evidence', async () => {
  const f = await fixture('orphan'); const orphan = join(f.record.repoPath, '.sandcastle', 'worktrees', 'orphan-evidence');
  await mkdir(orphan); await writeFile(join(orphan, 'important.txt'), 'retain this evidence'); let called = false;
  await expect(transferSandcastleWorkspace(f.record, {
    async exec() { called = true; throw new Error('must not run'); }, async upload() { called = true; },
  }, { maxBundleBytes: 1_000_000, signal: new AbortController().signal })).rejects.toThrow(/Unregistered Sandcastle/);
  expect(called).toBe(false);
  expect(await readFile(join(orphan, 'important.txt'), 'utf8')).toBe('retain this evidence');
}, 20_000);
it('requires an active execution lease before invoking Sandcastle', async () => {
  const f = await fixture('lease'); await f.lease.release(); let called = false;
  await expect(transferSandcastleWorkspace(f.record, {
    async exec() { called = true; throw new Error('must not run'); }, async upload() { called = true; },
  }, { maxBundleBytes: 1_000_000, signal: new AbortController().signal })).rejects.toThrow();
  expect(called).toBe(false);
}, 20_000);

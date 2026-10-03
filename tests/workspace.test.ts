import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorkspace, inspectWorkspace, cleanupWorkspace } from '../src/workspace/index.js';
import { workspaceEnvironment, workspaceGit } from '../src/workspace/process.js';

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
const exists = (path: string) => access(path).then(() => true, () => false);
let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-workspace-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture(name: string) {
  const repoPath = join(root, name); await mkdir(repoPath);
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Local Fixture');
  await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\nignored/\n');
  const commits: string[] = [];
  for (let i = 1; i <= 3; i++) {
    await writeFile(join(repoPath, 'value.txt'), `version-${i}\n`);
    await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', `fixture ${i}`);
    commits.push(await git(repoPath, 'rev-parse', 'HEAD'));
  }
  return { repoPath, commits, runId: name, attemptId: 'one' };
}
const identity = (f: Awaited<ReturnType<typeof fixture>>, attemptId = f.attemptId) => ({ repoPath: f.repoPath, runId: f.runId, attemptId });

test('Sandcastle exact lock, official registry and package integrity are preserved', async () => {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  expect(lock.packages[''].dependencies['@ai-hero/sandcastle']).toBe('0.12.0');
  expect(lock.packages['node_modules/@ai-hero/sandcastle']).toMatchObject({
    version: '0.12.0', resolved: 'https://registry.npmjs.org/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz',
    integrity: 'sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==',
  });
  expect(Object.keys(lock.packages).some(name => /anthropic|claude.*sdk/i.test(name))).toBe(false);
});

test('parallel different-SHA attempts retain full history and independent edits with exact provenance', async () => {
  const f = await fixture('parallel');
  const [a, b] = await Promise.all([
    prepareWorkspace({ ...identity(f, 'a'), baseSha: f.commits[0], headSha: f.commits[2] }),
    prepareWorkspace({ ...identity(f, 'b'), baseSha: f.commits[1] }),
  ]);
  expect(a.record).toMatchObject({ status: 'ready', baseSha: f.commits[0], headSha: f.commits[2], mergeBaseSha: f.commits[0], initialHeadSha: f.commits[0] });
  for (const [attempt, sha] of [[a, f.commits[0]], [b, f.commits[1]]] as const) {
    expect(await git(attempt.record.worktreePath, 'rev-parse', 'HEAD')).toBe(sha);
    expect(await git(attempt.record.worktreePath, 'rev-parse', '--is-shallow-repository')).toBe('false');
    for (const commit of f.commits) expect(await git(attempt.record.worktreePath, 'cat-file', '-t', commit)).toBe('commit');
  }
  await writeFile(join(a.record.worktreePath, 'value.txt'), 'a\n');
  await writeFile(join(b.record.worktreePath, 'value.txt'), 'b\n');
  expect(await readFile(join(f.repoPath, 'value.txt'), 'utf8')).toBe('version-3\n');
  expect(await readFile(join(a.record.worktreePath, 'value.txt'), 'utf8')).toBe('a\n');
  expect(await readFile(join(b.record.worktreePath, 'value.txt'), 'utf8')).toBe('b\n');
  expect((await cleanupWorkspace(identity(f, 'a'))).record.status).toBe('preserved-dirty');
  expect((await cleanupWorkspace(identity(f, 'b'))).record.status).toBe('preserved-dirty');
}, 15_000);

test('same identity concurrent allocation admits one and cannot be reused even after clean close', async () => {
  const f = await fixture('race'); const options = { ...identity(f), baseSha: f.commits[0] };
  const outcomes = await Promise.allSettled([prepareWorkspace(options), prepareWorkspace(options)]);
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  const failed = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
  expect(String(failed.reason)).toMatch(/already allocated/);
  expect((await cleanupWorkspace(identity(f))).record.status).toBe('closed-clean');
  await expect(prepareWorkspace(options)).rejects.toThrow(/already allocated/);
});

test('clean removal retains output branch commits, main, immutable cleanup evidence and idempotent result', async () => {
  const f = await fixture('clean');
  const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[0] });
  await writeFile(join(a.record.worktreePath, 'output.txt'), 'committed output\n');
  await git(a.record.worktreePath, 'add', '.'); await git(a.record.worktreePath, 'commit', '-m', 'authored output');
  const outputSha = await git(a.record.worktreePath, 'rev-parse', 'HEAD');
  const first = await cleanupWorkspace(identity(f)); const second = await cleanupWorkspace(identity(f));
  expect(second).toEqual(first);
  expect(first.record).toMatchObject({ status: 'closed-clean', lastCleanup: { headSha: outputSha, branchRetained: true, worktreeStillExists: false } });
  expect(await exists(a.record.worktreePath)).toBe(false);
  expect(await git(f.repoPath, 'rev-parse', a.record.branch)).toBe(outputSha);
  expect(await git(f.repoPath, 'rev-parse', 'main')).toBe(f.commits[2]);
  expect(await exists(join(first.record.lastCleanup!.evidencePath, 'changes.patch'))).toBe(true);
  expect((await readFile(join(first.record.lastCleanup!.evidencePath, 'observation.json'), 'utf8'))).toContain(outputSha);
});

test('dirty cleanup retains binary and untracked bytes, archives patch, then explicit later cleanup can close', async () => {
  const f = await fixture('dirty'); const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[1] });
  await writeFile(join(a.record.worktreePath, 'value.txt'), 'changed\n');
  const bytes = Buffer.from([0, 255, 1, 128]);
  await writeFile(join(a.record.worktreePath, 'failure.bin'), bytes);
  const first = await cleanupWorkspace(identity(f));
  expect(first.record.status).toBe('preserved-dirty');
  expect(await readFile(join(a.record.worktreePath, 'failure.bin'))).toEqual(bytes);
  expect(await readFile(join(first.record.lastCleanup!.evidencePath, 'changes.patch'), 'utf8')).toContain('+changed');
  await git(a.record.worktreePath, 'add', '.'); await git(a.record.worktreePath, 'commit', '-m', 'retain diagnostic bytes');
  const second = await cleanupWorkspace(identity(f));
  expect(second.record.status).toBe('closed-clean');
  expect(await exists(first.record.lastCleanup!.evidencePath)).toBe(true);
  expect(second.record.lastCleanup!.evidencePath).not.toBe(first.record.lastCleanup!.evidencePath);
  const history = (await readFile(join(a.manifestPath, '..', 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(history.map(entry => entry.status)).toEqual(['allocating', 'ready', 'preserved-dirty', 'closed-clean']);
});

test('ignored untracked files prevent upstream forced removal even when Git status is clean', async () => {
  const f = await fixture('ignored'); const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[0] });
  await mkdir(join(a.record.worktreePath, 'ignored'));
  await writeFile(join(a.record.worktreePath, 'ignored', 'diagnostic.bin'), Buffer.from([0, 1, 2]));
  expect(await git(a.record.worktreePath, 'status', '--porcelain')).toBe('');
  const result = await cleanupWorkspace(identity(f));
  expect(result.record.status).toBe('preserved-dirty');
  expect(result.observation.untrackedPaths).toContain('ignored/diagnostic.bin');
  expect(await exists(join(a.record.worktreePath, 'ignored', 'diagnostic.bin'))).toBe(true);
});

test.each(['assume-unchanged', 'skip-worktree', 'both'] as const)('index %s flags preserve hidden tracked edits in coordinator and final bridge guard', async flag => {
  const f = await fixture(`index-${flag}`); const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[0] });
  const flags = flag === 'both' ? ['assume-unchanged', 'skip-worktree'] : [flag];
  for (const value of flags) await git(a.record.worktreePath, 'update-index', `--${value}`, 'value.txt');
  const indexBefore = await git(a.record.worktreePath, 'ls-files', '-v', '-z');
  const hiddenBytes = 'Uncommitted bytes hidden from Git status\n';
  await writeFile(join(a.record.worktreePath, 'value.txt'), hiddenBytes);
  expect(await git(a.record.worktreePath, 'status', '--porcelain')).toBe('');
  const expectedFlags = {
    assumeUnchangedPaths: flags.includes('assume-unchanged') ? ['value.txt'] : [],
    skipWorktreePaths: flags.includes('skip-worktree') ? ['value.txt'] : [],
  };
  const inspected = await inspectWorkspace(identity(f));
  expect(inspected.observation).toMatchObject({ dirty: false, cleanlinessVerified: false, indexFlags: expectedFlags });
  const result = await cleanupWorkspace(identity(f));
  expect(result.record.status).toBe('preserved-dirty');
  expect(result.observation.preservationReasons).toContain('Git index assume-unchanged or skip-worktree flags prevent verifying tracked-file cleanliness');
  expect(await readFile(join(a.record.worktreePath, 'value.txt'), 'utf8')).toBe(hiddenBytes);
  expect(await git(a.record.worktreePath, 'ls-files', '-v', '-z')).toBe(indexBefore);
  expect(JSON.parse(await readFile(join(result.record.lastCleanup!.evidencePath, 'index-flags.json'), 'utf8'))).toEqual(expectedFlags);
  expect(JSON.parse(await readFile(join(result.record.lastCleanup!.evidencePath, 'observation.json'), 'utf8'))).toMatchObject({ cleanlinessVerified: false, indexFlags: expectedFlags });
  // Independently test the destructive-step guard, even if the coordinator were bypassed or the index changed later.
  await expect(execute(process.execPath, ['--import', 'tsx', 'src/workspace/sandcastle-process.ts', 'cleanup', f.repoPath,
    a.record.branch, a.record.baseSha, a.record.worktreePath, a.record.baseSha], {
    cwd: resolve('.'), env: workspaceEnvironment(), timeout: 30_000,
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('flags prevent verifying tracked-file cleanliness') });
  expect(await readFile(join(a.record.worktreePath, 'value.txt'), 'utf8')).toBe(hiddenBytes);
  expect(await git(a.record.worktreePath, 'ls-files', '-v', '-z')).toBe(indexBefore);
  for (const value of flags) await git(a.record.worktreePath, 'update-index', `--no-${value}`, 'value.txt');
  expect((await cleanupWorkspace(identity(f))).record.status).toBe('preserved-dirty');
  await git(a.record.worktreePath, 'add', 'value.txt'); await git(a.record.worktreePath, 'commit', '-m', 'retain hidden tracked bytes');
  expect((await cleanupWorkspace(identity(f))).record.status).toBe('closed-clean');
}, 15_000);

test('unchanged flagged files are also retained until an operator explicitly restores index visibility', async () => {
  const f = await fixture('index-unchanged'); const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[0] });
  await git(a.record.worktreePath, 'update-index', '--assume-unchanged', 'value.txt');
  const result = await cleanupWorkspace(identity(f));
  expect(result.record.status).toBe('preserved-dirty');
  expect(result.observation).toMatchObject({ dirty: false, cleanlinessVerified: false });
  expect(await exists(a.record.worktreePath)).toBe(true);
  await git(a.record.worktreePath, 'update-index', '--no-assume-unchanged', 'value.txt');
  expect((await cleanupWorkspace(identity(f))).record.status).toBe('closed-clean');
});

test('local case-folding config cannot hide distinct untracked Linux paths from cleanup', async () => {
  const f = await fixture('ignorecase');
  await git(f.repoPath, 'config', 'core.ignoreCase', 'true');
  const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[0] });
  const bytes = Buffer.from([0, 255, 13, 128]);
  await writeFile(join(a.record.worktreePath, 'VALUE.txt'), bytes);
  expect(await git(a.record.worktreePath, '-c', 'core.ignoreCase=true', 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(await git(a.record.worktreePath, '-c', 'core.ignoreCase=true', 'ls-files', '--others', '-z')).toBe('');
  const result = await cleanupWorkspace(identity(f));
  expect(result.record.status).toBe('preserved-dirty');
  expect(result.observation).toMatchObject({ dirty: true, untrackedPaths: ['VALUE.txt'] });
  expect(JSON.parse(await readFile(join(result.record.lastCleanup!.evidencePath, 'untracked.json'), 'utf8'))).toEqual(['VALUE.txt']);
  await expect(execute(process.execPath, ['--import', 'tsx', 'src/workspace/sandcastle-process.ts', 'cleanup', f.repoPath,
    a.record.branch, a.record.baseSha, a.record.worktreePath, a.record.baseSha], {
    cwd: resolve('.'), env: workspaceEnvironment(), timeout: 30_000,
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Worktree changed during cleanup; retained') });
  expect(await readFile(join(a.record.worktreePath, 'VALUE.txt'))).toEqual(bytes);
  expect(await git(f.repoPath, 'config', '--local', '--get', 'core.ignoreCase')).toBe('true');
  await git(a.record.worktreePath, 'add', 'VALUE.txt'); await git(a.record.worktreePath, 'commit', '-m', 'retain case-distinct bytes');
  expect((await cleanupWorkspace(identity(f))).record.status).toBe('closed-clean');
}, 15_000);

test('pre-existing branch is never reused or reset and the failed lease is retained', async () => {
  const f = await fixture('existing'); const branch = `attempt/${f.runId}--one`;
  await git(f.repoPath, 'branch', branch, f.commits[0]);
  await expect(prepareWorkspace({ ...identity(f), baseSha: f.commits[2] })).rejects.toThrow(/Refuse existing/);
  expect(await git(f.repoPath, 'rev-parse', branch)).toBe(f.commits[0]);
  expect((await inspectWorkspace(identity(f))).record.status).toBe('allocation-failed');
  await expect(cleanupWorkspace(identity(f))).rejects.toThrow(/explicit recovery/);
});

test('orphan Sandcastle directories are retained instead of letting upstream pruning destroy them', async () => {
  const f = await fixture('orphan'); const orphan = join(f.repoPath, '.sandcastle', 'worktrees', 'unregistered-evidence');
  await mkdir(orphan, { recursive: true }); await writeFile(join(orphan, 'keep.txt'), 'retain\n');
  await expect(prepareWorkspace({ ...identity(f), baseSha: f.commits[0] })).rejects.toThrow(/Unregistered Sandcastle directory/);
  expect(await readFile(join(orphan, 'keep.txt'), 'utf8')).toBe('retain\n');
});

test('rejects mutable refs and unsafe IDs before allocating any attempt', async () => {
  const f = await fixture('invalid');
  await expect(prepareWorkspace({ ...identity(f), baseSha: 'main' })).rejects.toThrow(/immutable/);
  await expect(prepareWorkspace({ ...identity(f, '../outside'), baseSha: f.commits[0] })).rejects.toThrow();
  await expect(prepareWorkspace({ ...identity(f, 'double--delimiter'), baseSha: f.commits[0] })).rejects.toThrow();
  expect(await exists(join(f.repoPath, '.sandcastle'))).toBe(false);
});

test('rejects actual shallow clones and configured checkout filters', async () => {
  const f = await fixture('source'); const shallow = join(root, 'shallow');
  await execute('git', ['clone', '--depth=1', `file://${f.repoPath}`, shallow], {
    env: { ...workspaceEnvironment(), GIT_ALLOW_PROTOCOL: 'file' }, timeout: 10_000,
  });
  await expect(prepareWorkspace({ ...identity(f), repoPath: shallow, baseSha: f.commits[2] })).rejects.toThrow(/Full repository history/);
  await git(f.repoPath, 'config', 'filter.authored.smudge', 'echo MUST_NOT_EXECUTE');
  await expect(prepareWorkspace({ ...identity(f), baseSha: f.commits[2] })).rejects.toThrow(/checkout filters/);
});

test('rejects a symlinked management directory without writing outside the repository', async () => {
  const f = await fixture('symlink'); const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.repoPath, '.sandcastle'));
  await expect(prepareWorkspace({ ...identity(f), baseSha: f.commits[0] })).rejects.toThrow(/real directory/);
  expect(await exists(join(outside, 'flyrewheel-attempts'))).toBe(false);
});

test('changed worktree branch and tampered manifest refuse cleanup without deleting bytes', async () => {
  const f = await fixture('changed'); const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[0] });
  await git(a.record.worktreePath, 'switch', '-c', 'authored-other');
  expect((await inspectWorkspace(identity(f))).observation.identityValid).toBe(false);
  await expect(cleanupWorkspace(identity(f))).rejects.toThrow(/identity changed/);
  expect(await exists(a.record.worktreePath)).toBe(true);
  const manifest = JSON.parse(await readFile(a.manifestPath, 'utf8'));
  manifest.worktreePath = f.repoPath;
  await writeFile(a.manifestPath, JSON.stringify(manifest));
  await expect(cleanupWorkspace(identity(f))).rejects.toThrow(/path\/provenance mismatch/);
  expect(await exists(join(f.repoPath, 'value.txt'))).toBe(true);
});

test('lifecycle bridge does not execute ambient Git hooks or pass ambient credentials', async () => {
  const f = await fixture('hooks');
  await writeFile(join(f.repoPath, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nprintf forbidden > hook-executed\n', { mode: 0o755 });
  const env = workspaceEnvironment();
  expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.GIT_ALLOW_PROTOCOL).toBe('');
  const a = await prepareWorkspace({ ...identity(f), baseSha: f.commits[0] });
  expect(await exists(join(a.record.worktreePath, 'hook-executed'))).toBe(false);
  expect((await cleanupWorkspace(identity(f))).record.status).toBe('closed-clean');
});

test('real CLI prepare/inspect/cleanup survives separate processes and never offers arbitrary execution', async () => {
  const f = await fixture('cli'); const cwd = resolve('.');
  const cli = async (command: string, extra: string[] = []) => {
    const result = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'workspace', command,
      '--repo', f.repoPath, '--run', f.runId, '--attempt', f.attemptId, ...extra], { cwd, env: workspaceEnvironment(), timeout: 30_000 });
    return JSON.parse(result.stdout);
  };
  const prepared = await cli('prepare', ['--base', f.commits[0], '--head', f.commits[2]]);
  expect(prepared.record.status).toBe('ready');
  expect((await cli('inspect')).observation.currentHeadSha).toBe(f.commits[0]);
  expect((await cli('cleanup')).record.status).toBe('closed-clean');
  expect((await cli('inspect')).observation.branchRetained).toBe(true);
  const help = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'workspace', '--help'], { cwd, env: workspaceEnvironment(), timeout: 10_000 });
  expect(help.stdout).toContain('prepare'); expect(help.stdout).not.toMatch(/\n\s+exec /);
}, 20_000);

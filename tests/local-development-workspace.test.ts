import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createLocalDevelopmentWorkspace, inspectLocalDevelopmentWorkspace, createLocalDevelopmentResolver,
  cleanupLocalDevelopmentWorkspace, readLocalDevelopmentEvidence } from '../src/local-development-workspace.js';
import { workspaceGit } from '../src/workspace/process.js';
import { inspectWorkspace, acquireWorkspaceExecutionLease } from '../src/workspace/index.js';
import { digestOf } from '../src/core/identity.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'development-lifecycle-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const repoPath = join(directory, 'repo'); await mkdir(repoPath);
  const git = async (...args: string[]) => (await workspaceGit(repoPath, ...args)).trim();
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Authored Development Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\nignored/\n'); await writeFile(join(repoPath, 'source.txt'), 'first\n');
  await git('add', '.'); await git('commit', '-m', 'first'); const baseSha = await git('rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'source.txt'), 'second\n'); await git('add', '.'); await git('commit', '-m', 'second'); const headSha = await git('rev-parse', 'HEAD');
  const selection = { workspaceId: 'local-development-fixture', jobDigest: 'a'.repeat(64), repository: 'fixture:local-development', kind: 'semantic-review' as const, baseSha, headSha, expectedSha: headSha };
  return { repoPath, directory, git, selection };
}
it('creates only a fresh owned worktree, reopens evidence, resolves exact selection and removes the clean worktree', async () => {
  const f = await fixture(), created = await createLocalDevelopmentWorkspace({ repoPath: f.repoPath, selection: f.selection });
  const status = await inspectLocalDevelopmentWorkspace(created);
  expect(status).toMatchObject({ localDevelopment: 'ready', productionReady: false, fixedCommit: f.selection.headSha,
    capabilities: { physicalResourceDestruction: 'unsupported', wholeRuntimeStop: 'unsupported' } });
  const resolver = await createLocalDevelopmentResolver(created);
  expect(await resolver(f.selection, new AbortController().signal)).toEqual(created.receipt.workspace);
  await expect(resolver({ ...f.selection, expectedSha: f.selection.baseSha }, new AbortController().signal)).rejects.toThrow();
  const before = await readLocalDevelopmentEvidence(created, created.receipt.createdEvidenceDigest);
  expect(before.operation).toBe('created');
  const destroyed = await cleanupLocalDevelopmentWorkspace(JSON.parse(JSON.stringify(created)));
  expect(destroyed).toMatchObject({ state: 'closed-clean', cleanup: 'owned-clean-worktree-removed', worktreeExists: false,
    physicalDestruction: 'unsupported-not-claimed', productionReady: false });
  expect(await readLocalDevelopmentEvidence(created, created.receipt.createdEvidenceDigest)).toEqual(before);
  expect((await readLocalDevelopmentEvidence(created, destroyed.afterEvidence.digest)).operation).toBe('after-cleanup');
  expect(await readFile(join(f.repoPath, 'source.txt'), 'utf8')).toBe('second\n');
  expect(await f.git('rev-parse', 'HEAD')).toBe(f.selection.headSha);
  expect((await cleanupLocalDevelopmentWorkspace(created)).cleanup).toBe('owned-clean-worktree-removed');
});
it('preserves dirty/ignored data and refuses active leases or forged ownership', async () => {
  const f = await fixture(), created = await createLocalDevelopmentWorkspace({ repoPath: f.repoPath, selection: f.selection });
  const observed = await inspectWorkspace(created.receipt.workspace);
  const lease = await acquireWorkspaceExecutionLease(created.receipt.workspace, f.selection.headSha);
  await expect(cleanupLocalDevelopmentWorkspace(created)).rejects.toThrow('active'); await lease.release();
  await writeFile(join(observed.record.worktreePath, 'source.txt'), 'user modification\n');
  await mkdir(join(observed.record.worktreePath, 'ignored')); await writeFile(join(observed.record.worktreePath, 'ignored', 'keep.txt'), 'preserve');
  expect(await cleanupLocalDevelopmentWorkspace(created)).toMatchObject({ cleanup: 'retained', worktreeExists: true, state: 'preserved-dirty' });
  expect(await readFile(join(observed.record.worktreePath, 'source.txt'), 'utf8')).toBe('user modification\n');
  expect(await readFile(join(observed.record.worktreePath, 'ignored', 'keep.txt'), 'utf8')).toBe('preserve');
  const forged = structuredClone(created); forged.receipt.selection.repository = 'substituted'; forged.digest = digestOf(forged.receipt);
  await expect(cleanupLocalDevelopmentWorkspace(forged)).rejects.toThrow('ownership');
});
it('detects modified captured evidence before any cleanup', async () => {
  const f = await fixture(), created = await createLocalDevelopmentWorkspace({ repoPath: f.repoPath, selection: f.selection });
  const observed = await inspectWorkspace(created.receipt.workspace);
  const path = join(f.repoPath, '.sandcastle', 'flyrewheel-attempts', `attempt-local-development--${created.receipt.workspace.attemptId}`,
    'local-development-evidence', `${created.receipt.createdEvidenceDigest}.json`);
  await writeFile(path, '{}');
  await expect(cleanupLocalDevelopmentWorkspace(created)).rejects.toThrow('evidence');
  expect(await readFile(join(observed.record.worktreePath, 'source.txt'), 'utf8')).toBe('second\n');
});

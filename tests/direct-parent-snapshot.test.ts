import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureChangeSnapshot, captureDirectParentSnapshot, ChangeSnapshotPackageSchema, ChangeSnapshotSchema } from '../src/change-snapshot.js';
import { GithubPrEvidenceSchema } from '../src/github-pr-evidence.js';
import { EvaluationDatasetSchema } from '../src/core/paired-evaluation.js';
import { recaptureEvaluationSnapshot } from '../src/evaluation-workspace-input.js';
import { workspaceEnvironment } from '../src/workspace/process.js';
const exec = promisify(execFile);
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'direct-parent-'));
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo, env: { ...workspaceEnvironment(),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).stdout.trim();
  await git('init', '-q'); await mkdir(join(repo, 'unchanged'));
  await writeFile(join(repo, 'unchanged', 'file'), 'not captured\n');
  await writeFile(join(repo, 'file'), 'ancestor\n'); await git('add', '.'); await git('commit', '-qm', 'ancestor');
  const ancestor = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'file'), 'parent\n'); await git('add', '.'); await git('commit', '-qm', 'parent');
  const parent = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'file'), 'child\n'); await git('add', '.'); await git('commit', '-qm', 'child');
  const head = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, '.git/shallow'), parent + '\n');
  await git('config', 'remote.unavailable.promisor', 'true');
  await git('config', 'remote.unavailable.url', 'https://example.invalid/never-fetch');
  const removeObject = async (id: string) => rm(join(repo, '.git/objects', id.slice(0, 2), id.slice(2)));
  await removeObject(ancestor);
  return { repo, git, ancestor, parent, head, removeObject, input: { repositoryPath: repo, repositoryId: 'fixture', baseTip: parent, head } };
}
it('captures original direct edge without ancestor objects and preserves shallow/promisor markers', async () => {
  const f = await fixture();
  try {
    const config = await readFile(join(f.repo, '.git/config'));
    const result = await captureDirectParentSnapshot(f.input);
    expect(result.receipt.kind).toBe('local-direct-parent-check');
    expect(result.snapshot).toMatchObject({ comparison: 'direct-parent-to-head', evidenceScope: 'verified-direct-parent-only', mergeBase: f.parent,
      coverage: { changedPaths: 1, capturedSides: 2, excludedSides: 0 } });
    expect(ChangeSnapshotPackageSchema.parse(result).digest).toBe(result.digest);
    expect(await readFile(join(f.repo, '.git/config'))).toEqual(config);
    expect(await readFile(join(f.repo, '.git/shallow'), 'utf8')).toBe(f.parent + '\n');
    expect(await f.git('cat-file', 'commit', f.parent)).toContain(`parent ${f.ancestor}`);
    await expect(captureChangeSnapshot(f.input)).rejects.toThrow('complete local commit history');
    const unmarked = { ...result.snapshot }; delete unmarked.evidenceScope;
    expect(ChangeSnapshotSchema.safeParse(unmarked).success).toBe(false);
    expect(ChangeSnapshotSchema.safeParse({ ...result.snapshot, comparison: 'merge-base-to-head' }).success).toBe(false);
    expect(GithubPrEvidenceSchema.shape.snapshot.safeParse(result.snapshot).success).toBe(false);
    expect(EvaluationDatasetSchema.shape.prs.element.shape.snapshot.safeParse(result).success).toBe(false);
    await expect(recaptureEvaluationSnapshot(result, f.repo)).rejects.toThrow('direct-parent scope');
  } finally { await rm(f.repo, { recursive: true, force: true }); }
}, 30_000);
it.each(['changed-blob', 'unchanged-subtree', 'commit'] as const)('fails with missing %s instead of fetching or filling evidence', async kind => {
  const f = await fixture();
  try {
    const id = kind === 'commit' ? f.head : await f.git('rev-parse', kind === 'changed-blob' ? `${f.head}:file` : `${f.head}:unchanged`);
    await f.removeObject(id);
    await expect(captureDirectParentSnapshot(f.input)).rejects.toThrow();
  } finally { await rm(f.repo, { recursive: true, force: true }); }
}, 30_000);
it('rejects a wrong parent and changed bytes beyond capture limits', async () => {
  const f = await fixture();
  try {
    await expect(captureDirectParentSnapshot({ ...f.input, baseTip: f.head })).rejects.toThrow('single original parent');
    await expect(captureDirectParentSnapshot({ ...f.input, limits: { maxChanges: 10, maxBlobBytes: 1, maxTotalBytes: 100 } })).rejects.toThrow('every changed side');
  } finally { await rm(f.repo, { recursive: true, force: true }); }
}, 30_000);
it('rejects binary changed evidence and graft files without manufacturing a partial result', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'file'), Buffer.from([0, 1, 255])); await f.git('add', '.'); await f.git('commit', '-qm', 'binary');
    const head = await f.git('rev-parse', 'HEAD');
    await expect(captureDirectParentSnapshot({ ...f.input, baseTip: f.head, head })).rejects.toThrow('every changed side');
    await writeFile(join(f.repo, '.git/info/grafts'), f.head + '\n');
    await expect(captureDirectParentSnapshot(f.input)).rejects.toThrow('grafted ancestry');
  } finally { await rm(f.repo, { recursive: true, force: true }); }
}, 30_000);

it.each(['commit', 'tree', 'blob'] as const)('rejects corrupted %s identity even when Git can decode the object', async type => {
  const f = await fixture();
  try {
    const id = type === 'commit' ? f.head : await f.git('rev-parse', type === 'tree' ? `${f.head}^{tree}` : `${f.head}:file`);
    const original = (await exec('git', ['cat-file', type, id], { cwd: f.repo, env: workspaceEnvironment(), encoding: 'buffer' })).stdout;
    const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
    await f.removeObject(id); // Git loose objects are read-only; replace only this disposable fixture object.
    await writeFile(join(f.repo, '.git/objects', id.slice(0, 2), id.slice(2)), deflateSync(Buffer.concat([Buffer.from(`${type} ${changed.length}\0`), changed])));
    await expect(captureDirectParentSnapshot(f.input)).rejects.toThrow(/identity/);
  } finally { await rm(f.repo, { recursive: true, force: true }); }
}, 30_000);
it('CLI missing-object failure creates neither database nor output', async () => {
  const f = await fixture();
  try {
    await f.removeObject(await f.git('rev-parse', `${f.head}:file`));
    const db = join(f.repo, 'capture-db'), out = join(f.repo, 'capture.json');
    await expect(exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'snapshots', 'capture-direct-parent',
      '--repo', f.repo, '--repository-id', 'fixture', '--parent', f.parent, '--head', f.head, '--db', db, '--out', out],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000 })).rejects.toMatchObject({ code: 1 });
    await expect(readFile(out)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(db)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(f.repo, { recursive: true, force: true }); }
}, 30_000);

import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { deriveEvaluationRepository, evaluationWorkspaceBinding, exportEvaluationCheckout, verifyEvaluationRepository, type EvaluationVisibilityManifest } from '../src/workspace/evaluation-checkout.js';
import { boundedProcessBytes, workspaceGit } from '../src/workspace/process.js';
import { prepareWorkspace } from '../src/workspace/index.js';
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'eval-storage-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source);
  await git(source, 'init', '--quiet', '--template=');
  await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'x'), 'allowed'); await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'allowed');
  const allowed = await git(source, 'rev-parse', 'HEAD');
  await writeFile(join(source, 'x'), 'FUTURE_SECRET'); await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'future');
  const future = await git(source, 'rev-parse', 'HEAD');
  const manifest: EvaluationVisibilityManifest = { schemaVersion: 1, repositoryId: 'authored/storage', classification: 'development-fixture',
    allowedHeads: [allowed], checkoutSha: allowed, visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: null, evidenceDigests: [] } };
  const storePath = join(root, 'store'), repoPath = join(root, 'derived');
  const baseline = await exportEvaluationCheckout({ repoPath: source, storePath, manifest });
  const binding = evaluationWorkspaceBinding('storage-fixture', baseline);
  await deriveEvaluationRepository({ repoPath, storePath, manifest, binding });
  return { root, source, repoPath, allowed, future, binding };
}
it('rejects a future-only orphan pack even when Git indexed inventory cannot see it', async () => {
  const f = await fixture();
  const before = await git(f.repoPath, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)');
  const pack = await boundedProcessBytes('/usr/bin/git', ['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--no-reuse-object', '--window=0'],
    f.source, 1_000_000, true, 10_000, Buffer.from(`${f.future}\n^${f.allowed}\n`));
  const name = `pack-${pack.subarray(-20).toString('hex')}.pack`;
  await writeFile(join(f.repoPath, '.git/objects/pack', name), pack);
  expect(await git(f.repoPath, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)')).toBe(before);
  await expect(git(f.repoPath, 'cat-file', '-e', f.future)).rejects.toThrow();
  await expect(verifyEvaluationRepository(f.repoPath, f.binding)).rejects.toThrow('pack/index pair is incomplete');
}, 20_000);
it.each(['symlink', 'hardlink'] as const)('rejects %s packed ref storage', async kind => {
  const f = await fixture(); await git(f.repoPath, 'pack-refs', '--all');
  const path = join(f.repoPath, '.git/packed-refs'), outside = join(f.root, 'shared-refs');
  await writeFile(outside, await readFile(path)); await rm(path);
  if (kind === 'symlink') await symlink(outside, path); else await link(outside, path);
  await expect(verifyEvaluationRepository(f.repoPath, f.binding)).rejects.toThrow('Unsafe or oversized evaluation storage file');
}, 20_000);
it('rejects orphan reverse-index files rather than treating hidden bytes as verified history', async () => {
  const f = await fixture();
  await writeFile(join(f.repoPath, '.git/objects/pack', `pack-${'0'.repeat(40)}.rev`), 'FUTURE_SECRET');
  await expect(verifyEvaluationRepository(f.repoPath, f.binding)).rejects.toThrow('pack/index pair is incomplete');
}, 20_000);
it('does not mistake ordinary parent request/manifest files for an evaluation baseline', async () => {
  const f = await fixture(), ordinary = join(f.root, 'repo'); await mkdir(ordinary);
  await git(ordinary, 'init', '--quiet', '--template=');
  await git(ordinary, 'config', 'user.name', 'Fixture'); await git(ordinary, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(ordinary, 'x'), 'ordinary'); await git(ordinary, 'add', '.'); await git(ordinary, 'commit', '-qm', 'ordinary');
  await writeFile(join(f.root, 'request.json'), '{}'); await writeFile(join(f.root, 'manifest.json'), '{}');
  const prepared = await prepareWorkspace({ repoPath: ordinary, runId: 'ordinary', attemptId: 'one', baseSha: await git(ordinary, 'rev-parse', 'HEAD') });
  expect(prepared.record).toMatchObject({ status: 'ready' }); expect(prepared.record).not.toHaveProperty('evaluation');
}, 20_000);

it('verifies existing Git reverse-index bytes without repairing altered storage', async () => {
  const f = await fixture();
  const directory = join(f.repoPath, '.git/objects/pack');
  const pack = (await readdir(directory)).find(name => name.endsWith('.pack'))!;
  await git(f.repoPath, 'index-pack', '--rev-index', join(directory, pack));
  const path = join(directory, (await readdir(directory)).find(name => name.endsWith('.rev'))!);
  const original = await readFile(path);
  await verifyEvaluationRepository(f.repoPath, f.binding);
  expect(await readFile(path)).toEqual(original);
  await rm(path); await writeFile(path, Buffer.concat([original, Buffer.from('FUTURE_SECRET')]));
  await expect(verifyEvaluationRepository(f.repoPath, f.binding)).rejects.toThrow(/trailing garbage/);
  expect(await readFile(path)).toEqual(Buffer.concat([original, Buffer.from('FUTURE_SECRET')]));
}, 20_000);

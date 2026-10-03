import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { exportEvaluationCheckout, inspectEvaluationCheckout, type EvaluationVisibilityManifest, EVALUATION_CHECKOUT_LIMITS } from '../src/workspace/evaluation-checkout.js';
import { digestOf } from '../src/core/identity.js';
const exec = promisify(execFile), roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await exec('/usr/bin/git', args, { cwd, maxBuffer: 10_000_000,
  env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Development fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Development fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'evaluation-checkout-test-')); roots.push(root);
  const repoPath = join(root, 'source'), storePath = join(root, 'store'); await mkdir(repoPath);
  await git(repoPath, 'init', '--quiet', '--template='); await mkdir(join(repoPath, 'src')); await mkdir(join(repoPath, 'tests'));
  await writeFile(join(repoPath, 'src/code.ts'), 'export const answer = "unknown";\n');
  await writeFile(join(repoPath, 'tests/code.test.ts'), '// Entire committed tests remain available\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-qm', 'Base development fixture'); const base = await git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'README.md'), 'Allowed documentation\n'); await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-qm', 'Allowed head'); const head = await git(repoPath, 'rev-parse', 'HEAD');
  await git(repoPath, 'checkout', '-qb', 'future-answer');
  await writeFile(join(repoPath, 'src/code.ts'), 'export const answer = "FUTURE_ANSWER_SECRET";\n');
  await writeFile(join(repoPath, 'future-answer.txt'), 'FUTURE_ANSWER_SECRET\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-qm', 'Future answer with deliberately old timestamp'); const future = await git(repoPath, 'rev-parse', 'HEAD');
  await git(repoPath, 'tag', '-am', 'Future explanation', 'future-answer-tag'); const tag = await git(repoPath, 'rev-parse', 'future-answer-tag');
  await git(repoPath, 'update-ref', 'refs/notes/future-answer', future);
  await writeFile(join(repoPath, 'reflog-answer.txt'), 'REFLOG_ONLY_FUTURE_ANSWER\n'); await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-qm', 'Reflog-only future answer');
  const reflog = await git(repoPath, 'rev-parse', 'HEAD'); await git(repoPath, 'reset', '--hard', future);
  await writeFile(join(root, 'dangling.txt'), 'DANGLING_FUTURE_ANSWER\n'); const dangling = await git(repoPath, 'hash-object', '-w', join(root, 'dangling.txt'));
  const manifest: EvaluationVisibilityManifest = { schemaVersion: 1, repositoryId: 'fixture/evaluation-isolation', classification: 'development-fixture',
    allowedHeads: [head], checkoutSha: head, visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: '2001-01-01T00:00:00Z', evidenceDigests: [] } };
  return { root, repoPath, storePath, manifest, base, head, future, tag, dangling, reflog };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('exports exactly allowed reachable objects, full source/tests tree, and synthetic refs without future answers', async () => {
  const f = await fixture(); const sourceRefs = await git(f.repoPath, 'show-ref');
  // Repack future/allowed history together, exercising exclusion within shared packs.
  await git(f.repoPath, 'repack', '-ad');
  const result = await exportEvaluationCheckout(f);
  expect(await git(f.repoPath, 'show-ref')).toBe(sourceRefs);
  expect(await git(f.repoPath, 'status', '--porcelain')).toBe('');
  expect(await readFile(join(result.repoPath, 'src/code.ts'), 'utf8')).toContain('unknown');
  expect(await readFile(join(result.repoPath, 'tests/code.test.ts'), 'utf8')).toContain('Entire committed tests');
  expect(await readFile(join(result.repoPath, 'README.md'), 'utf8')).toContain('Allowed documentation');
  await expect(readFile(join(result.repoPath, 'future-answer.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const sha of [f.future, f.tag, f.dangling, f.reflog]) await expect(git(result.repoPath, 'cat-file', '-e', sha)).rejects.toThrow();
  expect(await git(result.repoPath, 'cat-file', '-t', f.base)).toBe('commit');
  expect(await git(result.repoPath, 'for-each-ref', '--format=%(refname)')).toBe(`refs/heads/allowed-${f.head}`);
  expect(await git(result.repoPath, 'remote')).toBe('');
  expect(result.observation).toEqual({ objectClosureVerified: true, exactRefsVerified: true, fullCommittedTreeVerified: true, historicalPublicAvailability: 'unproven', executionSandbox: false });
  expect(result.record.timestampsEstablishVisibility).toBe(false);
  expect(result.record.request.classification).toBe('development-fixture');
  expect(JSON.stringify(result.record)).not.toContain(f.repoPath);
  // Dates are all identical, including the excluded future answer.
  expect(await git(f.repoPath, 'show', '-s', '--format=%ct', f.future)).toBe(await git(f.repoPath, 'show', '-s', '--format=%ct', f.head));
  expect(result.recordDigest).toBe(digestOf(result.record));
  expect(await inspectEvaluationCheckout(f)).toEqual(result);
  expect(await exportEvaluationCheckout(f)).toEqual(result);
}, 20_000);

test('canonicalizes a union of allowed heads and produces path-independent stable manifests', async () => {
  const f = await fixture(); await git(f.repoPath, 'checkout', '-qb', 'allowed-side', f.base);
  await writeFile(join(f.repoPath, 'side.txt'), 'Allowed independent side history\n'); await git(f.repoPath, 'add', '.'); await git(f.repoPath, 'commit', '-qm', 'Side');
  const side = await git(f.repoPath, 'rev-parse', 'HEAD'); f.manifest.allowedHeads.push(side);
  const a = await exportEvaluationCheckout(f);
  const b = await exportEvaluationCheckout({ ...f, storePath: join(f.root, 'store2'), manifest: { ...f.manifest, allowedHeads: [...f.manifest.allowedHeads].reverse() } });
  expect(a.record.inventory).toEqual(b.record.inventory); expect(a.requestDigest).toBe(b.requestDigest);
  expect(await git(a.repoPath, 'cat-file', '-t', side)).toBe('commit');
  expect(await git(a.repoPath, 'show', `${side}:side.txt`)).toContain('Allowed independent');
  await expect(git(a.repoPath, 'cat-file', '-e', f.future)).rejects.toThrow();
}, 20_000);

test.each(['empty', 'duplicate', 'abbreviated', 'revision-expression', 'tag-object', 'missing', 'checkout-not-allowed', 'false-proof'] as const)('rejects invalid visibility input: %s', async mode => {
  const f = await fixture(); const manifest: any = structuredClone(f.manifest);
  if (mode === 'empty') manifest.allowedHeads = [];
  if (mode === 'duplicate') manifest.allowedHeads.push(f.head);
  if (mode === 'abbreviated') manifest.allowedHeads = [f.head.slice(0, 8)];
  if (mode === 'revision-expression') manifest.allowedHeads = ['HEAD~1'];
  if (mode === 'tag-object') { manifest.allowedHeads = [f.tag]; manifest.checkoutSha = f.tag; }
  if (mode === 'missing') { manifest.allowedHeads = ['f'.repeat(40)]; manifest.checkoutSha = 'f'.repeat(40); }
  if (mode === 'checkout-not-allowed') manifest.checkoutSha = f.future;
  if (mode === 'false-proof') manifest.visibility.historicalPublicAvailability = 'proven';
  await expect(exportEvaluationCheckout({ ...f, manifest })).rejects.toThrow();
  await expect(readdir(f.storePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['shallow', 'alternates', 'http-alternates', 'grafts', 'commondir', 'promisor-config', 'promisor-pack', 'include', 'filter', 'replace', 'object-symlink', 'object-hardlink'] as const)('fails closed on unsupported source storage: %s', async mode => {
  const f = await fixture();
  const file = { shallow: '.git/shallow', alternates: '.git/objects/info/alternates', 'http-alternates': '.git/objects/info/http-alternates', grafts: '.git/info/grafts', commondir: '.git/commondir', 'promisor-pack': '.git/objects/pack/future.promisor' }[mode as string];
  if (file) { await mkdir(join(f.repoPath, file, '..'), { recursive: true }); await writeFile(join(f.repoPath, file), mode === 'shallow' ? f.head + '\n' : ''); }
  if (mode === 'promisor-config') await git(f.repoPath, 'config', 'remote.origin.promisor', 'true');
  if (mode === 'include') await git(f.repoPath, 'config', 'include.path', join(f.root, 'external-config'));
  if (mode === 'filter') await git(f.repoPath, 'config', 'filter.evil.smudge', `touch ${join(f.root, 'MUST_NOT_RUN')}`);
  if (mode === 'replace') await git(f.repoPath, 'replace', f.head, f.future);
  if (mode === 'object-symlink') await symlink(join(f.root, 'dangling.txt'), join(f.repoPath, '.git/objects/leak'));
  if (mode === 'object-hardlink') await link(join(f.root, 'dangling.txt'), join(f.repoPath, '.git/objects/leak'));
  await expect(exportEvaluationCheckout(f)).rejects.toThrow();
  await expect(readFile(join(f.root, 'MUST_NOT_RUN'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['object', 'ref', 'tracked', 'untracked', 'ignored', 'index-flag', 'metadata', 'remote', 'head', 'record', 'pack-hardlink', 'config-comment', 'empty-git-directory', 'empty-worktree-directory', 'nested-git-file', 'nested-git-directory'] as const)('reinspection and rerun reject tampering without replacement: %s', async mode => {
  const f = await fixture(), a = await exportEvaluationCheckout(f);
  const oldManifest = await readFile(a.manifestPath, 'utf8');
  if (mode === 'object') await git(a.repoPath, 'hash-object', '-w', join(f.root, 'dangling.txt'));
  if (mode === 'ref') await git(a.repoPath, 'update-ref', 'refs/tags/extra', f.head);
  if (mode === 'tracked') await writeFile(join(a.repoPath, 'src/code.ts'), 'Changed');
  if (mode === 'untracked') await writeFile(join(a.repoPath, 'extra.txt'), 'Future answer');
  if (mode === 'ignored') { await writeFile(join(a.repoPath, '.gitignore'), 'ignored\n'); await writeFile(join(a.repoPath, 'ignored'), 'Future answer'); }
  if (mode === 'index-flag') await git(a.repoPath, 'update-index', '--assume-unchanged', 'src/code.ts');
  if (mode === 'metadata') await writeFile(join(a.repoPath, '.git/future-answer.txt'), 'Future answer');
  if (mode === 'remote') await git(a.repoPath, 'remote', 'add', 'future-source', f.repoPath);
  if (mode === 'head') await writeFile(join(a.repoPath, '.git/HEAD'), f.base + '\n');
  if (mode === 'record') { const record = JSON.parse(oldManifest); record.inventory.digest = 'f'.repeat(64); await writeFile(a.manifestPath, JSON.stringify(record)); }
  if (mode === 'pack-hardlink') { const pack = (await readdir(join(a.repoPath, '.git/objects/pack'))).find(f => f.endsWith('.pack'))!; await link(join(a.repoPath, '.git/objects/pack', pack), join(f.root, 'hardlinked-pack')); }
  if (mode === 'config-comment') await writeFile(join(a.repoPath, '.git/config'), await readFile(join(a.repoPath, '.git/config'), 'utf8') + '\n# FUTURE_ANSWER\n');
  if (mode === 'empty-git-directory') await mkdir(join(a.repoPath, '.git/FUTURE_ANSWER'));
  if (mode === 'empty-worktree-directory') await mkdir(join(a.repoPath, 'FUTURE_ANSWER'));
  if (mode === 'nested-git-file') await writeFile(join(a.repoPath, 'src/.git'), 'FUTURE_ANSWER');
  if (mode === 'nested-git-directory') { await mkdir(join(a.repoPath, 'src/.git')); await writeFile(join(a.repoPath, 'src/.git/secret.txt'), 'FUTURE_ANSWER'); }
  const damaged = await readFile(a.manifestPath, 'utf8');
  await expect(inspectEvaluationCheckout(f)).rejects.toThrow();
  await expect(exportEvaluationCheckout(f)).rejects.toThrow();
  expect(await readFile(a.manifestPath, 'utf8')).toBe(damaged);
}, 20_000);

test.each(['symlink', 'gitlink', 'crlf', 'ident'] as const)('refuses incomplete or transformed checkout trees: %s', async mode => {
  const f = await fixture(); await git(f.repoPath, 'checkout', '-q', '--detach', f.head);
  if (mode === 'symlink') await symlink(f.repoPath, join(f.repoPath, 'outside'));
  if (mode === 'gitlink') await git(f.repoPath, 'update-index', '--add', '--cacheinfo', `160000,${f.base},submodule`);
  if (mode === 'crlf') await writeFile(join(f.repoPath, '.gitattributes'), '*.ts text eol=crlf\n');
  if (mode === 'ident') { await writeFile(join(f.repoPath, '.gitattributes'), '*.ts ident\n'); await writeFile(join(f.repoPath, 'src/code.ts'), '// $Id$\n'); }
  if (mode !== 'gitlink') await git(f.repoPath, 'add', '.'); await git(f.repoPath, 'commit', '-qm', mode);
  const head = await git(f.repoPath, 'rev-parse', 'HEAD'); f.manifest.allowedHeads = [head]; f.manifest.checkoutSha = head;
  await expect(exportEvaluationCheckout(f)).rejects.toThrow();
  if (mode === 'crlf' || mode === 'ident') {
    const entries = await readdir(f.storePath); expect(entries).toHaveLength(1);
    await expect(readFile(join(f.storePath, entries[0], 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(exportEvaluationCheckout(f)).rejects.toThrow('incomplete');
  }
});

test('rejects nested and symlinked store paths, and does not run target hook code', async () => {
  const f = await fixture();
  await expect(exportEvaluationCheckout({ ...f, storePath: join(f.repoPath, 'exports') })).rejects.toThrow('independent');
  await mkdir(join(f.root, 'real-store')); await symlink(join(f.root, 'real-store'), f.storePath);
  await expect(exportEvaluationCheckout(f)).rejects.toThrow();
  await mkdir(join(f.repoPath, '.git/hooks'));
  await writeFile(join(f.repoPath, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${join(f.root, 'MUST_NOT_RUN')}\n`, { mode: 0o755 });
  await exportEvaluationCheckout({ ...f, storePath: join(f.root, 'safe-store') });
  await expect(readFile(join(f.root, 'MUST_NOT_RUN'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('missing reachable object fails before publishing a completion manifest', async () => {
  const f = await fixture(); const blob = await git(f.repoPath, 'rev-parse', `${f.head}:src/code.ts`);
  await rm(join(f.repoPath, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  await expect(exportEvaluationCheckout(f)).rejects.toThrow();
  await expect(readdir(f.storePath)).rejects.toMatchObject({ code: 'ENOENT' });
});


test('bounds highly compressed individual objects before producing an export', async () => {
  const f = await fixture();
  await git(f.repoPath, 'checkout', '-q', '--detach', f.head);
  await writeFile(join(f.repoPath, 'too-large.bin'), Buffer.alloc(EVALUATION_CHECKOUT_LIMITS.objectBytes + 1));
  await git(f.repoPath, 'add', '.'); await git(f.repoPath, 'commit', '-qm', 'Oversized compressed fixture');
  const head = await git(f.repoPath, 'rev-parse', 'HEAD'); f.manifest.allowedHeads = [head]; f.manifest.checkoutSha = head;
  await expect(exportEvaluationCheckout(f)).rejects.toThrow('Individual Git object byte limit');
  await expect(readdir(f.storePath)).rejects.toMatchObject({ code: 'ENOENT' });
}, 20_000);

test('bounds checkout bytes even when many files share one admissible Git blob', async () => {
  const f = await fixture();
  await git(f.repoPath, 'checkout', '-q', '--detach', f.head);
  await writeFile(join(f.root, 'large-blob'), Buffer.alloc(EVALUATION_CHECKOUT_LIMITS.objectBytes));
  const oid = await git(f.repoPath, 'hash-object', '-w', join(f.root, 'large-blob'));
  for (let i = 0; i < 5; i++) await git(f.repoPath, 'update-index', '--add', '--cacheinfo', `100644,${oid},copy-${i}.bin`);
  await git(f.repoPath, 'commit', '-qm', 'Repeated blob exceeds tree bound');
  const head = await git(f.repoPath, 'rev-parse', 'HEAD'); f.manifest.allowedHeads = [head]; f.manifest.checkoutSha = head;
  await expect(exportEvaluationCheckout(f)).rejects.toThrow('Checkout byte limit');
  await expect(readdir(f.storePath)).rejects.toMatchObject({ code: 'ENOENT' });
}, 20_000);

test('independent filesystem inventory refuses FIFOs without opening them', async () => {
  const f = await fixture(), a = await exportEvaluationCheckout(f);
  await exec('mkfifo', [join(a.repoPath, 'src/future-pipe')]);
  await expect(inspectEvaluationCheckout(f)).rejects.toThrow('filesystem entry');
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { captureRepositoryContext, validateRepositoryContext, RepositoryContextPackageSchema, DEFAULT_REPOSITORY_CONTEXT_LIMITS,
  repositoryContextSource, verifyRepositoryContext, validateRepositoryContextForSnapshot, makeRepositoryContextAnchor,
  validateRepositoryContextAnchor, makeRepositoryContextEvidence, validateRepositoryContextEvidence, readRepositoryContextPackage } from '../src/repository-context.js';
import { captureChangeSnapshot, validateChangeSnapshot } from '../src/change-snapshot.js';
import { SnapshotAnchorSchema, ReviewEvidenceSchema } from '../src/core/semantic-review-evidence.js';
import { digestOf } from '../src/core/identity.js';
import { workspaceEnvironment } from '../src/workspace/process.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase } from '../src/storage/database.js';

const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qe-context-')), repo = join(directory, 'repo'); await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo, env: { ...workspaceEnvironment(),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } })).stdout.trim();
  await git('init', '-qb', 'main'); await mkdir(join(repo, 'tests'));
  const contract = '\ufeff// contract 😀\r\nexport const limit = 7;\n// replacement \ufffd is valid UTF-8\n';
  for (const [path, text] of Object.entries({ 'changed.ts': 'before\n', 'contract.ts': contract, 'old test.ts': 'unchanged test body\n',
    'tests/keep.ts': 'test contract\n', 'literal*.ts': 'literal star\n', ':colon': 'colon\n', '--leading': 'leading\n', 'empty.ts': '',
    'executable.sh': '#!/bin/sh\ntouch SHOULD_NEVER_EXECUTE\n', '.gitattributes': '*.ts filter=trap diff=trap\n' })) await writeFile(join(repo, path), text);
  await chmod(join(repo, 'executable.sh'), 0o755);
  await git('add', '.'); await git('commit', '-qm', 'base'); const baseTip = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'changed.ts'), 'after\n'); await rename(join(repo, 'old test.ts'), join(repo, 'new\ttest\n.ts'));
  await writeFile(join(repo, 'binary'), Buffer.from([0, 1, 255])); await writeFile(join(repo, 'non-utf8'), Buffer.from([255, 254]));
  await writeFile(join(repo, 'oversize'), 'x'.repeat(262_145)); await symlink('/outside/repository/must/not/be/read', join(repo, 'link'));
  await git('add', '.'); await git('update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},submodule`);
  await git('commit', '-qm', 'review head'); const head = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'contract.ts'), '// future context MUST NOT LEAK\n');
  await git('add', '.'); await git('commit', '-qm', 'future'); const future = await git('rev-parse', 'HEAD');
  return { directory, repo, git, baseTip, head, future, contract,
    input: { repositoryPath: repo, repositoryId: 'fixture/context', head, paths: ['contract.ts', 'tests/keep.ts'] } };
}

it('captures unchanged contracts/tests from the exact head, independently of worktree, refs, or selection order', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'contract.ts'), 'dirty future worktree');
    const value = await captureRepositoryContext(f.input);
    expect(value.receipt.kind).toBe('local-git-check');
    expect(repositoryContextSource(value, 'contract.ts')).toBe(f.contract);
    expect(value.context.coverage).toEqual({ selectedPaths: 2, capturedPaths: 2, excludedPaths: 0, missingPaths: 0,
      capturedBytes: Buffer.byteLength(f.contract) + Buffer.byteLength('test contract\n'), scope: 'selected-paths-only', historicalAvailability: 'unproven' });
    const snapshot = await captureChangeSnapshot({ repositoryPath: f.repo, repositoryId: f.input.repositoryId, baseTip: f.baseTip, head: f.head });
    expect(snapshot.snapshot.changes.some(change => change.after.state !== 'absent' && change.after.path === 'contract.ts')).toBe(false);
    expect(validateRepositoryContextForSnapshot(value, snapshot)).toMatchObject({ contextDigest: value.digest, snapshotDigest: snapshot.digest, head: f.head });
    await f.git('branch', '-f', 'different-ref', f.baseTip);
    const again = await captureRepositoryContext({ ...f.input, paths: [...f.input.paths].reverse() });
    expect(again.context).toEqual(value.context); expect(again.digest).toBe(value.digest);
    expect(await readFile(join(f.repo, 'contract.ts'), 'utf8')).toBe('dirty future worktree');
    const base = await captureRepositoryContext({ ...f.input, head: f.baseTip });
    expect(repositoryContextSource(base, 'contract.ts')).toBe(f.contract); expect(base.digest).not.toBe(value.digest);
    expect(() => validateRepositoryContextForSnapshot(base, snapshot)).toThrow('exact snapshot repository and review head');
    const future = await captureRepositoryContext({ ...f.input, head: f.future });
    expect(() => validateRepositoryContextForSnapshot(future, snapshot)).toThrow('exact snapshot repository and review head');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('selects literal UTF-8 paths, records renames/missing/directory paths, and never recursively crawls unselected non-UTF-8 names', async () => {
  const f = await fixture();
  try {
    await writeFile(Buffer.concat([Buffer.from(f.repo + '/'), Buffer.from([255])]), 'unselected invalid filename');
    await f.git('add', '.'); await f.git('commit', '-qm', 'unselected invalid filename'); const head = await f.git('rev-parse', 'HEAD');
    const paths = ['new\ttest\n.ts', 'old test.ts', 'tests', 'tests/keep.ts', 'literal*.ts', 'contract*', ':(glob)**', ':colon', '--leading', 'missing/file'];
    const value = await captureRepositoryContext({ ...f.input, head, paths });
    expect(value.context.entries).toHaveLength(paths.length);
    expect(value.context.entries.find(entry => entry.path === 'tests')).toMatchObject({ state: 'excluded', reason: 'directory', mode: '040000', byteLength: null, sha256: null });
    for (const path of ['old test.ts', 'contract*', ':(glob)**', 'missing/file']) expect(value.context.entries.find(entry => entry.path === path)).toEqual({ state: 'missing', path });
    expect(repositoryContextSource(value, 'literal*.ts')).toBe('literal star\n');
    expect(repositoryContextSource(value, ':colon')).toBe('colon\n'); expect(repositoryContextSource(value, '--leading')).toBe('leading\n');
    const old = await captureRepositoryContext({ ...f.input, head: f.baseTip, paths: ['old test.ts', 'new\ttest\n.ts'] });
    expect(repositoryContextSource(old, 'old test.ts')).toBe(repositoryContextSource(value, 'new\ttest\n.ts'));
    expect(old.context.entries[0].state).toBe('missing');
    const subdirectory = await captureRepositoryContext({ ...f.input, repositoryPath: join(f.repo, 'tests'), paths: ['tests/keep.ts'] });
    expect(repositoryContextSource(subdirectory, 'tests/keep.ts')).toBe('test contract\n');
    await expect(captureRepositoryContext({ ...f.input, paths: ['\ud800'] })).rejects.toThrow('UTF-8');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('explicitly excludes binary, invalid UTF-8, symlinks, gitlinks and oversize files without running configured filters/hooks or executable source', async () => {
  const f = await fixture();
  try {
    const marker = join(f.directory, 'MUST_NOT_RUN');
    await f.git('config', 'filter.trap.smudge', `touch ${marker}`); await f.git('config', 'filter.trap.clean', `touch ${marker}`);
    await f.git('config', 'diff.trap.textconv', `touch ${marker}`); await f.git('config', 'core.fsmonitor', `touch ${marker}`);
    await mkdir(join(f.directory, 'hooks')); await writeFile(join(f.directory, 'hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(join(f.directory, 'hooks/post-checkout'), 0o755); await f.git('config', 'core.hooksPath', join(f.directory, 'hooks'));
    const value = await captureRepositoryContext({ ...f.input, paths: ['binary', 'non-utf8', 'oversize', 'link', 'link/nested', 'submodule', 'submodule/nested', 'executable.sh', 'contract.ts', 'empty.ts'] });
    const entry = (path: string) => value.context.entries.find(entry => entry.path === path);
    for (const path of ['binary', 'non-utf8']) expect(entry(path)).toMatchObject({ state: 'excluded', reason: 'binary', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(entry('oversize')).toMatchObject({ state: 'excluded', reason: 'oversize', byteLength: 262_145, sha256: null });
    expect(entry('link')).toMatchObject({ state: 'excluded', reason: 'symlink', sha256: null });
    expect(entry('submodule')).toMatchObject({ state: 'excluded', reason: 'submodule', byteLength: null, sha256: null });
    expect(entry('submodule/nested')).toMatchObject({ state: 'missing' }); expect(entry('link/nested')).toMatchObject({ state: 'missing' });
    expect(entry('executable.sh')).toMatchObject({ state: 'captured', mode: '100755' }); expect(repositoryContextSource(value, 'empty.ts')).toBe('');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(f.repo, 'SHOULD_NEVER_EXECUTE'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(repositoryContextSource(value, 'contract.ts')).toBe(f.contract);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('rejects unsafe paths, duplicate/empty/over-limit selections and mutable refs before capturing', async () => {
  const f = await fixture();
  try {
    for (const paths of [[], ['contract.ts', 'contract.ts'], ['../contract.ts'], ['/contract.ts'], ['a//b'], ['a/./b'], ['a\\b'], ['a\0b'], ['a'.repeat(4097)], Array.from({ length: 129 }, (_, i) => String(i))]) {
      await expect(captureRepositoryContext({ ...f.input, paths })).rejects.toThrow();
    }
    await expect(captureRepositoryContext({ ...f.input, head: 'HEAD' })).rejects.toThrow();
    await expect(captureRepositoryContext({ ...f.input, head: 'a'.repeat(40) })).rejects.toThrow();
    await expect(captureRepositoryContext({ ...f.input, limits: { ...DEFAULT_REPOSITORY_CONTEXT_LIMITS, maxPaths: 1 } })).rejects.toThrow('no truncated context');
    const value = await captureRepositoryContext({ ...f.input, paths: ['contract.ts', 'tests/keep.ts', 'empty.ts'], limits: { maxPaths: 3, maxBlobBytes: 20, maxTotalBytes: 1 } });
    expect(value.context.entries).toMatchObject([{ reason: 'oversize' }, { state: 'captured' }, { reason: 'total-byte-limit' }]);
    expect(value.context.coverage.capturedBytes).toBe(0);
    await expect(captureRepositoryContext({ ...f.input, limits: { ...DEFAULT_REPOSITORY_CONTEXT_LIMITS, maxTotalBytes: 2_097_153 } })).rejects.toThrow();
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001);
    try { await expect(captureRepositoryContext(f.input)).rejects.toThrow('aggregate deadline'); } finally { clock.mockRestore(); }
    for (let i = 0; i < 33; i++) await writeFile(join(f.repo, `raw${i}`), Buffer.alloc(262_144));
    await f.git('add', '.'); await f.git('commit', '-qm', 'binary budget');
    await expect(captureRepositoryContext({ ...f.input, head: await f.git('rev-parse', 'HEAD'), paths: Array.from({ length: 33 }, (_, i) => `raw${i}`) })).rejects.toThrow('blob-read budget');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('rejects incomplete local repositories, grafts and missing selected blobs without any lazy fetch', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, '.git/shallow'), `${f.head}\n`);
    await expect(captureRepositoryContext(f.input)).rejects.toThrow('complete local commit history'); await rm(join(f.repo, '.git/shallow'));
    await writeFile(join(f.repo, '.git/info/grafts'), `${f.head}\n`);
    await expect(captureRepositoryContext(f.input)).rejects.toThrow('grafted'); await rm(join(f.repo, '.git/info/grafts'));
    await f.git('config', 'remote.fake.promisor', 'true'); await f.git('config', 'remote.fake.url', 'https://invalid.example/repo');
    await expect(captureRepositoryContext(f.input)).rejects.toThrow('partial/promisor'); await f.git('config', '--unset', 'remote.fake.promisor');
    const blob = await f.git('rev-parse', `${f.head}:contract.ts`);
    await rm(join(f.repo, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    await expect(captureRepositoryContext(f.input)).rejects.toThrow();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('validates immutable package counters, encoding and identities while distinguishing fabricated internally consistent claims from local Git verification', async () => {
  const f = await fixture();
  try {
    const value = await captureRepositoryContext(f.input);
    expect(RepositoryContextPackageSchema.parse(value).digest).toBe(value.digest);
    expect((await verifyRepositoryContext(value, f.repo)).digest).toBe(value.digest);
    const entry = value.context.entries[0]; if (entry.state !== 'captured') throw new Error('fixture');
    for (const patch of [{ sha256: 'f'.repeat(64) }, { objectId: 'e'.repeat(40) }, { bytesBase64: entry.bytesBase64 + '=' }, { byteLength: 1 }]) {
      expect(() => validateRepositoryContext({ ...value.context, entries: [{ ...entry, ...patch }, ...value.context.entries.slice(1)] })).toThrow();
    }
    expect(() => RepositoryContextPackageSchema.parse({ ...value, digest: 'a'.repeat(64) })).toThrow('digest mismatch');
    expect(() => validateRepositoryContext({ ...value.context, entries: [...value.context.entries].reverse() })).toThrow('canonical');
    expect(() => validateRepositoryContext({ ...value.context, entries: [entry, entry] })).toThrow('unique');
    expect(() => validateRepositoryContext({ ...value.context, coverage: { ...value.context.coverage, capturedPaths: 0 } })).toThrow('coverage');
    expect(() => validateRepositoryContext({ ...value.context, verified: true })).toThrow();
    // Byte hashes cannot authenticate repository identity or prove that a claimed commit contains those paths.
    const fabricated = validateRepositoryContext({ ...value.context, head: f.future });
    expect(RepositoryContextPackageSchema.parse({ ...fabricated, receipt: value.receipt }).digest).toBe(fabricated.digest);
    await expect(verifyRepositoryContext(fabricated, f.repo)).rejects.toThrow('exact local Git commit/path bindings');
    const wrongMode = validateRepositoryContext({ ...value.context, entries: [{ ...entry, mode: '100755' }, ...value.context.entries.slice(1)] });
    await expect(verifyRepositoryContext(wrongMode, f.repo)).rejects.toThrow('exact local Git commit/path bindings');
    const file = join(f.directory, 'context.json'); await writeFile(file, JSON.stringify(value));
    expect((await readRepositoryContextPackage(file)).digest).toBe(value.digest);
    await writeFile(file, Buffer.from([255])); await expect(readRepositoryContextPackage(file)).rejects.toThrow();
    await writeFile(file, ' '.repeat(5_000_001)); await expect(readRepositoryContextPackage(file)).rejects.toThrow('exceeds 5MB');
    await expect(readRepositoryContextPackage(f.directory)).rejects.toThrow('regular file');
    const fifo = join(f.directory, 'pipe'); await exec('mkfifo', [fifo]);
    await expect(readRepositoryContextPackage(fifo)).rejects.toThrow('regular file');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('creates typed exact-source citations without laundering them into accepted snapshot evidence', async () => {
  const f = await fixture();
  try {
    const value = await captureRepositoryContext(f.input), start = f.contract.indexOf('export'), end = f.contract.indexOf(';') + 1;
    const anchor = makeRepositoryContextAnchor(value, 'contract.ts', start, end);
    expect(validateRepositoryContextAnchor(anchor, value)).toBe('export const limit = 7;');
    const evidence = makeRepositoryContextEvidence(value, anchor, 'callee-contract');
    expect(validateRepositoryContextEvidence(evidence, value)).toEqual(evidence);
    expect(SnapshotAnchorSchema.safeParse(anchor).success).toBe(false); expect(ReviewEvidenceSchema.safeParse(evidence).success).toBe(false);
    for (const patch of [{ head: f.future }, { repositoryId: 'other/repository' }, { contextDigest: 'a'.repeat(64) }, { objectId: 'a'.repeat(40) },
      { mode: '100755' as const }, { sourceDigest: 'a'.repeat(64) }, { path: 'tests/keep.ts' }]) {
      expect(() => validateRepositoryContextAnchor({ ...anchor, ...patch }, value)).toThrow();
    }
    const badSpan = structuredClone(anchor); badSpan.span.start.column++;
    expect(() => validateRepositoryContextAnchor(badSpan, value)).toThrow('exact source offset');
    expect(() => makeRepositoryContextAnchor(value, 'contract.ts', 0, 0)).toThrow('nonempty');
    expect(() => makeRepositoryContextAnchor(value, 'contract.ts', 0, 999999)).toThrow('bounds');
    expect(() => makeRepositoryContextAnchor(value, 'unselected.ts', 0, 1)).toThrow('no captured source');
    expect(() => validateRepositoryContextEvidence({ ...evidence, content: 'fabricated' }, value)).toThrow('identity/excerpt');
    expect(() => validateRepositoryContextEvidence({ ...evidence, id: 'a'.repeat(64) }, value)).toThrow('identity/excerpt');
    expect(() => repositoryContextSource({ ...value, digest: 'a'.repeat(64) }, 'contract.ts')).toThrow('digest mismatch');
    const excluded = await captureRepositoryContext({ ...f.input, paths: ['binary', 'link', 'missing'] });
    for (const path of ['binary', 'link', 'missing']) expect(() => makeRepositoryContextAnchor(excluded, path, 0, 1)).toThrow('no captured source');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('preflights exact snapshot bindings and rejects conflicting overlap, including renames onto deleted paths', async () => {
  const f = await fixture();
  try {
    const snapshot = await captureChangeSnapshot({ repositoryPath: f.repo, repositoryId: f.input.repositoryId, baseTip: f.baseTip, head: f.head });
    const value = await captureRepositoryContext({ ...f.input, paths: ['changed.ts', 'old test.ts', 'new\ttest\n.ts'] });
    expect(validateRepositoryContextForSnapshot(value, snapshot).head).toBe(f.head);
    expect(() => validateRepositoryContextForSnapshot(validateRepositoryContext({ ...value.context, repository: { ...value.context.repository, id: 'wrong' } }), snapshot)).toThrow('repository and review head');
    const captured = value.context.entries.find(entry => entry.path === 'changed.ts')!;
    const wrong = validateRepositoryContext({ ...value.context, entries: value.context.entries.map(entry => entry === captured ? { ...entry, mode: '100755' } : entry) });
    expect(() => validateRepositoryContextForSnapshot(wrong, snapshot)).toThrow('conflicts');
    if (captured.state !== 'captured') throw new Error('fixture');
    const { bytesBase64, ...binaryIdentity } = captured;
    const contradictory = validateRepositoryContext({ ...value.context,
      entries: [{ ...binaryIdentity, state: 'excluded', reason: 'binary' }],
      coverage: { ...value.context.coverage, selectedPaths: 1, capturedPaths: 0, excludedPaths: 1, missingPaths: 0, capturedBytes: 0 } });
    expect(() => validateRepositoryContextForSnapshot(contradictory, snapshot)).toThrow('conflicts');
    // Represent a deletion at the new name followed by an exact rename to that name.
    const renameChange = snapshot.snapshot.changes.find(change => change.status === 'R100')!;
    const before = renameChange.before; if (before.state !== 'captured') throw new Error('fixture');
    const replacementSnapshot = validateChangeSnapshot({ ...snapshot.snapshot,
      changes: [{ status: 'D', before: { ...before, path: 'new\ttest\n.ts' }, after: { state: 'absent' } }, renameChange],
      coverage: { changedPaths: 2, capturedSides: 3, excludedSides: 0, capturedBytes: before.byteLength * 3, scope: 'changed-entries-only' } });
    expect(validateRepositoryContextForSnapshot(value, replacementSnapshot).contextDigest).toBe(value.digest);
    expect(() => validateRepositoryContextForSnapshot(value, { ...snapshot, digest: 'a'.repeat(64) })).toThrow('digest mismatch');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('persists atomically/idempotently, rejects mutation, and reopens and validates citations without the source repository', async () => {
  const f = await fixture(); let store: QualEvoStore | undefined;
  try {
    const value = await captureRepositoryContext(f.input), path = join(f.directory, 'db');
    const evidence = makeRepositoryContextEvidence(value, makeRepositoryContextAnchor(value, 'tests/keep.ts', 0, 4), 'test');
    const db = await openPGliteDatabase(path); store = await QualEvoStore.initialize(db);
    const [first, again] = await Promise.all([store.importRepositoryContext(value.context), store.importRepositoryContext(value.context)]);
    expect(first).toEqual(again); expect(first).toEqual({ digest: value.digest, context: value.context }); expect(first).not.toHaveProperty('receipt');
    await expect(db.query('UPDATE qe_repository_contexts SET repository_id=$1 WHERE digest=$2', ['tamper', value.digest])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM qe_repository_contexts WHERE digest=$1', [value.digest])).rejects.toThrow('append-only');
    expect(await store.listRepositoryContexts({ head: f.future })).toEqual([]); expect(await store.listRepositoryContexts({ repositoryId: 'other' })).toEqual([]);
    expect(await store.listRepositoryContexts({ head: f.head, limit: 1 })).toEqual([first]); expect(await store.listRepositoryContexts({ after: value.digest })).toEqual([]);
    await expect(store.importRepositoryContext({ ...value.context, coverage: { ...value.context.coverage, selectedPaths: 0 } })).rejects.toThrow();
    expect(await store.listRepositoryContexts()).toHaveLength(1);
    await store.close(); store = undefined; await rm(f.repo, { recursive: true, force: true });
    store = await QualEvoStore.openPGlite(path);
    expect(validateRepositoryContextEvidence(evidence, await store.getRepositoryContext(value.digest))).toEqual(evidence);
    await store.close(); store = undefined;
    const corrupted = await openPGliteDatabase(path); store = await QualEvoStore.initialize(corrupted);
    await corrupted.exec('ALTER TABLE qe_repository_contexts DISABLE TRIGGER qe_repository_contexts_immutable');
    await corrupted.query('UPDATE qe_repository_contexts SET head_sha=$1 WHERE digest=$2', [f.future, value.digest]);
    await expect(store.getRepositoryContext(value.digest)).rejects.toThrow('identity mismatch');
  } finally { await store?.close(); await rm(f.directory, { recursive: true, force: true }); }
}, 60_000);

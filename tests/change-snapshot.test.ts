import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rm, rename, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { captureChangeSnapshot, ChangeSnapshotSchema, ChangeSnapshotPackageSchema, validateChangeSnapshot, DEFAULT_SNAPSHOT_LIMITS, SNAPSHOT_MAX_JSON_BYTES } from '../src/change-snapshot.js';
import { digestOf } from '../src/core/identity.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase } from '../src/storage/database.js';
import { workspaceEnvironment } from '../src/workspace/process.js';

const exec = promisify(execFile);
it('round-trips a near-content-limit package with formatting and receipt overhead', () => {
  const bytes = Buffer.alloc(4096, 97);
  const objectId = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const stored = validateChangeSnapshot({
    schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: 'review', identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: '1'.repeat(40), mergeBase: '2'.repeat(40), head: '3'.repeat(40),
    comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    coverage: { changedPaths: 500, capturedSides: 500, excludedSides: 0, capturedBytes: bytes.length * 500, scope: 'changed-entries-only' },
    changes: Array.from({ length: 500 }, (_, i) => ({ status: 'A', before: { state: 'absent' }, after: {
      state: 'captured', path: String(i).padStart(4, '0') + '/' + ('a'.repeat(199) + '/').repeat(10) + 'z'.repeat(100) + '/' + 'z'.repeat(165),
      mode: '100644', objectId, sha256, byteLength: bytes.length, bytesBase64: bytes.toString('base64'),
    } })),
  });
  const text = JSON.stringify({ ...stored, receipt: { kind: 'package-integrity-only' } }, null, 2) + '\n';
  expect(Buffer.byteLength(text)).toBeGreaterThan(4_000_000);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SNAPSHOT_MAX_JSON_BYTES);
  expect(ChangeSnapshotPackageSchema.parse(JSON.parse(text)).digest).toBe(stored.digest);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qe-snapshot-'));
  const repo = join(directory, 'repo'); await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo, env: { ...workspaceEnvironment(),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } })).stdout.trim();
  await git('init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries({ 'modify.ts': 'old\r\n', 'delete.ts': 'delete me\n', 'old name.ts': 'rename me\n', 'mode.sh': '#!/bin/sh\n', 'type.ts': 'regular\n' })) await writeFile(join(repo, name), text);
  await git('add', '.'); await git('commit', '-qm', 'base fixture');
  const mergeBase = await git('rev-parse', 'HEAD');
  await git('checkout', '-qb', 'topic');
  await writeFile(join(repo, 'modify.ts'), '\ufeffnew\r\nreplacement \ufffd\n');
  await rm(join(repo, 'delete.ts')); await rename(join(repo, 'old name.ts'), join(repo, 'new\tname\n.ts'));
  await chmod(join(repo, 'mode.sh'), 0o755);
  await rm(join(repo, 'type.ts')); await symlink('/a/target/that/must/not/be/read', join(repo, 'type.ts'));
  await writeFile(join(repo, 'added.ts'), 'added\n'); await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 255]));
  await writeFile(join(repo, 'invalid-utf8.bin'), Buffer.from([255, 254]));
  await writeFile(join(repo, 'oversize.ts'), 'x'.repeat(262_145));
  await git('add', '.'); await git('update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},submodule`);
  await git('commit', '-qm', 'head fixture'); const head = await git('rev-parse', 'HEAD');
  await git('checkout', '-q', 'main'); await writeFile(join(repo, 'base-only.ts'), 'new on base\n');
  await git('add', '.'); await git('commit', '-qm', 'divergent base tip'); const baseTip = await git('rev-parse', 'HEAD');
  return { directory, repo, git, mergeBase, head, baseTip,
    input: { repositoryPath: repo, repositoryId: 'fixture/project', baseTip, head } };
}

it('freezes exact merge-base/head bytes, statuses, exclusions and stable content across dirty checkout/ref movement', async () => {
  const f = await fixture();
  try {
    // Local diff preferences must not suppress gitlinks or turn off the declared rename policy.
    await f.git('config', 'diff.ignoreSubmodules', 'all'); await f.git('config', 'diff.renames', 'false');
    await writeFile(join(f.repo, 'modify.ts'), 'uncommitted must not enter evidence');
    const result = await captureChangeSnapshot(f.input), snapshot = result.snapshot;
    expect(snapshot.baseTip).toBe(f.baseTip); expect(snapshot.mergeBase).toBe(f.mergeBase); expect(snapshot.head).toBe(f.head);
    expect(snapshot.mergeBase).not.toBe(snapshot.baseTip); expect(result.receipt.kind).toBe('local-git-check');
    const byPath = (path: string) => snapshot.changes.find(c => c.after.state !== 'absent' && c.after.path === path)!;
    expect(byPath('base-only.ts')).toBeUndefined(); expect(byPath('added.ts').status).toBe('A');
    expect(snapshot.changes.some(c => c.status === 'D' && c.before.state !== 'absent' && c.before.path === 'delete.ts')).toBe(true);
    expect(byPath('new\tname\n.ts').status).toBe('R100');
    expect(byPath('mode.sh')).toMatchObject({ status: 'M', before: { mode: '100644' }, after: { mode: '100755' } });
    expect(byPath('type.ts')).toMatchObject({ status: 'T', after: { state: 'excluded', reason: 'symlink', sha256: null } });
    expect(byPath('submodule').after).toMatchObject({ state: 'excluded', reason: 'submodule', objectId: 'e'.repeat(40), byteLength: null, sha256: null });
    for (const path of ['binary.bin', 'invalid-utf8.bin']) expect(byPath(path).after).toMatchObject({ state: 'excluded', reason: 'binary', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(byPath('oversize.ts').after).toMatchObject({ state: 'excluded', reason: 'oversize', byteLength: 262_145, sha256: null });
    const changed = byPath('modify.ts');
    expect(changed.before.state).toBe('captured'); expect(changed.after.state).toBe('captured');
    if (changed.before.state === 'captured' && changed.after.state === 'captured') {
      expect(Buffer.from(changed.before.bytesBase64, 'base64')).toEqual(Buffer.from('old\r\n'));
      expect(Buffer.from(changed.after.bytesBase64, 'base64')).toEqual(Buffer.from('\ufeffnew\r\nreplacement \ufffd\n'));
    }
    await f.git('branch', '-f', 'topic', f.baseTip);
    const again = await captureChangeSnapshot(f.input); expect(again.digest).toBe(result.digest); expect(again.snapshot).toEqual(snapshot);
    expect(await readFile(join(f.repo, 'modify.ts'), 'utf8')).toBe('uncommitted must not enter evidence');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('bounds inventory, per-blob and aggregate coverage without silently truncating entries', async () => {
  const f = await fixture();
  try {
    await expect(captureChangeSnapshot({ ...f.input, limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxChanges: 1 } })).rejects.toThrow('no truncated snapshot');
    const { snapshot } = await captureChangeSnapshot({ ...f.input, limits: { maxChanges: 20, maxBlobBytes: 10, maxTotalBytes: 6 } });
    expect(snapshot.changes.length).toBe(10);
    expect(snapshot.coverage.capturedBytes).toBe(6);
    expect(snapshot.changes.flatMap(c => [c.before, c.after]).some(s => s.state === 'excluded' && s.reason === 'total-byte-limit')).toBe(true);
    expect(ChangeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const empty = await captureChangeSnapshot({ ...f.input, baseTip: f.head });
    expect(empty.snapshot.coverage).toMatchObject({ changedPaths: 0, capturedBytes: 0 });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('retains deletion plus exact rename onto that deleted path and rejects ambiguous ancestry', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'a.txt'), 'X'); await writeFile(join(f.repo, 'b.txt'), 'Y');
    await f.git('add', '.'); await f.git('commit', '-qm', 'replacement base'); const baseTip = await f.git('rev-parse', 'HEAD');
    await rm(join(f.repo, 'a.txt')); await writeFile(join(f.repo, 'b.txt'), 'X');
    await f.git('add', '.'); await f.git('commit', '-qm', 'replacement head'); const head = await f.git('rev-parse', 'HEAD');
    const { snapshot } = await captureChangeSnapshot({ ...f.input, baseTip, head });
    expect(snapshot.changes).toHaveLength(2);
    // This Git version represents replacement as D(a)+M(b). The equivalent
    // exact-rename inventory D(b)+R(a,b) must also be structurally representable.
    expect(snapshot.changes.map(change => change.status)).toEqual(['D', 'M']);
    const replacement = structuredClone(snapshot);
    replacement.changes = [
      { status: 'D', before: snapshot.changes[1].before, after: { state: 'absent' } },
      { status: 'R100', before: snapshot.changes[0].before, after: snapshot.changes[1].after },
    ];
    expect(ChangeSnapshotSchema.parse(replacement).changes.map(change => change.status)).toEqual(['D', 'R100']);
    const tree = await f.git('rev-parse', `${baseTip}^{tree}`);
    const left = await f.git('commit-tree', tree, '-p', baseTip, '-m', 'left');
    const right = await f.git('commit-tree', tree, '-p', baseTip, '-m', 'right');
    const firstMerge = await f.git('commit-tree', tree, '-p', left, '-p', right, '-m', 'first');
    const secondMerge = await f.git('commit-tree', tree, '-p', right, '-p', left, '-m', 'second');
    await expect(captureChangeSnapshot({ ...f.input, baseTip: firstMerge, head: secondMerge })).rejects.toThrow('exactly one common merge base');
    const unrelated = await f.git('commit-tree', tree, '-m', 'unrelated');
    await expect(captureChangeSnapshot({ ...f.input, head: unrelated })).rejects.toThrow();
    await writeFile(join(f.repo, '.git/shallow'), `${baseTip}\n`);
    await expect(captureChangeSnapshot({ ...f.input, baseTip, head })).rejects.toThrow('complete local commit history');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('enforces aggregate capture time and a distinct binary-inclusive blob-read budget', async () => {
  const f = await fixture();
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001);
    try { await expect(captureChangeSnapshot(f.input)).rejects.toThrow('aggregate deadline'); }
    finally { clock.mockRestore(); }
    for (let index = 0; index < 33; index++) await writeFile(join(f.repo, `binary-${String(index).padStart(2, '0')}`), Buffer.alloc(262_144));
    await f.git('add', '.'); await f.git('commit', '-qm', 'large binary inventory');
    await expect(captureChangeSnapshot({ ...f.input, head: await f.git('rev-parse', 'HEAD') })).rejects.toThrow('blob-read budget');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('rejects mutable refs, missing commits/blobs, grafts, partial history and non-UTF-8 paths', async () => {
  const f = await fixture();
  try {
    await expect(captureChangeSnapshot({ ...f.input, head: 'topic' })).rejects.toThrow();
    await expect(captureChangeSnapshot({ ...f.input, head: 'a'.repeat(40) })).rejects.toThrow();
    await writeFile(join(f.repo, '.git/info/grafts'), `${f.head}\n`);
    await expect(captureChangeSnapshot(f.input)).rejects.toThrow('grafted'); await rm(join(f.repo, '.git/info/grafts'));
    await f.git('config', 'remote.fake.promisor', 'true');
    await expect(captureChangeSnapshot(f.input)).rejects.toThrow('partial/promisor'); await f.git('config', '--unset', 'remote.fake.promisor');
    const badPath = Buffer.concat([Buffer.from(f.repo + '/'), Buffer.from([0xff])]);
    await writeFile(badPath, 'not a UTF-8 path'); await f.git('add', '.'); await f.git('commit', '-qm', 'invalid filename');
    await expect(captureChangeSnapshot({ ...f.input, head: await f.git('rev-parse', 'HEAD') })).rejects.toThrow();
    const id = await f.git('rev-parse', `${f.head}:added.ts`);
    await rm(join(f.repo, '.git/objects', id.slice(0, 2), id.slice(2)));
    await expect(captureChangeSnapshot(f.input)).rejects.toThrow();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('validates internal byte/digest/coverage consistency, strict schemas and limits without authenticating imports', async () => {
  const f = await fixture();
  try {
    const result = await captureChangeSnapshot(f.input);
    expect(ChangeSnapshotPackageSchema.parse(result).digest).toBe(result.digest);
    const corrupt = structuredClone(result.snapshot);
    const side = corrupt.changes.flatMap(c => [c.before, c.after]).find(s => s.state === 'captured')!;
    if (side.state !== 'captured') throw new Error('fixture');
    side.bytesBase64 = Buffer.from('tampered').toString('base64');
    expect(() => validateChangeSnapshot(corrupt)).toThrow('integrity');
    expect(() => ChangeSnapshotPackageSchema.parse({ ...result, digest: '0'.repeat(64) })).toThrow('digest');
    expect(() => validateChangeSnapshot({ ...result.snapshot, coverage: { ...result.snapshot.coverage, excludedSides: 0 } })).toThrow('Coverage');
    expect(() => validateChangeSnapshot({ ...result.snapshot, verified: true })).toThrow();
    expect(() => validateChangeSnapshot({ ...result.snapshot, limits: { ...result.snapshot.limits, maxBlobBytes: 999_999_999 } })).toThrow();
    expect(() => validateChangeSnapshot({ ...result.snapshot, prMetadata: { provider: 'github', repository: 'claimed/repo', number: 1 } })).toThrow();
    const metadata = { verification: 'caller-supplied-unverified' as const, provider: 'github', repository: 'claimed/repo', number: 1 };
    expect(validateChangeSnapshot({ ...result.snapshot, prMetadata: metadata }).snapshot.prMetadata).toEqual(metadata);
    // An internally consistent fabricated ancestry remains package-only, not a proof of Git relationships.
    const declared = { ...result.snapshot, mergeBase: 'a'.repeat(40) };
    expect(ChangeSnapshotPackageSchema.parse({ snapshot: declared, digest: digestOf(declared) }).snapshot.mergeBase).toBe('a'.repeat(40));
    const contradictory = structuredClone(result.snapshot);
    const text = contradictory.changes.flatMap(c => [c.before, c.after]).find(s => s.state === 'captured')!;
    const omitted = contradictory.changes.flatMap(c => [c.before, c.after]).find(s => s.state === 'excluded' && s.reason === 'oversize')!;
    if (text.state === 'captured' && omitted.state === 'excluded') omitted.objectId = text.objectId;
    expect(() => validateChangeSnapshot(contradictory)).toThrow('Contradictory');
    const wrongRename = structuredClone(result.snapshot);
    const renamed = wrongRename.changes.find(c => c.status === 'R100')!;
    if (renamed.after.state !== 'absent') renamed.after = { ...renamed.after, mode: '120000', state: 'excluded', reason: 'symlink', byteLength: renamed.after.byteLength, sha256: null };
    expect(() => validateChangeSnapshot(wrongRename)).toThrow('matching Git object types');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

it('persists atomically/idempotently, paginates, rejects mutation and reopens without the source repository', async () => {
  const f = await fixture();
  let store: QualEvoStore | undefined;
  try {
    const result = await captureChangeSnapshot(f.input), path = join(f.directory, 'db');
    const db = await openPGliteDatabase(path); store = await QualEvoStore.initialize(db);
    const records = await Promise.all([store.importChangeSnapshot(result.snapshot), store.importChangeSnapshot(result.snapshot)]);
    expect(records[0]).toEqual(records[1]); expect(records[0]).toEqual({ digest: result.digest, snapshot: result.snapshot });
    await expect(db.query('UPDATE qe_change_snapshots SET repository_id=$1 WHERE digest=$2', ['tamper', result.digest])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM qe_change_snapshots WHERE digest=$1', [result.digest])).rejects.toThrow('append-only');
    expect(await store.listChangeSnapshots({ repositoryId: 'other' })).toEqual([]);
    expect(await store.listChangeSnapshots({ limit: 1 })).toEqual([records[0]]);
    expect(await store.listChangeSnapshots({ after: result.digest })).toEqual([]);
    await expect(store.importChangeSnapshot({ ...result.snapshot, coverage: { ...result.snapshot.coverage, capturedBytes: 999 } })).rejects.toThrow();
    expect(await store.listChangeSnapshots()).toHaveLength(1);
    await store.close(); store = undefined; await rm(f.repo, { recursive: true, force: true });
    store = await QualEvoStore.openPGlite(path);
    expect(await store.getChangeSnapshot(result.digest)).toEqual(records[0]);
    // Simulated disk/database corruption must fail on read even with a syntactically valid payload.
    await store.close(); store = undefined;
    const corruptedDb = await openPGliteDatabase(path); store = await QualEvoStore.initialize(corruptedDb);
    await corruptedDb.exec('ALTER TABLE qe_change_snapshots DISABLE TRIGGER qe_change_snapshots_immutable');
    await corruptedDb.query('UPDATE qe_change_snapshots SET repository_id=$1 WHERE digest=$2', ['tamper', result.digest]);
    await expect(store.getChangeSnapshot(result.digest)).rejects.toThrow('identity mismatch');
  } finally { await store?.close(); await rm(f.directory, { recursive: true, force: true }); }
}, 60_000);

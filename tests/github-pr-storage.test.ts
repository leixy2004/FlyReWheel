import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DEFAULT_SNAPSHOT_LIMITS, integrityReceipt, validateChangeSnapshot } from '../src/change-snapshot.js';
import { GithubPrEvidencePackageSchema, validateGithubPrEvidence, GITHUB_PR_MAX_JSON_BYTES } from '../src/github-pr-evidence.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { QualEvoStore } from '../src/storage/store.js';

const date = '2026-10-01T00:00:00Z';
function fixture() {
  const base = '1'.repeat(40), head = '2'.repeat(40), repository = 'fixture/project', url = `https://github.com/${repository}/pull/7`;
  const stored = validateChangeSnapshot({
    schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: `github:${repository}`, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: base, mergeBase: base, head, comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    prMetadata: { verification: 'caller-supplied-unverified', provider: 'github', repository, number: 7, url },
    changes: [], coverage: { changedPaths: 0, capturedSides: 0, excludedSides: 0, capturedBytes: 0, scope: 'changed-entries-only' },
  });
  return validateGithubPrEvidence({
    schemaVersion: 1, kind: 'github-pr-evidence', snapshotDigest: stored.digest, snapshot: stored.snapshot,
    pull: { id: 1, number: 7, repository, url, title: 'Synthetic persistence fixture', body: null, author: null,
      state: 'open', draft: false, merged: false, createdAt: date, updatedAt: date, closedAt: null, mergedAt: null,
      baseRef: 'main', baseTip: base, headRef: 'topic', head, headRepository: repository, mergeCommit: null,
      reportedChangedFiles: 0, reportedIssueComments: 0, reportedReviewComments: 0 },
    source: { provider: 'github', apiOrigin: 'https://api.github.com', observation: 'current-api-state', historicalReviewCheckpoint: false,
      ancestry: 'provider-declared', inventory: 'provider-declared-compare', repositoryContext: 'changed-paths-only',
      discussionConsistency: 'non-atomic-current-observation', discussionCoverage: 'all-pages-returned-within-limits', compareFileCount: 0,
      sourceStatements: 'untrusted-not-ground-truth-or-feedback' },
    discussions: { issueComments: [], reviews: [], reviewComments: [] },
  });
}

it('persists evidence and its snapshot idempotently, enforces append-only rows, and reopens without trusting a receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-pr-store-'));
  let store: QualEvoStore | undefined;
  try {
    const value = fixture(), path = join(directory, 'db'), db = await openPGliteDatabase(path);
    store = await QualEvoStore.initialize(db);
    const records = await Promise.all([store.importGithubPrEvidence(value.evidence), store.importGithubPrEvidence(value.evidence)]);
    expect(records).toEqual([value, value]);
    expect(await store.getChangeSnapshot(value.evidence.snapshotDigest)).toEqual({ digest: value.evidence.snapshotDigest, snapshot: value.evidence.snapshot });
    expect(await store.getGithubPrEvidence(value.digest)).not.toHaveProperty('receipt');
    expect((await db.query('SELECT digest FROM qe_github_pr_evidence')).rows).toHaveLength(1);
    expect(await store.listChangeSnapshots()).toHaveLength(1);
    await expect(db.query('UPDATE qe_github_pr_evidence SET payload=$1::jsonb WHERE digest=$2', ['{}', value.digest])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM qe_github_pr_evidence WHERE digest=$1', [value.digest])).rejects.toThrow('append-only');
    await expect(db.query('INSERT INTO qe_github_pr_evidence(digest,snapshot_digest,payload) VALUES($1,$2,$3::jsonb)',
      ['a'.repeat(64), 'b'.repeat(64), '{}'])).rejects.toThrow();
    await expect(store.getGithubPrEvidence('f'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.close(); store = undefined;
    store = await QualEvoStore.openPGlite(path);
    expect(await store.getGithubPrEvidence(value.digest)).toEqual(value);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('rolls back the snapshot on evidence insertion failure using one transaction and rejects invalid imports before writing', async () => {
  const db = await openPGliteDatabase();
  let failInsert = true, transactions = 0;
  const wrapped: Database = { ...db, transaction: fn => {
    transactions++;
    return db.transaction(tx => fn({ query: (sql, params) => {
      if (failInsert && sql.startsWith('INSERT INTO qe_github_pr_evidence')) throw new Error('Injected evidence insert failure');
      return tx.query(sql, params);
    } }));
  } };
  const store = await QualEvoStore.initialize(wrapped), value = fixture();
  try {
    await expect(store.importGithubPrEvidence({ ...value.evidence, snapshotDigest: 'f'.repeat(64) })).rejects.toThrow('snapshot digest mismatch');
    expect(transactions).toBe(0);
    await expect(store.importGithubPrEvidence(value.evidence)).rejects.toThrow('Injected evidence insert failure');
    expect(transactions).toBe(1);
    expect((await db.query('SELECT digest FROM qe_github_pr_evidence')).rows).toEqual([]);
    expect(await store.listChangeSnapshots()).toEqual([]);
    failInsert = false;
    expect(await store.importGithubPrEvidence(value.evidence)).toEqual(value);
    expect(transactions).toBe(2);
  } finally { await store.close(); }
}, 30_000);

it('revalidates stored payloads, indexed snapshot bindings, and linked snapshot integrity on reads and repeat imports', async () => {
  const db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db), value = fixture();
  try {
    await store.importGithubPrEvidence(value.evidence);
    await db.exec('ALTER TABLE qe_github_pr_evidence DISABLE TRIGGER qe_github_pr_evidence_immutable');
    const changed = structuredClone(value.evidence); changed.pull.title = 'Tampered but schema-valid';
    await db.query('UPDATE qe_github_pr_evidence SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify(changed), value.digest]);
    await expect(store.getGithubPrEvidence(value.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await expect(store.importGithubPrEvidence(value.evidence)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await db.query('UPDATE qe_github_pr_evidence SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify(value.evidence), value.digest]);
    const other = await store.importChangeSnapshot({ ...value.evidence.snapshot, mergeBase: '3'.repeat(40) });
    await db.query('UPDATE qe_github_pr_evidence SET snapshot_digest=$1 WHERE digest=$2', [other.digest, value.digest]);
    await expect(store.getGithubPrEvidence(value.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await db.query('UPDATE qe_github_pr_evidence SET snapshot_digest=$1 WHERE digest=$2', [value.evidence.snapshotDigest, value.digest]);
    await db.exec('ALTER TABLE qe_change_snapshots DISABLE TRIGGER qe_change_snapshots_immutable');
    await db.query('UPDATE qe_change_snapshots SET repository_id=$1 WHERE digest=$2', ['wrong-repository', value.evidence.snapshotDigest]);
    await expect(store.getGithubPrEvidence(value.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await expect(store.importGithubPrEvidence(value.evidence)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  } finally { await store.close(); }
}, 30_000);

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 9_000_000 });

it('imports and shows packages in separate CLI processes with integrity-only receipts, retaining the snapshot for local review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-pr-cli-'));
  try {
    const value = fixture(), db = join(directory, 'db'), file = join(directory, 'package.json'), out = join(directory, 'imported.json');
    // Deliberately fabricated live-looking receipt: loading it never authenticates these source claims.
    const packet = GithubPrEvidencePackageSchema.parse({ ...value, receipt: {
      kind: 'github-api-observation', startedAt: date, completedAt: date, authentication: 'none', transport: '@octokit/rest@22.0.1',
      verification: 'live-api-observation-not-verified-history', requestLimit: 50, requests: 1, decodedResponseBytes: 0,
      observations: [{ endpoint: '/repos/fixture/project/pulls/7', observedAt: date, dataDigest: 'f'.repeat(64) }],
    } });
    await writeFile(file, JSON.stringify(packet));
    expect((await run(['github-pr', 'import', '--file', file, '--db', db, '--out', out])).stdout).toBe('');
    const expected = { ...value, receipt: integrityReceipt };
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(expected);
    expect(JSON.parse((await run(['github-pr', 'import', '--file', file, '--db', db])).stdout)).toEqual(expected);
    expect(JSON.parse((await run(['github-pr', 'show', '--digest', value.digest, '--db', db])).stdout)).toEqual(expected);
    const snapshot = JSON.parse((await run(['snapshots', 'show', '--digest', value.evidence.snapshotDigest, '--db', db])).stdout);
    expect(snapshot).toEqual({ digest: value.evidence.snapshotDigest, snapshot: value.evidence.snapshot, receipt: integrityReceipt });
    const help = (await run(['github-pr', '--help'])).stdout;
    expect(help).toContain('Read-only public GitHub PR current observation');
    expect(help).toContain('not a historical review');
    expect(help).not.toContain('review-and-comment');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('requires persistent storage and rejects corrupt, oversized, or non-UTF-8 packages before creating a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-pr-cli-errors-'));
  try {
    const value = fixture(), db = join(directory, 'never-created-db'), file = join(directory, 'package.json');
    await expect(run(['github-pr', 'capture', '--repository', 'fixture/project', '--number', '7'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--db') });
    for (const limit of ['0', '51', '1.5', 'invalid']) {
      await expect(run(['github-pr', 'capture', '--repository', 'fixture/project', '--number', '7', '--max-requests', limit, '--db', db]))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('maxRequests') });
    }
    await expect(run(['github-pr', 'import', '--file', file])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--db') });
    await writeFile(file, JSON.stringify({ ...value, digest: 'a'.repeat(64) }));
    await expect(run(['github-pr', 'import', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('digest mismatch') });
    await writeFile(file, ' '.repeat(GITHUB_PR_MAX_JSON_BYTES + 1));
    await expect(run(['github-pr', 'import', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exceeds 8MB') });
    await writeFile(file, Buffer.from([123, 34, 255, 34, 58, 49, 125]));
    await expect(run(['github-pr', 'import', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

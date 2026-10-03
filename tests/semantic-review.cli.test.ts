import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { reviewContextRecord } from './helpers/review-context-record.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 6_000_000 });
it('runs the whole synthetic local loop and reopens exact records through separate CLI processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-review-cli-')), db = join(directory, 'db');
  try {
    const demoFile = join(directory, 'demo.json');
    expect((await run(['reviews', 'demo', '--db', db, '--out', demoFile])).stdout).toBe('');
    const demo = JSON.parse(await readFile(demoFile, 'utf8'));
    expect(demo.mode).toBe('synthetic_offline_demo'); expect(demo.review.occurrences).toHaveLength(2); expect(demo.review.findings).toHaveLength(1);
    expect(demo.finding).toMatchObject({ verdict: 'Unknown', identityVerification: 'caller-declared-unverified' });
    expect(demo.feedback).toMatchObject({ source: 'fixture', kind: 'note', label: null });
    expect(demo.revisionRequest.request).toMatchObject({ status: 'pending', synthesis: 'not_run', source: 'fixture' });
    expect(JSON.parse((await run(['reviews', 'demo', '--db', db])).stdout)).toEqual(demo);
    expect(JSON.parse((await run(['reviews', 'show', '--id', demo.review.id, '--db', db])).stdout)).toEqual(demo.review);
    expect(JSON.parse((await run(['reviews', 'finding', '--id', demo.finding.finding.id, '--db', db])).stdout)).toEqual(demo.finding);
    const fixtures = join(directory, 'fixtures.json'); await writeFile(fixtures, JSON.stringify(demo.review.fixtures));
    const args = ['reviews', 'run', '--rule-digest', demo.ruleDigest, '--snapshot-digest', demo.snapshotDigest, '--db', db];
    expect(JSON.parse((await run([...args, '--offline-fixtures', fixtures])).stdout)).toEqual({ ...demo.review, reviewSelection: 'explicit-digest-replay-not-governance-governed' });
    expect(JSON.parse((await run(args)).stdout).id).toBe(demo.structuralReviewId);
    const list = JSON.parse((await run(['reviews', 'list', '--rule-digest', demo.ruleDigest, '--snapshot-digest', demo.snapshotDigest, '--limit', '1', '--db', db])).stdout);
    expect(list.reviews).toHaveLength(1); expect(list.reviews[0]).not.toHaveProperty('fixtures');
    const next = JSON.parse((await run(['reviews', 'list', '--after', list.nextAfter, '--db', db])).stdout);
    expect(next.reviews).toHaveLength(1);
    const note = { ...demo.feedback, id: 'exact-fixture-note', reason: 'Authored note with whitespace\n  retained exactly.\n' };
    const noteFile = join(directory, 'note.json'); await writeFile(noteFile, JSON.stringify(note));
    expect(JSON.parse((await run(['feedback', 'add', '--file', noteFile, '--db', db])).stdout)).toEqual(note);
    const finding = JSON.parse((await run(['reviews', 'finding', '--id', demo.finding.finding.id, '--db', db])).stdout);
    expect(finding.feedback).toContainEqual(note); expect(finding.verdict).toBe('Unknown');
    const request = { id: 'explicit-fixture-request', baseRuleDigest: demo.ruleDigest, requestedRuleVersion: 'draft-3-requested', feedbackIds: [note.id],
      requestedChange: 'Retain the exact selected fixture note for future authoring.', actor: 'synthetic-cli-fixture', source: 'fixture', createdAt: '2026-10-01T00:00:00Z' };
    const requestFile = join(directory, 'request.json'); await writeFile(requestFile, JSON.stringify(request));
    const stored = JSON.parse((await run(['revisions', 'request', '--file', requestFile, '--db', db])).stdout);
    expect(stored.request).toMatchObject({ ...request, status: 'pending', synthesis: 'not_run' });
    expect(JSON.parse((await run(['revisions', 'show', '--digest', stored.digest, '--db', db])).stdout)).toEqual(stored);
    expect(JSON.parse((await run(['revisions', 'list', '--base-rule-digest', demo.ruleDigest, '--db', db])).stdout)).toHaveLength(2);
    expect(JSON.parse((await run(['rules', 'list', '--db', db])).stdout)).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);

it('requires persistent storage and rejects stale fixtures, bad limits, oversized input and accidental model flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-review-cli-errors-')), db = join(directory, 'db');
  try {
    await expect(run(['reviews', 'demo'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--db') });
    const demo = JSON.parse((await run(['reviews', 'demo', '--db', db])).stdout);
    const bad = join(directory, 'fixtures.json');
    const packet = demo.review.fixtures; packet.snapshotDigest = 'f'.repeat(64); await writeFile(bad, JSON.stringify(packet));
    const args = ['reviews', 'run', '--rule-digest', demo.ruleDigest, '--snapshot-digest', demo.snapshotDigest, '--db', db];
    await expect(run([...args, '--offline-fixtures', bad])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exact rule and snapshot') });
    await expect(run([...args, '--enable-model'])).rejects.toMatchObject({ code: 1 });
    await expect(run(['reviews', 'list', '--db', db, '--limit', '101'])).rejects.toMatchObject({ code: 1 });
    await writeFile(bad, ' '.repeat(2_000_001));
    await expect(run(['feedback', 'add', '--file', bad, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Input exceeds 2MB') });
    await writeFile(bad, Buffer.from([123, 34, 255, 34, 58, 49, 125]));
    await expect(run(['feedback', 'add', '--file', bad, '--db', db])).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse((await run(['reviews', 'list', '--db', db])).stdout).reviews).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('selects registered context digests explicitly, reopens complete context reviews, and rejects implicit or duplicate selections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-review-cli-context-')), db = join(directory, 'db');
  try {
    const demo = JSON.parse((await run(['reviews', 'demo', '--db', db])).stdout);
    const store = await QualEvoStore.openPGlite(db);
    let context;
    try {
      const snapshot = await store.getChangeSnapshot(demo.snapshotDigest);
      context = await store.importRepositoryContext(reviewContextRecord(snapshot).context);
    } finally { await store.close(); }
    const args = ['reviews', 'run', '--rule-digest', demo.ruleDigest, '--snapshot-digest', demo.snapshotDigest, '--db', db];
    const selected = JSON.parse((await run([...args, '--repository-context-digest', context.digest])).stdout);
    expect(selected.config).toMatchObject({ runtime: 'semantic-snapshot-review-v3', repositoryContextDigests: [context.digest] });
    expect(selected.repositoryContexts).toEqual([context]);
    const { reviewSelection, ...storedReview } = selected;
    expect(reviewSelection).toBe('explicit-digest-replay-not-governance-governed');
    expect(JSON.parse((await run(['reviews', 'show', '--id', selected.id, '--db', db])).stdout)).toEqual(storedReview);
    expect(JSON.parse((await run(args)).stdout).id).toBe(demo.structuralReviewId);
    await expect(run([...args, '--repository-context-digest', context.digest, context.digest])).rejects.toMatchObject({ code: 1 });
    await expect(run([...args, '--repository-context-digest', 'f'.repeat(64)])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown repository context') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

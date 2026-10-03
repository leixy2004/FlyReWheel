import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceEnvironment } from '../dist/workspace/process.js';
import { RepositoryContextPackageSchema, validateRepositoryContextEvidence, validateRepositoryContextForSnapshot } from '../dist/repository-context.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'compiled-context-')), repo = join(directory, 'repo'), db = join(directory, 'db'), importDb = join(directory, 'import-db');
const run = async (args, storage = db) => JSON.parse((await exec(process.execPath, ['dist/cli.js', ...args, '--db', storage], { cwd: root, timeout: 30_000, maxBuffer: 6_000_000 })).stdout);
const git = async (...args) => (await exec('git', args, { cwd: repo, env: { ...workspaceEnvironment(),
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } })).stdout.trim();
try {
  await mkdir(repo); await git('init', '-qb', 'main');
  await writeFile(join(repo, 'change.ts'), 'before\n'); await writeFile(join(repo, 'contract.ts'), 'export const limit = 7;\n');
  await writeFile(join(repo, 'test.ts'), 'assert(limit === 7);\n');
  await git('add', '.'); await git('commit', '-qm', 'base'); const baseTip = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'change.ts'), 'after\n'); await git('commit', '-qam', 'review head'); const head = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'contract.ts'), 'export const limit = 999; // future\n'); await git('commit', '-qam', 'future'); const future = await git('rev-parse', 'HEAD');
  const snapshot = await run(['snapshots', 'capture', '--repo', repo, '--repository-id', 'fixture/compiled-context', '--base-tip', baseTip, '--head', head]);
  assert.equal(snapshot.snapshot.changes.length, 1);
  const args = ['contexts', 'capture', '--repo', repo, '--repository-id', 'fixture/compiled-context', '--head', head,
    '--path', 'contract.ts', 'test.ts', 'missing.ts', '--snapshot-digest', snapshot.digest];
  const capture = RepositoryContextPackageSchema.parse(await run(args));
  assert.equal(capture.receipt.kind, 'local-git-check'); assert.equal(capture.context.coverage.capturedPaths, 2); assert.equal(capture.context.coverage.missingPaths, 1);
  assert.equal((await run(args)).digest, capture.digest);
  assert.equal(validateRepositoryContextForSnapshot(capture, snapshot).head, head);
  await assert.rejects(run([...args, '--head', future]), /exact snapshot repository and review head/);
  const citation = await run(['contexts', 'cite', '--digest', capture.digest, '--path', 'contract.ts', '--kind', 'callee-contract', '--start', '0', '--end', '23', '--snapshot-digest', snapshot.digest]);
  assert.equal(citation.evidence.content, 'export const limit = 7;'); assert.equal(citation.semanticReviewAcceptance, 'semantic-snapshot-review-v3');
  assert.deepEqual(validateRepositoryContextEvidence(citation.evidence, capture), citation.evidence);
  assert.equal((await run(['contexts', 'verify', '--digest', capture.digest, '--repo', repo])).receipt.kind, 'local-git-check');
  const shown = await run(['contexts', 'show', '--digest', capture.digest]); assert.equal(shown.receipt.kind, 'package-integrity-only');
  const file = join(directory, 'context.json'); await writeFile(file, JSON.stringify(capture));
  await rm(repo, { recursive: true, force: true });
  assert.deepEqual(await run(['contexts', 'import', '--file', file], importDb), shown);
  assert.deepEqual(await run(['contexts', 'import', '--file', file], importDb), shown);
  assert.deepEqual(await run(['contexts', 'show', '--digest', capture.digest], importDb), shown);
  const citedAgain = await run(['contexts', 'cite', '--digest', capture.digest, '--path', 'contract.ts', '--kind', 'callee-contract', '--start', '0', '--end', '23'], importDb);
  assert.deepEqual(citedAgain.evidence, citation.evidence);
  const list = await run(['contexts', 'list', '--head', head], importDb); assert.equal(list.contexts.length, 1); assert.equal(list.contexts[0].entries, undefined);
  assert.equal((await run(['contexts', 'list', '--after', capture.digest], importDb)).contexts.length, 0);
  await assert.rejects(run(['contexts', 'verify', '--digest', capture.digest, '--repo', repo], importDb));
  const corrupted = JSON.parse(await readFile(file, 'utf8')); corrupted.context.head = future; await writeFile(file, JSON.stringify(corrupted));
  await assert.rejects(run(['contexts', 'import', '--file', file], importDb), /digest mismatch/);
  const result = { date: '2026-10-02', mode: 'compiled-offline-selected-repository-context', passed: true,
    baseTip, head, future, snapshotDigest: snapshot.digest, contextDigest: capture.digest, evidenceId: citation.evidence.id,
    coverage: capture.context.coverage, captureVerification: capture.receipt.kind, importedVerification: shown.receipt.kind,
    semanticReviewAcceptance: 'semantic-snapshot-review-v3',
    verified: ['unchanged contract/test bytes at exact review head', 'future-head rejection', 'idempotent capture', 'fresh local Git re-verification',
      'typed exact-source citation', 'import receipt downgrade', 'reopen/cite without repository', 'bounded summary pagination', 'tamper rejection'],
    limits: ['Authored local fixture only', 'Caller-supplied repository identity', 'Historical availability unproven',
      'This capture-only smoke does not execute semantic review or model inference', 'No deployment, upload, publication or target-code execution'] };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }

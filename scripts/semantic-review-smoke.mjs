import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'compiled-semantic-review-')), db = join(directory, 'db');
const run = async args => JSON.parse((await exec(process.execPath, ['dist/cli.js', ...args, '--db', db], { cwd: root, timeout: 30_000, maxBuffer: 6_000_000 })).stdout);
try {
  const demo = await run(['reviews', 'demo']);
  assert.equal(demo.review.occurrences.length, 2); assert.equal(demo.review.findings.length, 1);
  assert.equal(demo.finding.verdict, 'Unknown'); assert.equal(demo.feedback.source, 'fixture'); assert.equal(demo.feedback.label, null);
  assert.equal(demo.finding.finding.introduction, 'unverified'); assert.equal(demo.finding.finding.notificationEligibility, 'unverified');
  assert.equal(demo.review.coverage.snapshotVerification, 'package-integrity-only'); assert.equal(demo.review.coverage.repositoryContext, 'incomplete');
  assert.deepEqual(await run(['reviews', 'demo']), demo);
  assert.deepEqual(await run(['reviews', 'show', '--id', demo.review.id]), demo.review);
  assert.deepEqual(await run(['reviews', 'finding', '--id', demo.finding.finding.id]), demo.finding);
  const fixtures = join(directory, 'fixtures.json'); await writeFile(fixtures, JSON.stringify(demo.review.fixtures));
  assert.deepEqual(await run(['reviews', 'run', '--rule-digest', demo.ruleDigest, '--snapshot-digest', demo.snapshotDigest, '--offline-fixtures', fixtures]), demo.review);
  const note = { ...demo.feedback, id: 'compiled-fixture-note', reason: 'Exact compiled smoke note\n  whitespace preserved.\n' };
  const noteFile = join(directory, 'note.json'); await writeFile(noteFile, JSON.stringify(note));
  assert.deepEqual(await run(['feedback', 'add', '--file', noteFile]), note);
  const finding = await run(['reviews', 'finding', '--id', demo.finding.finding.id]);
  assert.equal(finding.verdict, 'Unknown'); assert.ok(finding.feedback.some(value => value.reason === note.reason));
  const input = { id: 'compiled-fixture-request', baseRuleDigest: demo.ruleDigest, requestedRuleVersion: 'future-draft', feedbackIds: [note.id], requestedChange: 'Consider only the selected synthetic note.', actor: 'synthetic-smoke', source: 'fixture', createdAt: '2026-10-01T00:00:00Z' };
  const requestFile = join(directory, 'request.json'); await writeFile(requestFile, JSON.stringify(input));
  const request = await run(['revisions', 'request', '--file', requestFile]);
  assert.equal(request.request.status, 'pending'); assert.equal(request.request.synthesis, 'not_run');
  assert.deepEqual(await run(['revisions', 'show', '--digest', request.digest]), request);
  assert.equal((await run(['rules', 'list'])).length, 1);
  assert.equal((await run(['revisions', 'list', '--base-rule-digest', demo.ruleDigest])).length, 2);
  assert.equal((await run(['reviews', 'list'])).reviews.length, 2);
  const result = { date: '2026-10-01', runtime: 'compiled dist/cli.js in separate processes', storage: 'fresh local PGlite', passed: true,
    ruleDigest: demo.ruleDigest, snapshotDigest: demo.snapshotDigest, reviewId: demo.review.id, findingId: demo.finding.finding.id,
    nativeOccurrences: 2, aggregatedFindings: 1, semanticOrigin: 'fixture', humanVerdict: 'Unknown', feedbackSource: 'fixture', feedbackKind: 'note', feedbackLabel: null,
    requestDigest: request.digest, requestStatus: 'pending', synthesis: 'not_run', ruleVersionCountAfterRequests: 1,
    verified: ['idempotent demo and reopened reads', 'explicit fixture review', 'exact whitespace-preserved feedback', 'frozen pending request', 'no request-created rule version'],
    limitations: ['Synthetic input; no verified Git history or authenticated human approval', 'Changed-entry context only; introduction and notification eligibility unverified', 'No live model, auth, sandbox, provider publication or remote PostgreSQL verification'] };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }

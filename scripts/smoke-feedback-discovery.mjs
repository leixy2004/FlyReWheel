// Authored fixture inputs only. Real compiled CLI/storage operations, no model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const directory = resolve(process.argv[2] ?? '/tmp/flyrewheel-feedback-discovery'), exec = promisify(execFile);
await mkdir(directory); const db = join(directory, 'db'), commands = [];
const run = async (...args) => {
  const { stdout } = await exec(process.execPath, ['dist/cli.js', ...args, '--db', db], { timeout: 30_000, maxBuffer: 6_000_000 });
  commands.push({ args, exitCode: 0 }); return JSON.parse(stdout);
};
const save = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); return path; };
const demo = await run('reviews', 'demo'); await save('demo.json', demo);
const note = { ...demo.feedback, id: 'catalog-authored-note', reason: 'Authored fixture note discovered through the catalog for an explicit revision request.' };
await run('feedback', 'add', '--file', await save('note.json', note));
const first = await run('feedback', 'list', '--rule-digest', demo.ruleDigest, '--source', 'fixture', '--limit', '1');
assert.equal(first.feedback.length, 1); assert.equal(first.feedback[0].id, note.id);
const next = await run('feedback', 'list', '--rule-digest', demo.ruleDigest, '--source', 'fixture', '--after', first.nextAfter, '--limit', '1');
assert.equal(next.feedback[0].id, demo.feedback.id);
const empty = await run('feedback', 'list', '--rule-digest', demo.ruleDigest, '--source', 'fixture', '--after', next.nextAfter);
assert.deepEqual(empty.feedback, []); assert.equal(empty.nextAfter, null);
assert.deepEqual((await run('feedback', 'list', '--source', 'local-human-declared')).feedback, []);
const selected = await run('feedback', 'show', '--id', first.feedback[0].id);
assert.deepEqual(selected.feedback, note); assert.equal(selected.currentFindingVerdict, 'Unknown');
assert.equal(selected.finding.id, note.findingId); assert.equal(selected.finding.ruleDigest, note.ruleDigest);
assert.equal(selected.verdictScope, 'all-current-finding-feedback-not-frozen-request');
assert.equal((await run(...selected.links.rule)).digest, demo.ruleDigest);
assert.equal((await run(...selected.links.review)).id, note.reviewId);
const requestInput = { id: 'catalog-explicit-request', baseRuleDigest: selected.feedback.ruleDigest, requestedRuleVersion: 'catalog-requested-v2',
  feedbackIds: [selected.feedback.id], requestedChange: 'Clarify evidence requirements using this selected authored fixture note.',
  actor: 'authored-offline-smoke', source: 'fixture', createdAt: '2026-10-13T00:00:00Z' };
const request = await run('revisions', 'request', '--file', await save('request-input.json', requestInput));
assert.deepEqual(request.request.feedbackIds, [note.id]); assert.equal(request.request.feedbackBindings[0].id, note.id);
assert.equal(request.request.synthesis, 'not_run');
const later = { ...note, id: 'later-authored-note', reason: 'Later fixture feedback must not enter the frozen request.' };
await run('feedback', 'add', '--file', await save('later.json', later));
assert.deepEqual(await run('revisions', 'show', '--digest', request.digest), request);
assert.equal((await run('feedback', 'show', '--id', note.id)).findingFeedbackIds.length, 3);
await save('selected-feedback.json', selected); await save('request.json', request);
const report = { status: 'passed', directory, commands,
  checks: ['compiled cross-process feedback add/list/show', 'source filter and ID pagination', 'exact rule/review links',
    'fixture feedback retains Unknown verdict', 'discovered ID freezes exact revision binding', 'later feedback leaves frozen request unchanged'],
  inputs: 'authored synthetic review-demo source, judgments and feedback', realRepositorySourceEvaluated: false,
  modelExecution: 'not_run', realDeveloperFeedback: false, revisionGeneration: 'not_run', governanceMutation: 'not_performed',
  credentials: 'not_read', W1: 'not_read', externalPublication: 'not_performed' };
await save('verification.json', report); console.log(JSON.stringify(report, null, 2));

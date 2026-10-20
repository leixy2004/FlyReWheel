// Authored semantic fixtures; real compiled CLI, database, selection and admission.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { digestOf } from '../dist/core/identity.js';
const exec = promisify(execFile), directory = resolve(process.argv[2] ?? '/tmp/flyrewheel-governance-preview');
await mkdir(directory); const db = join(directory, 'db'), commands = [];
const run = async (args, expected = 0) => {
  const result = await exec(process.execPath, ['dist/cli.js', ...args, '--db', db], { timeout: 40_000, maxBuffer: 8_000_000 })
    .then(r => ({ ...r, code: 0 }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  assert.equal(result.code, expected, result.stderr); commands.push({ args, expectedExit: expected, actualExit: result.code });
  return expected ? null : JSON.parse(result.stdout);
};
const save = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); return path; };
const demo = await run(['revisions', 'demo']); await save('demo.json', demo);
const feedback = await run(['feedback', 'show', '--id', demo.feedback[1].id]);
const explanationArgs = ['revisions', 'explain', '--digest', demo.compatible.comparison.digest, '--feedback-id', feedback.feedback.id,
  '--repository', 'synthetic:revision-comparison-demo', '--path', 'src/negative.ts'];
assert.equal((await run(explanationArgs)).localReview.eligible, false);
const candidate = await run(['rules', 'show', '--digest', demo.compatible.candidateRuleDigest]);
const authored = (await run(['reviews', 'show', '--id', demo.compatible.candidateReviewId])).fixtures;
const fixtureFile = await save('authored-response.json', authored);
const common = { namespace: 'local-semantic-review', ruleDigest: candidate.digest, scopeDigest: digestOf(candidate.rule.scope), actor: 'offline-smoke', source: 'fixture',
  reason: 'Explicit authored fixture selection after compatible comparison', createdAt: '2026-10-13T00:00:00Z' };
const apply = async value => run(['rules', 'governance', 'apply', '--file', await save(`${value.id}.json`, value)]);
const preview = async (value, expected = 0) => run(['rules', 'governance', 'preview', '--file', await save(`${value.id}-preview.json`, value)], expected);
const history = () => run(['rules', 'governance', 'history', '--rule-id', candidate.rule.ruleId]);
const registration = { ...common, id: 'offline-register', action: 'register', expectedHeadDigest: null };
const registrationPreview = await preview(registration);
assert.equal(registrationPreview.status, 'ready');
assert.equal(registrationPreview.governanceWritesPerformed, false);
assert.deepEqual(await history(), []);
const registered = await apply(registration);
assert.deepEqual(registered, registrationPreview.event);
const selection = { ...common, id: 'offline-select', action: 'select-shadow', expectedHeadDigest: registered.digest, decisionDigest: demo.compatible.decision.digest };
const before = await history();
const selectionPreview = await preview(selection);
assert.equal(selectionPreview.resultingState.shadowRuleDigest, candidate.digest);
assert.deepEqual(await history(), before);
assert.equal((await run(explanationArgs)).localReview.eligible, false);
await preview({ ...selection, id: 'wrong-scope', scopeDigest: '0'.repeat(64) }, 1);
await preview({ ...selection, id: 'rejected-proof', decisionDigest: demo.regressed.decision.digest }, 1);
assert.deepEqual(await history(), before);
const selected = await apply(selection);
assert.deepEqual(selected, selectionPreview.event);

const input = { id: 'governed-offline', repository: candidate.rule.scope.repositories[0], paths: ['src/negative.ts'], snapshotDigest: demo.snapshotDigest, workspaceId: 'offline-no-workspace' };
const plan = await run(['reviews', 'governed', 'plan', '--file', await save('plan-input.json', input), '--offline-fixtures', fixtureFile]);
await save('plan.json', plan); assert.equal(plan.jobs[0].offlineFixtureDigest, digestOf(authored));
const changed = structuredClone(authored); changed.judgments[0].reasoning = 'Different explicit fixture bytes';
await run(['reviews', 'governed', 'run', '--digest', plan.digest, '--offline-fixtures', await save('changed-response.json', changed)], 1);
assert.equal((await run(['reviews', 'governed', 'status', '--digest', plan.digest])).jobs[0].state, 'not_started');
const args = ['reviews', 'governed', 'run', '--digest', plan.digest, '--offline-fixtures', fixtureFile];
const completed = await run(args); await save('execution.json', completed);
assert.equal(completed.reviewSelection, 'local-governed'); assert.equal(completed.executionMode, 'authored-offline-fixtures');
assert.equal(completed.modelExecution, 'not_run'); assert.equal(completed.workspaceExecution, 'not_run');
const job = completed.jobs[0]; assert.equal(job.admission.planDigest, plan.digest); assert.equal(job.result.status, 'completed');
const review = await run(['reviews', 'show', '--id', job.result.outcome.id]); await save('review.json', review);
assert.equal(review.ruleDigest, candidate.digest); assert.equal(review.config.fixtureDigest, digestOf(authored));
assert.equal(review.config.attempt, `application-${job.jobDigest}`); assert.equal(review.executionReceipt, undefined);
assert.deepEqual(await run(args), completed);
const pending = await run(['reviews', 'governed', 'plan', '--file', await save('pending-input.json', { ...input, id: 'pending-offline' }), '--offline-fixtures', fixtureFile]);
const suspension = { ...common, id: 'offline-suspend', action: 'suspend', expectedHeadDigest: selected.digest };
const suspensionPreview = await preview(suspension);
const suspended = await apply({ ...suspension, id: 'competing-suspend' });
await run(['rules', 'governance', 'apply', '--file', await save('stale-suspension.json', suspension)], 1);
await preview(suspension, 1);
const retry = await preview(selection);
assert.equal(retry.status, 'already-applied');
assert.equal(retry.currentState.headDigest, suspended.digest);
assert.deepEqual(retry.resultingState, retry.currentState);
assert.deepEqual(retry.transitions, []);
assert.equal(suspensionPreview.currentState.headDigest, selected.digest);

await run(['reviews', 'governed', 'run', '--digest', pending.digest, '--offline-fixtures', fixtureFile], 1);
const stale = await run(['reviews', 'governed', 'status', '--digest', pending.digest]);
assert.equal(stale.currentGovernance, 'stale-plan'); assert.equal(stale.jobs[0].state, 'not_started');
await run(args, 1); assert.deepEqual(await run(['reviews', 'show', '--id', review.id]), review);
const report = { status: 'passed', directory, commands, checks: ['read-only registration and shadow-selection previews match applied events', 'invalid scope/rejected evidence refused', 'stale preview is not an apply reservation', 'idempotent preview after suspension does not rewind state', 'feedback/comparison trace', 'explicit compatible candidate selection',
  'plan freezes authored response digest', 'changed response rejected before claim', 'governed execution records exact admission',
  'review binds selected rule, snapshot, fixture and application job', 'restart reuses completed output', 'suspension rejects pending and completed plan execution without rewriting review'],
  source: 'synthetic authored demo source and imported candidate', modelExecution: 'not_run', modelSubstituteRuntime: 'not_used',
  judgments: 'explicit authored offline fixtures', developerFeedback: 'fixture-only-not-real-human', productionActivation: 'not_performed',
  workspaceExecution: 'not_run', credentials: 'not_read', W1: 'not_read' };
await save('verification.json', report); console.log(JSON.stringify(report, null, 2));

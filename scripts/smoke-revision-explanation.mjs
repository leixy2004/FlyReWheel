// Real CLI/storage operations on authored offline demo inputs. No model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { digestOf } from '../dist/core/identity.js';
const exec = promisify(execFile), directory = resolve(process.argv[2] ?? '/tmp/flyrewheel-revision-explanation');
await mkdir(directory); const db = join(directory, 'db'), commands = [];
const run = async (...args) => {
  const result = await exec(process.execPath, ['dist/cli.js', ...args, '--db', db], { timeout: 40_000, maxBuffer: 8_000_000 });
  commands.push({ args, exitCode: 0 }); return JSON.parse(result.stdout);
};
const save = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); return path; };
const demo = await run('revisions', 'demo'); await save('demo.json', demo);
const base = await run('rules', 'show', '--digest', demo.baseRuleDigest);
const candidate = await run('rules', 'show', '--digest', demo.compatible.candidateRuleDigest);
const repository = base.rule.scope.repositories[0], path = 'src/negative.ts';
const feedbackId = demo.feedback.find(item => item.label === 'FP').id;
// Follow existing discovery: exact feedback -> base rule requests -> exact comparison.
const feedback = await run('feedback', 'show', '--id', feedbackId);
const requests = await run(...feedback.links.revisionRequests);
assert.ok(requests.some(item => item.digest === demo.compatible.request.digest));
const comparisons = await run('revisions', 'comparisons', '--request-digest', demo.compatible.request.digest, '--candidate-rule-digest', candidate.digest);
assert.equal(comparisons.comparisons[0].digest, demo.compatible.comparison.digest);
const explain = (digest = demo.compatible.comparison.digest, selectedPath = path) => run('revisions', 'explain', '--digest', digest,
  '--feedback-id', feedbackId, '--repository', repository, '--path', selectedPath);
const initial = await explain(); await save('before-governance.json', initial);
assert.equal(initial.localReview.eligible, false); assert.equal(initial.localReview.reason, 'unregistered');
assert.equal(initial.evaluation.summary.status, 'compatible');
assert.equal(initial.decisions[0].decision.choice, 'accept'); // Accept alone must not select.
assert.deepEqual(initial.changes.find(item => item.path === '/semantics/exceptions'),
  { path: '/semantics/exceptions', operation: 'replace', before: [], after: ['Explicit isAuthorized() guard'] });
assert.ok(initial.changes.some(item => item.path === '/semantics/expectedBehavior'));
assert.equal(initial.selectedFeedback.find(item => item.focused).observations[0].outcome, 'corrected');
assert.equal(initial.trust.semanticEvidence, 'offline-fixture-declarations');
const apply = async command => run('rules', 'governance', 'apply', '--file', await save(`${command.id}.json`, command));
const common = { namespace: 'local-semantic-review', ruleDigest: candidate.digest, scopeDigest: digestOf(candidate.rule.scope),
  actor: 'authored-offline-smoke', source: 'fixture', reason: 'Explicit fixture-only local selection after stored comparison.', createdAt: '2026-10-13T00:00:00Z' };
const registered = await apply({ ...common, id: 'explain-register', action: 'register', expectedHeadDigest: null });
assert.equal((await explain()).localReview.reason, 'candidate');
const chosen = await apply({ ...common, id: 'explain-select', action: 'select-shadow', expectedHeadDigest: registered.digest,
  decisionDigest: demo.compatible.decision.digest });
const selected = await explain(); await save('after-governance.json', selected);
assert.equal(selected.localReview.eligible, true); assert.equal(selected.localReview.selectedUsingThisComparison, true);
assert.equal(selected.localReview.governanceHeadDigest, chosen.digest);
assert.equal((await explain(undefined, 'docs/outside.md')).localReview.reason, 'out_of_scope');
const regressed = await explain(demo.regressed.comparison.digest);
assert.equal(regressed.evaluation.summary.status, 'regressed'); assert.equal(regressed.localReview.eligible, false);
assert.equal(regressed.decisions[0].decision.choice, 'reject');
const planInput = { id: 'explained-next-review', repository, paths: [path], snapshotDigest: demo.snapshotDigest, workspaceId: 'offline-explanation' };
const plan = await run('reviews', 'governed', 'plan', '--file', await save('plan-input.json', planInput));
assert.equal(plan.jobs.length, 1); assert.equal(plan.jobs[0].ruleDigest, candidate.digest);
assert.equal(plan.execution, 'not_run'); await save('governed-plan.json', plan);
// Explicit replay of that selected digest uses existing fixture review, not a governed worker execution.
const candidateReview = await run('reviews', 'show', '--id', demo.compatible.candidateReviewId);
const replay = await run('reviews', 'run', '--rule-digest', plan.jobs[0].ruleDigest, '--snapshot-digest', plan.jobs[0].snapshotDigest,
  '--offline-fixtures', await save('selected-fixtures.json', candidateReview.fixtures), '--attempt', 'explained-offline-replay');
assert.equal(replay.ruleDigest, candidate.digest); assert.equal(replay.reviewSelection, 'explicit-digest-replay-not-governance-governed');
await save('subsequent-review.json', replay);
await apply({ ...common, id: 'explain-suspend', action: 'suspend', expectedHeadDigest: chosen.digest });
const suspended = await explain(); assert.equal(suspended.localReview.eligible, false); assert.equal(suspended.localReview.reason, 'suspended');
await save('after-suspension.json', suspended);
assert.deepEqual(suspended.changes, initial.changes); assert.deepEqual(suspended.evaluation, initial.evaluation);
const report = { status: 'passed', directory, commands,
  checks: ['feedback discovery to exact comparison', 'literal candidate field changes', 'focused feedback evaluation and explicit decision',
    'accepted candidate unselected before governance', 'candidate registration still unselected', 'explicit shadow selection and out-of-scope exclusion',
    'regressed/rejected candidate remains unselected', 'governed plan pins chosen version', 'subsequent explicit offline review uses chosen version',
    'suspension changes current eligibility without rewriting comparison'],
  inputs: 'authored synthetic revision-demo source, imported candidates, judgments, feedback and decisions',
  modelExecution: 'not_run', modelSubstituteRuntime: 'not_used', realSourceEvaluation: 'not_performed', realHumanAssessment: 'not_performed',
  governedWorkerExecution: 'not_run', subsequentReview: 'explicit offline fixture replay', productionActivation: 'not_performed',
  credentials: 'not_read', W1: 'not_read', publication: 'not_performed' };
await save('verification.json', report); console.log(JSON.stringify(report, null, 2));

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Socket } from 'node:net';

// Compiled local fixture plumbing only. All parent/child network attempts are forbidden.
let networkCalls = 0;
const rejectNetwork = () => { networkCalls++; throw new Error('GOVERNED_SMOKE_FORBIDS_NETWORK'); };
Socket.prototype.connect = rejectNetwork; globalThis.fetch = rejectNetwork;
const { QualEvoStore } = await import('../dist/storage/store.js');
const { runRevisionComparisonDemo } = await import('../dist/revision-demo.js');
const { digestOf } = await import('../dist/core/identity.js');
const { runGovernedReviewPlan, governedReviewJobs } = await import('../dist/governed-semantic-review.js');
const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'compiled-governed-reviews-')), db = join(directory, 'db');
const guard = join(directory, 'guard.mjs'), marker = join(directory, 'network-attempt'), inputFile = join(directory, 'plan.json');
const evidence = { checks: 0, stages: [] };
let store;
async function cli(args, succeeds = true) {
  const result = await exec(process.execPath, ['--import', pathToFileURL(guard).href, join(root, 'dist/cli.js'), ...args], {
    cwd: root, timeout: 30_000, maxBuffer: 3_000_000,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
      DATABASE_URL: 'postgresql://fixture:authored@forbidden.invalid/test', QE_ENABLE_MODEL: 'false' },
  }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  await assert.rejects(access(marker), error => error.code === 'ENOENT');
  assert.equal(result.code, succeeds ? 0 : 1, result.stderr);
  evidence.checks++;
  return succeeds ? JSON.parse(result.stdout) : result;
}
try {
  await writeFile(guard, `import { Socket } from 'node:net'; import { appendFileSync } from 'node:fs';
const reject=()=>{appendFileSync(${JSON.stringify(marker)},'attempt\\n');throw new Error('GOVERNED_SMOKE_FORBIDS_NETWORK');};
Socket.prototype.connect=reject;globalThis.fetch=reject;`);
  store = await QualEvoStore.openPGlite(db);
  const demo = await runRevisionComparisonDemo(store), base = await store.getRuleVersion(demo.baseRuleDigest);
  const candidate = await store.getRuleVersion(demo.compatible.candidateRuleDigest);
  const input = { id: 'compiled-plan', repository: base.rule.scope.repositories[0], snapshotDigest: demo.snapshotDigest,
    paths: ['src/positive.ts'], workspaceId: 'approved-fixture-workspace' };
  let head = null;
  async function apply(rule, action, id, extra = {}) {
    const result = await store.applySemanticGovernance({ id, namespace: 'local-semantic-review', ruleDigest: rule.digest,
      scopeDigest: digestOf(rule.rule.scope), expectedHeadDigest: head, action, actor: 'authored-compiled-smoke', source: 'fixture',
      reason: 'Compiled fixture plumbing only', createdAt: '2026-10-02T00:00:00Z', ...extra });
    head = result.digest; evidence.checks++;
  }
  await apply(base, 'register', 'compiled-register'); await apply(base, 'bootstrap-shadow', 'compiled-bootstrap');
  await store.close(); store = undefined;
  await writeFile(inputFile, JSON.stringify(input));
  const planned = await cli(['reviews', 'governed', 'plan', '--file', inputFile, '--db', db]);
  assert.equal(planned.jobs[0].ruleDigest, base.digest);
  assert.equal(planned.jobs[0].governancePlanDigest, planned.digest);
  assert.equal(planned.plan.selection.selected[0].selectionEvidence.kind, 'unvalidated-root-bootstrap');
  assert.equal(planned.execution, 'not_run'); evidence.stages.push('compiled-cli-root-selection');
  const shown = await cli(['reviews', 'governed', 'show', '--digest', planned.digest, '--db', db]);
  assert.deepEqual(shown.plan, planned.plan);
  assert.equal((await cli(['reviews', 'governed', 'status', '--digest', planned.digest, '--db', db])).jobs[0].state, 'not_started');
  store = await QualEvoStore.openPGlite(db);
  const blocked = await runGovernedReviewPlan({ store }, planned.digest, new AbortController().signal);
  assert.equal(blocked.jobs[0].result.reason, 'runtime_unavailable');
  assert.equal(blocked.jobs[0].admission, null);
  evidence.stages.push('no-implicit-runtime-fail-closed'); evidence.checks++;
  await apply(base, 'suspend', 'compiled-suspend');
  await assert.rejects(store.requireCurrentGovernedReviewPlan(planned.digest), error => error.code === 'STALE_GOVERNANCE_PLAN');
  await store.close(); store = undefined;
  assert.equal((await cli(['reviews', 'governed', 'status', '--digest', planned.digest, '--db', db])).currentGovernance, 'stale-plan');
  await writeFile(inputFile, JSON.stringify({ ...input, id: 'compiled-suspended-plan' }));
  const empty = await cli(['reviews', 'governed', 'plan', '--file', inputFile, '--db', db]);
  assert.equal(empty.jobs.length, 0); assert.equal(empty.plan.selection.excluded[0].reason, 'suspended');
  assert.equal((await cli(['reviews', 'governed', 'status', '--digest', empty.digest, '--db', db])).state, 'no_eligible_rules');
  evidence.stages.push('suspension-and-no-eligible-plan');
  store = await QualEvoStore.openPGlite(db);
  await apply(candidate, 'register', 'compiled-register-successor');
  await apply(base, 'supersede', 'compiled-supersede', { decisionDigest: demo.compatible.decision.digest,
    successor: { ruleDigest: candidate.digest, scopeDigest: digestOf(candidate.rule.scope) } });
  assert.equal(await store.getActive(base.rule.ruleId), null);
  assert.deepEqual(await store.getGovernedReviewPlan(planned.digest), { digest: planned.digest, plan: planned.plan });
  await store.close(); store = undefined;
  await writeFile(inputFile, JSON.stringify({ ...input, id: 'compiled-successor-plan' }));
  const successor = await cli(['reviews', 'governed', 'plan', '--file', inputFile, '--db', db]);
  assert.equal(successor.jobs[0].ruleDigest, candidate.digest);
  assert.equal(successor.plan.selection.excluded[0].reason, 'superseded');
  assert.equal(successor.plan.selection.selected[0].selectionEvidence.decisionSource, 'fixture');
  assert.deepEqual(successor.jobs, governedReviewJobs(successor)); evidence.stages.push('comparison-backed-successor-selection');
  const replay = await cli(['reviews', 'run', '--rule-digest', base.digest, '--snapshot-digest', demo.snapshotDigest, '--db', db]);
  assert.equal(replay.reviewSelection, 'explicit-digest-replay-not-governance-governed');
  assert.equal(replay.notification, 'not_performed'); evidence.stages.push('manual-replay-label');
  const conflict = await cli(['reviews', 'governed', 'plan', '--file', inputFile, '--db', db, '--postgres'], false);
  assert.match(conflict.stderr, /never both/);
  const queue = await cli(['reviews', 'governed', 'enqueue', '--digest', planned.digest], false);
  assert.match(queue.stderr, /--postgres/);
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ mode: 'compiled-local-governed-review-smoke', ...evidence,
    networkAttempts: 0, productionActivation: 'not_performed', certification: 'none', modelExecution: 'not_run',
    limitations: ['Authored fixtures and local PGlite only; no live PostgreSQL, model, runtime service, credentials or publication.',
      'Successful trusted adapter and real asynchronous pg-boss lifecycle execution are covered by the authored integration tests, not this fail-closed CLI smoke.'] }, null, 2));
} finally { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); }

// Compiled CLI workflow with upstream-source projection and explicit offline fixtures.
// First save failure is an authored DB fault, not model behavior or a CLI feature.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { QualEvoStore } from '../dist/storage/store.js';
import { openPGliteDatabase } from '../dist/storage/database.js';
import { digestOf } from '../dist/core/identity.js';
import { applicationJobDigest } from '../dist/application-job-contract.js';
const exec = promisify(execFile), directory = resolve(process.argv[2] ?? '/tmp/flyrewheel-batch-cli'), root = process.cwd();
await mkdir(directory);
const json = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const save = async (name, data) => writeFile(join(directory, name), JSON.stringify(data, null, 2) + '\n');
await exec(process.execPath, ['scripts/smoke-review-user-flow.mjs', directory, 'init'], { timeout: 60_000, maxBuffer: 2_000_000 });
const seed = await json('seed.json'), dbPath = join(directory, 'db'), commands = [];
const cli = async (args, name, expected = 0) => {
  const command = ['dist/cli.js', ...args, '--db', dbPath];
  const result = await exec(process.execPath, command, { cwd: root, timeout: 30_000, maxBuffer: 4_000_000 })
    .then(value => ({ ...value, code: 0 }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  assert.equal(result.code, expected, result.stderr); commands.push({ command: ['node', ...command], exitCode: result.code, stderr: result.stderr });
  if (name) await writeFile(join(directory, name), result.stdout);
  return result.stdout;
};
const fixture = { schemaVersion: 3, kind: 'semantic-review-offline-fixtures', ...seed.reviewResponse };
await save('fixtures.json', fixture);
const fixturePath = join(directory, 'fixtures.json');
const continuation = JSON.parse(await cli(['revisions', 'continuations', 'create', '--id', 'offline-followup', '--outcome-digest', seed.outcomeDigest,
  '--finding-id', seed.findingId, '--repository-context-digest', seed.contextDigest, '--workspace-id', 'offline-no-workspace', '--attempt', 'offline-followup',
  '--offline-fixture-digest', digestOf(fixture)], 'continuation.json'));
const baseJob = { schemaVersion: 1, kind: 'semantic-review', ruleDigest: seed.ruleDigest, snapshotDigest: seed.snapshotDigest,
  repositoryContextDigests: [seed.contextDigest], workspaceId: 'offline-no-workspace', attempt: 'independent-offline' };
await save('batch-input.json', { id: 'compiled-cli-batch', jobs: [continuation.job, baseJob] });
const batch = JSON.parse(await cli(['reviews', 'batch', 'create', '--file', join(directory, 'batch-input.json'), '--offline-fixtures', fixturePath], 'batch.json'));
const run = ['reviews', 'batch', 'run', '--digest', batch.digest, '--offline-fixtures', fixturePath];
await save('invalid-config.json', { enabled: true, module: '/tmp/forbidden-executable.js' });
await cli(['reviews', 'batch', 'run', '--digest', batch.digest, '--config', join(directory, 'invalid-config.json')], 'wrong-mode.json', 1);
await cli(['reviews', 'batch', 'run', '--digest', batch.digest], 'missing-mode.json', 1);
const changedFixture = structuredClone(fixture); changedFixture.judgments[0].reasoning = 'Different authored input';
await save('wrong-fixtures.json', changedFixture);
await cli(['reviews', 'batch', 'run', '--digest', batch.digest, '--offline-fixtures', join(directory, 'wrong-fixtures.json')], 'wrong-fixtures-result.json', 1);
// Test the existing worker schema and absence of trusted deployment authority on a live job.
await save('live-batch-input.json', { id: 'unconfigured-live-batch', jobs: [baseJob] });
const live = JSON.parse(await cli(['reviews', 'batch', 'create', '--file', join(directory, 'live-batch-input.json')], 'live-batch.json'));
await cli(['reviews', 'batch', 'run', '--digest', live.digest, '--config', join(directory, 'invalid-config.json')], 'invalid-config-result.json', 1);
await save('unconfigured.json', { enabled: true });
await cli(['reviews', 'batch', 'run', '--digest', live.digest, '--config', join(directory, 'unconfigured.json')], 'unconfigured-result.json', 1);
const db = await openPGliteDatabase(dbPath), store = await QualEvoStore.initialize(db);
try {
  for (const job of [...batch.batch.input.jobs, baseJob]) assert.equal(await store.getApplicationJob(applicationJobDigest(job)), null);
  // nextval is not rolled back, so one transient transaction failure can be retried.
  await db.exec(`CREATE SCHEMA authored_cli_fault;
    CREATE SEQUENCE authored_cli_fault.calls;
    CREATE FUNCTION authored_cli_fault.fail_first() RETURNS trigger AS $$ BEGIN
      IF nextval('authored_cli_fault.calls')=1 THEN RAISE EXCEPTION 'AUTHORED_FIRST_REVIEW_SAVE_FAILURE'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER authored_cli_fail_first BEFORE INSERT ON qe_semantic_reviews FOR EACH ROW EXECUTE FUNCTION authored_cli_fault.fail_first();`);
} finally { await store.close(); }
const first = JSON.parse(await cli(run, 'first-run.json', 2));
assert.deepEqual(first.counts, { total: 2, notStarted: 0, running: 0, retryable: 1, completed: 1, blocked: 0 });
assert.equal(first.items[0].result.reason, 'persistence_failed');
assert.equal(first.executionMode, 'authored-offline-fixtures'); assert.equal(first.workspaceExecution, 'not_run');
const resumed = JSON.parse(await cli(run, 'resume-without-retry.json', 2));
assert.deepEqual(resumed, first);
await cli(['reviews', 'batch', 'status', '--digest', batch.digest], 'restart-status.json');
const firstJob = batch.batch.input.jobs[0], jobDigest = applicationJobDigest(firstJob);
await save('retry-job.json', firstJob);
const retry = JSON.parse(await cli([...run, '--retry-job-digest', jobDigest], 'retry-run.json'));
assert.equal(retry.counts.completed, 2); assert.deepEqual(retry.items.map(item => item.attempts), [2, 1]);
assert.deepEqual(JSON.parse(await cli([...run, '--retry-job-digest', jobDigest], 'repeat-run.json')), retry);
const history = JSON.parse(await cli(['application-jobs', 'history', '--file', join(directory, 'retry-job.json')], 'history.json'));
assert.deepEqual(history.outcomes.map(item => [item.attempt, item.result.status]), [[1, 'failed'], [2, 'completed']]);
const continued = JSON.parse(await cli(['revisions', 'continuations', 'status', '--digest', continuation.digest], 'continuation-status.json'));
assert.equal(continued.assessment, 'unknown');
const report = JSON.parse(await cli(['reviews', 'batch', 'export', '--digest', batch.digest], 'report.json'));
assert.equal(report.rows[0].findings.unknown, 1); assert.equal(report.rows[0].modelExecution, 'not_run');
await cli(['reviews', 'batch', 'export', '--digest', batch.digest, '--format', 'csv'], 'report.csv');
const reopenedDb = await openPGliteDatabase(dbPath), reopened = await QualEvoStore.initialize(reopenedDb);
try {
  for (const item of retry.items) {
    const review = await reopened.getSemanticReview(item.result.outcome.id);
    assert.equal(review.config.mode, 'offline_fixture'); assert.equal(review.executionReceipt, undefined);
  }
  assert.equal((await reopenedDb.query('SELECT count(*)::integer AS n FROM qe_semantic_reviews')).rows[0].n, 3); // original plus two new reviews
  assert.deepEqual(await reopened.getReviewFinding(seed.findingId), seed.originals.finding);
  assert.deepEqual(await reopened.getRevisionOutcome(seed.outcomeDigest), seed.originals.outcome);
  await reopenedDb.exec('DROP TRIGGER authored_cli_fail_first ON qe_semantic_reviews; DROP SCHEMA authored_cli_fault CASCADE;');
} finally { await reopened.close(); }
const evidence = { status: 'passed', implementationBase: 'd02d1bb', source: seed.provenance, commands,
  checks: { compiledCliCreateRunRestartRetryExport: true, invalidConfigurationBeforeClaims: true, duplicateRunNoAdditionalReviews: true,
    retryHistoryPreserved: true, unknownPreserved: true, fixtureJobIdentitySeparated: true, workspaceOrModelReceiptInvented: false, credentialsConsulted: false },
  executionMode: 'authored-offline-fixtures', modelExecution: 'not_run', workspaceExecution: 'not_run',
  fault: 'authored one-time database insert rejection; not a model failure', history, report,
  limitation: 'Default CLI has no trusted deployment authority/resolver; live --config requires reviewed embedding, not JSON-only authorization' };
await save('verification.json', evidence); console.log(JSON.stringify(evidence, null, 2));

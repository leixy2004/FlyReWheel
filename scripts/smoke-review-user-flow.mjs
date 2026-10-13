// Real GitHub-sourced bytes in an explicitly projected Git repository; authored
// runtime envelopes only. Never copies a full checkout or reads research data.
// Build first. Run: node scripts/smoke-review-user-flow.mjs <fresh-output-directory>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QualEvoStore } from '../dist/storage/store.js';
import { openPGliteDatabase } from '../dist/storage/database.js';
import { captureChangeSnapshot } from '../dist/change-snapshot.js';
import { captureRepositoryContext } from '../dist/repository-context.js';
import { makeSnapshotAnchor, makeReviewEvidence } from '../dist/adapters/semantic-review-fixture.js';
import { buildSemanticReview } from '../dist/semantic-review.js';
import { generateRuleRevision } from '../dist/rule-revision.js';
import { prepareWorkspace, inspectWorkspace } from '../dist/workspace/index.js';
import { applicationJobDigest } from '../dist/application-job-contract.js';
import { runReviewBatch, reviewBatchStatus } from '../dist/review-batch.js';
import { exportReviewBatch, reviewBatchCsv } from '../dist/review-batch-export.js';
const exec = promisify(execFile), root = process.cwd(), script = fileURLToPath(import.meta.url);
const [argument, phase] = process.argv.slice(2), directory = resolve(argument ?? '/tmp/flyrewheel-user-flow');
const dbPath = join(directory, 'db'), projection = join(directory, 'source-projection');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (name, data) => writeFile(join(directory, name), JSON.stringify(data, null, 2) + '\n');
const git = async (cwd, ...args) => (await exec('git', args, { cwd, maxBuffer: 2_000_000 })).stdout;
const date = '2026-10-13T00:00:00Z', config = { enabled: true, model: 'authored-user-flow-no-model' };
const limits = { maxInputBytes: 1_000_000, maxOutputBytes: 131072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 5000, cleanupTimeoutMs: 1500 };
const envelope = (outputContract, value) => ({ protocolVersion: 2, outputContract, value,
  usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }, sessionId: 'authored-envelope',
  processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true }, boundary: 'authored-test-no-isolation' });
function runtime(valueFor, fault = () => {}) {
  return { id: 'authored-offline-user-flow', limits, backend: { kind: 'authored-test-no-isolation', reserve(request) {
    return { async prepare() { return { expectedSha: request.expectedSha, headSha: request.expectedSha, clean: true, identityValid: true, historyPolicy: request.historyPolicy }; },
      async execute() { await appendFile(join(directory, 'executions.jsonl'), JSON.stringify({ contract: request.outputContract, phase }) + '\n');
        await fault(request); return envelope(request.outputContract, valueFor(request)); },
      async stop() { return { stopped: true, verified: true }; }, async collect() { return []; }, async destroy() { return { destroyed: true, verified: true }; } };
  } } };
}
async function dependencies(store, seed, mode, controller) {
  const prepared = new Set(); let first = true;
  return { store, config, runtime: runtime(() => seed.reviewResponse, async () => {
    if (!first) return; first = false;
    if (mode === 'fail') throw new Error('Authored first-item runtime failure');
    if (mode === 'cancel') { controller.abort(); throw new Error('Authored cancellation after runtime entry'); }
  }), resolveWorkspace: async selection => {
    const workspace = { repoPath: projection, runId: 'user-flow', attemptId: selection.jobDigest.slice(0, 24) };
    if (!prepared.has(selection.jobDigest)) {
      try { const existing = await inspectWorkspace(workspace); assert.equal(existing.record.baseSha, selection.expectedSha); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await prepareWorkspace({ ...workspace, baseSha: selection.expectedSha }); }
      prepared.add(selection.jobDigest);
    }
    return workspace;
  } };
}
if (phase === 'init') {
  const sourceBase = '0b476d9f6835fec63b3b924c0de3120d3c79922f', sourceHead = '1bc2afffdd28c5ebde64f81e39944d816fdca8f7';
  const path = 'src/application-preflight.ts', contextPath = 'src/core/identity.ts';
  // This is the complete allowlist of source bytes read from the original repository.
  const source = await git(root, 'show', `${sourceHead}:${path}`), contextSource = await git(root, 'show', `${sourceHead}:${contextPath}`);
  assert.equal(await git(root, 'show', `${sourceBase}:${contextPath}`), contextSource);
  assert.equal((await git(root, 'ls-tree', sourceBase, '--', path)).trim(), '', 'Selected changed file must be added in this exact upstream diff');
  await mkdir(join(projection, 'src/core'), { recursive: true });
  await git(projection, 'init', '--initial-branch=main'); await git(projection, 'config', 'user.name', 'Authored Offline Verification');
  await git(projection, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(projection, '.gitignore'), '.sandcastle/\n'); await writeFile(join(projection, contextPath), contextSource);
  await git(projection, 'add', '.'); await git(projection, 'commit', '-m', 'Projection of unchanged upstream context');
  const base = (await git(projection, 'rev-parse', 'HEAD')).trim();
  await writeFile(join(projection, path), source); await git(projection, 'add', '.'); await git(projection, 'commit', '-m', 'Projection of exact upstream added source');
  const head = (await git(projection, 'rev-parse', 'HEAD')).trim(), repository = 'projection:github.com/leixy2004/FlyReWheel';
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const provenance = { origin: 'https://github.com/leixy2004/FlyReWheel', sourceBase, sourceHead, sourcePathsRead: [path, contextPath],
    originalSourceSha256: sourceHash, projectionBase: base, projectionHead: head,
    boundary: 'real-upstream-source-bytes-selected-path-projection-not-the-original-repository-tree', researchW1: 'not_read' };
  const store = await QualEvoStore.openPGlite(dbPath);
  try {
    const snapshot = await store.importChangeSnapshot((await captureChangeSnapshot({ repositoryPath: projection, repositoryId: repository, baseTip: base, head })).snapshot);
    const context = await store.importRepositoryContext((await captureRepositoryContext({ repositoryPath: projection, repositoryId: repository, head, paths: [contextPath] })).context);
    const problem = { id: 'real-source-unlabelled', lineageId: 'real-source-unlabelled', split: 'training', expected: 'unknown', title: 'Upstream source with no correctness label',
      repository, commit: head, path, sourceDigest: sourceHash, provenance: { kind: 'imported', reference: `${provenance.origin}/blob/${sourceHead}/${path}`, reviewedBy: null, derivedFromCaseId: null } };
    const rule = await store.importRuleVersion({ schemaVersion: 2, ruleId: 'authored-governance-review', version: 'base',
      semantics: { title: 'Check governance before execution', mechanism: 'Authored review criterion', invariant: 'Validate exact governance selection', applicability: ['Governed review paths'],
        exceptions: [], requiredContext: ['governance-policy'], expectedBehavior: 'Retain unknown when policy is not established' },
      scope: { repositories: [repository], paths: { include: [path], exclude: [] } }, regressionCases: [],
      provenance: { sourceCases: [{ caseId: problem.id, repository, commit: head, path, sourceDigest: sourceHash }], parentDigest: null,
        author: 'authored-validation', createdAt: date, rationale: 'Workflow validation only; no empirical bug claim' } }, [problem]);
    const target = buildSemanticReview({ rule, snapshot }).coverage.targets.find(item => item.disposition === 'captured');
    const start = source.indexOf('if (job.governancePlanDigest)'); assert.ok(start >= 0);
    const anchor = makeSnapshotAnchor(snapshot, 'after', path, start, start + 'if (job.governancePlanDigest)'.length), proof = makeReviewEvidence(snapshot, anchor, 'source');
    const judgments = [{ targetId: target.id, decision: 'unknown', reasoning: 'Authored unresolved policy', evidenceRefs: [proof.id], missingContext: ['governance-policy'],
      anchorJudgments: [{ anchor, decision: 'unknown', reasoning: 'Authored unresolved policy', evidenceRefs: [proof.id], missingContext: ['governance-policy'] }] }];
    const fixtures = { schemaVersion: 2, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence: [proof], judgments };
    const review = await store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest, fixtures });
    const finding = review.findings[0]; assert.equal(finding.status, 'unknown');
    const feedback = await store.appendReviewFeedback({ id: 'authored-routing-feedback', findingId: finding.id, reviewId: review.id, ruleDigest: rule.digest, ruleVersion: 'base',
      source: 'fixture', actor: 'authored-verifier', kind: 'label', label: 'FP', reason: 'Authored routing fixture only; not a real correctness label', createdAt: date });
    const request = await store.createRevisionRequest({ id: 'authored-context-request', baseRuleDigest: rule.digest, requestedRuleVersion: 'proposed', feedbackIds: [feedback.id],
      requestedChange: 'Request missing policy without changing the rule', actor: 'authored-verifier', source: 'fixture', createdAt: date });
    const response = { policyVersion: 'diagnosis-operators-v1', requestDigest: request.digest, baseRuleDigest: rule.digest, requestedRuleVersion: 'proposed', result: {
      status: 'no_rule_change', operator: 'request_context', reasoning: 'Policy remains unavailable', nextStep: 'Select explicit context for a separate follow-up', missingEvidence: ['governance-policy'],
      evidenceRefs: [`rule:${rule.digest}`, `feedback:${feedback.id}`, `finding:${finding.id}`],
      diagnoses: [{ feedbackId: feedback.id, category: 'context', reasoning: 'Authored diagnosis only', missingEvidence: ['governance-policy'], evidenceRefs: [`feedback:${feedback.id}`], claim: 'proposal-not-established-fact' }] } };
    const workspace = { repoPath: projection, runId: 'user-flow', attemptId: 'diagnosis' }; await prepareWorkspace({ ...workspace, baseSha: head });
    const generated = await generateRuleRevision(store, { requestDigest: request.digest, candidateId: 'authored-outcome', candidateCreatedAt: date,
      context: { kind: 'selected-evidence-no-tools', workspace, snapshotDigest: snapshot.digest } }, config, runtime(() => response));
    assert.ok('savedOutcome' in generated, JSON.stringify(generated));
    await save('seed.json', { provenance, outcomeDigest: generated.savedOutcome.digest, findingId: finding.id, ruleDigest: rule.digest, snapshotDigest: snapshot.digest, contextDigest: context.digest,
      originals: { finding: await store.getReviewFinding(finding.id), outcome: generated.savedOutcome },
      reviewResponse: { ruleDigest: rule.digest, snapshotDigest: snapshot.digest, repositoryContextDigests: [context.digest], evidence: [proof], judgments } });
  } finally { await store.close(); }
} else if (['fail', 'retry', 'cancel', 'interrupt', 'expire'].includes(phase)) {
  const seed = await json(join(directory, 'seed.json')), batch = await json(join(directory, 'batch.json'));
  const db = await openPGliteDatabase(dbPath), store = await QualEvoStore.initialize(db);
  try {
    const controller = new AbortController(), deps = await dependencies(store, seed, phase, controller);
    if (phase === 'fail') await save('first-run.json', await runReviewBatch(deps, batch.digest, controller.signal));
    if (phase === 'retry') {
      const retry = { retryJobDigests: [applicationJobDigest(batch.batch.input.jobs[0])] };
      // Concurrent API invocations share the same PGlite owner. Distinct processes
      // reopen sequentially; this is not a multi-process PostgreSQL contention test.
      await Promise.all([runReviewBatch(deps, batch.digest, controller.signal, retry), runReviewBatch(deps, batch.digest, controller.signal, retry)]);
      await runReviewBatch(deps, batch.digest, controller.signal, retry);
      await save('after-retry.json', await reviewBatchStatus(store, batch.digest));
      const report = await exportReviewBatch(store, batch.digest), formula = structuredClone(report);
      for (const prefix of ['=', '+', '-', '@', '\t', '\n']) {
        formula.rows[0].nextAction = prefix + 'SUM("x")\nsecond line';
        assert.ok(reviewBatchCsv(formula).includes(`"'${prefix}SUM(""x"")\nsecond line"`));
      }
      assert.deepEqual(await store.getReviewFinding(seed.findingId), seed.originals.finding);
      assert.deepEqual(await store.getRevisionOutcome(seed.outcomeDigest), seed.originals.outcome);
      assert.equal(await store.getActive('authored-governance-review'), null);
    }
    if (phase === 'cancel') {
      const cancelBatch = await store.createReviewBatch({ id: 'cancel-batch', jobs: batch.batch.input.jobs.map((job, i) => ({
        schemaVersion: 1, kind: 'semantic-review', ruleDigest: job.ruleDigest, snapshotDigest: job.snapshotDigest,
        repositoryContextDigests: job.repositoryContextDigests, workspaceId: job.workspaceId, attempt: `cancel-${i}` })) });
      await assert.rejects(runReviewBatch(deps, cancelBatch.digest, controller.signal));
      await save('cancel-batch.json', cancelBatch);
    }
    if (phase === 'interrupt') {
      const job = { ...batch.batch.input.jobs[1], attempt: 'interrupted' };
      assert.equal((await store.claimApplicationJob(job, randomUUID())).state, 'claimed');
      await save('interrupted-job.json', job); // Process closes with an uncompleted live claim.
    }
    if (phase === 'expire') {
      const job = await json(join(directory, 'interrupted-job.json'));
      // Time acceleration only: simulate elapsed lease after the previous process exited.
      await db.exec('ALTER TABLE qe_application_jobs DISABLE TRIGGER qe_application_jobs_transition');
      await db.query("UPDATE qe_application_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_digest=$1", [applicationJobDigest(job)]);
      await db.exec('ALTER TABLE qe_application_jobs ENABLE TRIGGER qe_application_jobs_transition');
    }
  } finally { await store.close(); }
} else {
  await mkdir(directory, { recursive: false });
  const commands = [];
  const child = async phase => { commands.push(['node', 'scripts/smoke-review-user-flow.mjs', directory, phase]);
    await exec(process.execPath, [script, directory, phase], { cwd: root, timeout: 60_000, maxBuffer: 2_000_000 }); };
  const cli = async (args, name) => {
    commands.push(['node', 'dist/cli.js', ...args, '--db', dbPath]);
    const { stdout } = await exec(process.execPath, [join(root, 'dist/cli.js'), ...args, '--db', dbPath], { cwd: root, timeout: 30_000, maxBuffer: 4_000_000 });
    if (name) await writeFile(join(directory, name), stdout); return stdout;
  };
  await child('init'); const seed = await json(join(directory, 'seed.json'));
  const continuationArgs = ['revisions', 'continuations', 'create', '--id', 'real-source-followup', '--outcome-digest', seed.outcomeDigest,
    '--finding-id', seed.findingId, '--repository-context-digest', seed.contextDigest, '--workspace-id', 'offline-projection', '--attempt', 'followup'];
  const continuation = JSON.parse(await cli(continuationArgs, 'continuation.json'));
  assert.deepEqual(JSON.parse(await cli(continuationArgs)), continuation);
  await save('retry-job.json', continuation.job);
  await save('batch-input.json', { id: 'real-source-batch', jobs: [continuation.job,
    { schemaVersion: 1, kind: 'semantic-review', ruleDigest: seed.ruleDigest, snapshotDigest: seed.snapshotDigest, repositoryContextDigests: [seed.contextDigest], workspaceId: 'offline-projection', attempt: 'independent' }] });
  const batch = JSON.parse(await cli(['reviews', 'batch', 'create', '--file', join(directory, 'batch-input.json')], 'batch.json'));
  await child('fail'); const failed = JSON.parse(await cli(['reviews', 'batch', 'status', '--digest', batch.digest], 'before-retry-status.json'));
  assert.deepEqual(failed.counts, { total: 2, notStarted: 0, running: 0, retryable: 1, completed: 1, blocked: 0 });
  await cli(['reviews', 'batch', 'export', '--digest', batch.digest], 'before-retry-report.json');
  await child('retry');
  const continued = JSON.parse(await cli(['revisions', 'continuations', 'status', '--digest', continuation.digest], 'continuation-status.json'));
  assert.equal(continued.state, 'completed'); assert.equal(continued.assessment, 'unknown'); assert.equal(continued.result.modelExecution, 'not_run');
  const history = JSON.parse(await cli(['application-jobs', 'history', '--file', join(directory, 'retry-job.json')], 'retry-history.json'));
  assert.deepEqual(history.outcomes.map(x => [x.attempt, x.result.status]), [[1, 'failed'], [2, 'completed']]);
  assert.equal(history.missingHistoricalAttempts, 0);
  const report = JSON.parse(await cli(['reviews', 'batch', 'export', '--digest', batch.digest], 'report.json'));
  assert.equal(report.counts.completed, 2); assert.equal(report.rows[0].findings.unknown, 1); assert.equal(report.rows[0].findings.safe, 0);
  await cli(['reviews', 'batch', 'export', '--digest', batch.digest, '--format', 'csv'], 'report.csv');
  await child('cancel'); const cancelBatch = await json(join(directory, 'cancel-batch.json'));
  const cancelled = JSON.parse(await cli(['reviews', 'batch', 'status', '--digest', cancelBatch.digest], 'cancel-status.json'));
  assert.equal(cancelled.counts.retryable, 1); assert.equal(cancelled.counts.notStarted, 1); assert.equal(cancelled.items[0].result.reason, 'cancelled');
  await child('interrupt'); await child('expire');
  const interrupted = JSON.parse(await cli(['application-jobs', 'history', '--file', join(directory, 'interrupted-job.json')], 'interrupted-history.json'));
  assert.equal(interrupted.outcomes[0].result.reason, 'interrupted_execution_requires_recovery'); assert.equal(interrupted.outcomes[0].result.modelExecution, 'unknown');
  const executions = (await readFile(join(directory, 'executions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(executions.filter(x => x.phase === 'retry').length, 1, 'Concurrent/repeated retry must execute once');
  const evidence = { status: 'passed', provenance: seed.provenance, commands,
    checks: { processRestarts: true, originalRecordsUnchanged: true, failureHistoryRetained: true, unknownAnchorPreserved: true,
      concurrentAndRepeatedRetryExecutions: 1, csvFormulaPrefixes: ['=', '+', '-', '@', 'tab', 'newline'], cancellation: 'retryable-first-unstarted-second',
      interruptedLease: 'blocked-model-execution-unknown', leaseElapsedTime: 'accelerated-by-authored-database-fixture', activation: 'not_performed' },
    modelExecution: 'not_run', runtime: 'authored-envelopes-no-SDK-or-model-call',
    limitations: ['Selected real-source projection, not the complete upstream repository', 'Authored rule, feedback and judgments; no empirical bug/quality claim',
      'Sequential cross-process PGlite reopen; concurrent API calls share one process, not PostgreSQL multi-process contention',
      'Batch execution still requires trusted application API dependencies; no generic local execution CLI'], executions };
  await save('verification.json', evidence); console.log(JSON.stringify(evidence, null, 2));
}

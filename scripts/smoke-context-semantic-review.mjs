// Offline compiled application smoke. Authored executable only; no live model, network or isolation claim.
// Run from repository root after npm run build. Temporary Git/database files are always removed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const fromDist = path => import(pathToFileURL(join(root, 'dist', path)));
const { QualEvoStore } = await fromDist('storage/store.js');
const { workspaceGit } = await fromDist('workspace/process.js');
const { prepareWorkspace, cleanupWorkspace } = await fromDist('workspace/index.js');
const { captureRepositoryContext, makeRepositoryContextAnchor, makeRepositoryContextEvidence } = await fromDist('repository-context.js');
const { captureChangeSnapshot } = await fromDist('change-snapshot.js');
const { digestOf } = await fromDist('core/identity.js');
const { sourceDigest } = await fromDist('adapters/candidates.js');
const { makeReviewEvidence, makeSnapshotAnchor } = await fromDist('adapters/semantic-review-fixture.js');
const { buildSemanticReview } = await fromDist('semantic-review.js');
const { createSemanticReviewWorkspaceModelAdapter } = await fromDist('adapters/semantic-review-model.js');
const { runWorkspaceWorkerCommand } = await fromDist('workspace-worker-entrypoint.js');
const directory = await mkdtemp(join(tmpdir(), 'compiled-context-review-fixture-'));
let store;
try {
  const repoPath = join(directory, 'repo'), path = 'src/smoke.ts', repository = 'synthetic:compiled-review';
  const policy = '// Local policy: publicRead is explicitly public; privateRead requires an authorization guard.\n';
  const before = 'export function publicRead() { return null; }\nexport function privateRead() { return null; }\n';
  const after = 'export function publicRead() { return dangerousRead(); }\nexport function privateRead() { return dangerousRead(); }\n';
  await mkdir(join(repoPath, 'src'), { recursive: true });
  await mkdir(join(repoPath, 'contracts')); await mkdir(join(repoPath, 'tests'));
  const contractPath = 'contracts/read.txt', testPath = 'tests/read.txt';
  const contractTest = 'Authored test specification: publicRead is exempt; privateRead must check authorization.\n';
  await writeFile(join(repoPath, contractPath), policy); await writeFile(join(repoPath, testPath), contractTest);
  const git = async (...args) => (await workspaceGit(repoPath, ...args)).trim();
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Authored Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n'); await writeFile(join(repoPath, path), before);
  await git('add', '.'); await git('commit', '-m', 'authored before'); const base = await git('rev-parse', 'HEAD');
  await writeFile(join(repoPath, path), after); await git('add', '.'); await git('commit', '-m', 'authored after'); const head = await git('rev-parse', 'HEAD');
  const captured = await captureChangeSnapshot({ repositoryPath: repoPath, repositoryId: repository, baseTip: base, head });
  const problemCase = { id: 'compiled-source', lineageId: 'compiled-source', split: 'training', expected: 'unknown', title: 'Authored compiled smoke source', repository, commit: base, path, sourceDigest: sourceDigest(before), provenance: { kind: 'synthetic', reference: 'fixture:compiled-review', reviewedBy: null, derivedFromCaseId: null } };
  const ruleInput = { schemaVersion: 2, ruleId: 'compiled-rule', version: 'draft', semantics: { title: 'Review guarded reads', mechanism: 'A privileged read without an authorization guard may expose protected data', invariant: 'An authorization guard precedes privileged reads', applicability: ['All privileged reads'], exceptions: [], requiredContext: ['callee-contract', 'test'], expectedBehavior: 'Require an authorization guard and preserve unknown if required policy evidence is unavailable' }, scope: { repositories: [repository], paths: { include: ['src'], exclude: [] } }, detectionAssets: [], regressionCases: [], provenance: { sourceCases: [{ caseId: problemCase.id, repository, commit: base, path, sourceDigest: problemCase.sourceDigest }], parentDigest: null, author: 'authored-fixture', createdAt: '2026-10-02T00:00:00Z', rationale: 'Compiled application plumbing only, no model or human label' } };
  const dbPath = join(directory, 'db'); store = await QualEvoStore.openPGlite(dbPath);
  const rule = await store.importRuleVersion(ruleInput, [problemCase]), snapshot = await store.importChangeSnapshot(captured.snapshot);
  const capturedContext = await captureRepositoryContext({ repositoryPath: repoPath, repositoryId: repository, head, paths: [contractPath, testPath] });
  const selectedContext = await store.importRepositoryContext(capturedContext.context);
  const repositoryContexts = [selectedContext];
  assert(!snapshot.snapshot.changes.some(change => change.after.state !== 'absent' && [contractPath, testPath].includes(change.after.path)));
  const target = buildSemanticReview({ rule, snapshot }).coverage.targets[0];
  const start = after.indexOf('dangerousRead()'), anchor = makeSnapshotAnchor(snapshot, 'after', path, start, start + 'dangerousRead()'.length);
  const secondStart = after.lastIndexOf('dangerousRead()');
  const secondAnchor = makeSnapshotAnchor(snapshot, 'after', path, secondStart, secondStart + 'dangerousRead()'.length);
  const evidence = [anchor, secondAnchor].map(item => makeReviewEvidence(snapshot, item, 'captured-source'));
  const policyEvidence = makeRepositoryContextEvidence(selectedContext, makeRepositoryContextAnchor(selectedContext, contractPath, 0, policy.length), 'callee-contract');
  const testEvidence = makeRepositoryContextEvidence(selectedContext, makeRepositoryContextAnchor(selectedContext, testPath, 0, contractTest.length), 'test');
  const response = { ruleDigest: rule.digest, snapshotDigest: snapshot.digest, repositoryContextDigests: [selectedContext.digest], evidence: [...evidence, policyEvidence, testEvidence],
    judgments: [{ targetId: target.id, decision: 'violation', reasoning: 'Authored base flags both reads, not live model or human proof',
      evidenceRefs: [...evidence.map(item => item.id), policyEvidence.id, testEvidence.id], missingContext: [], anchorJudgments: evidence.map(item => ({
        anchor: item.anchor, decision: 'violation', reasoning: 'Authored baseline flags each unguarded read before the public exception is introduced.', evidenceRefs: [item.id, policyEvidence.id, testEvidence.id], missingContext: [],
      })) }] };

  const withoutContext = buildSemanticReview({ rule, snapshot, fixtures: { schemaVersion: 2, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence, judgments: response.judgments.map(j => ({ ...j, evidenceRefs: evidence.map(e => e.id), anchorJudgments: j.anchorJudgments.map((a,i) => ({ ...a, evidenceRefs: [evidence[i].id] })) })) } });
  assert(withoutContext.findings.every(f => f.status === 'unknown'));
  const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const executable = join(directory, 'authored-cli.cjs'), requestPath = join(directory, 'worker.json');
  const writeResponse = () => writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const s=x=>console.log(JSON.stringify(x));s({type:'thread.started',thread_id:'authored-compiled-session'});s({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(response)})}});s({type:'turn.completed',usage:${JSON.stringify(usage)}});});\n`, { mode: 0o700 });
  const workspace = { repoPath, runId: 'compiled', attemptId: 'authored' }; await prepareWorkspace({ ...workspace, baseSha: head });
  const limits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
  const backend = { kind: 'authored-test-no-isolation', reserve(request, record) {
    assert.equal(request.outputContract, 'semantic-review-v3'); assert.equal(request.expectedSha, head);
    return {
      async prepare() { return { expectedSha: head, headSha: head, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
      async execute(signal) {
        await writeResponse();
        await writeFile(requestPath, JSON.stringify({ workingDirectory: record.worktreePath, model: request.model, prompt: request.prompt, outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits }));
        return JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: directory, workingDirectory: record.worktreePath, requestPath, codexPathOverride: executable, imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } } }, signal));
      },
      async stop() { return { stopped: true, verified: true }; }, async collect() { return []; }, async destroy() { return { destroyed: true, verified: true }; },
    };
  } };
  const outcome = await createSemanticReviewWorkspaceModelAdapter({ enabled: true, model: 'authored-compiled-no-model' }, { id: 'authored-compiled-runtime', backend, limits }).review({ rule, snapshot, repositoryContexts, context: { kind: 'full-repository', repository, checkout: 'after', workspace } });
  assert.equal(outcome.execution, 'succeeded', JSON.stringify(outcome)); assert.equal(outcome.modelExecution, 'not_run');
  const saved = await store.saveSemanticReviewModelResult(outcome.persistence); assert.equal(saved.findings.length, 2); assert.equal(saved.findings[0].origin, 'fixture');
  assert.equal((await store.getReviewFinding(saved.findings[0].id)).verdict, 'Unknown');
  const candidate = await store.importRuleVersion({ ...ruleInput, version: 'candidate', semantics: { ...ruleInput.semantics,
    applicability: ['Privileged reads whose captured local policy does not explicitly declare them public'],
    exceptions: ['An explicitly public read may omit an authorization guard when exact captured local-policy evidence establishes that exception'],
    expectedBehavior: 'Accept the explicitly public read, retain the unguarded private-read violation, and preserve unknown where policy is unresolved',
  }, provenance: { ...ruleInput.provenance, parentDigest: rule.digest,
    rationale: 'Authored conditional exception grounded in the captured local policy, not a model or human correctness claim' } });
  const candidateTarget = buildSemanticReview({ rule: candidate, snapshot }).coverage.targets[0];
  response.ruleDigest = candidate.digest;
  response.judgments = [{ targetId: candidateTarget.id, decision: 'unknown', reasoning: 'Complete target coverage remains unresolved.', evidenceRefs: [], missingContext: ['Remaining target policy context'],
    anchorJudgments: [
      { anchor, decision: 'safe', reasoning: 'Authored legitimate exception: local policy explicitly declares publicRead public.', evidenceRefs: [evidence[0].id, policyEvidence.id, testEvidence.id], missingContext: [] },
      { anchor: secondAnchor, decision: 'violation', reasoning: 'Authored retained violation: local policy requires privateRead authorization, but its captured body has no guard.', evidenceRefs: [evidence[1].id, policyEvidence.id, testEvidence.id], missingContext: [] },
    ] }];
  const candidateOutcome = await createSemanticReviewWorkspaceModelAdapter({ enabled: true, model: 'authored-compiled-no-model' }, { id: 'authored-compiled-runtime', backend, limits })
    .review({ rule: candidate, snapshot, repositoryContexts, context: { kind: 'full-repository', repository, checkout: 'after', workspace } });
  assert.equal(candidateOutcome.execution, 'succeeded', JSON.stringify(candidateOutcome));
  assert.equal(candidateOutcome.modelExecution, 'not_run');
  const candidateReview = await store.saveSemanticReviewModelResult(candidateOutcome.persistence);
  assert.deepEqual(candidateReview.findings.map(item => item.status).sort(), ['safe', 'violation']);
  assert.equal(candidateReview.coverage.targets[0].semantic.state, 'unknown');
  assert.equal(candidateReview.executionReceipt.judgmentContract, 'per-anchor-context-v4');
  assert.equal(candidateReview.occurrences.length, 0);
  for (const [index, location] of [anchor, secondAnchor].entries()) {
    const finding = saved.findings.find(item => digestOf(item.anchor) === digestOf(location));
    await store.appendReviewFeedback({ id: `compiled-${index}`, findingId: finding.id, reviewId: saved.id, ruleDigest: rule.digest,
      ruleVersion: rule.rule.version, source: 'fixture', actor: 'authored-fixture', kind: 'label', label: index === 0 ? 'FP' : 'TP',
      reason: 'Authored expectation only, not human or model truth.', createdAt: '2026-10-02T00:00:00Z' });
  }
  const revision = await store.createRevisionRequest({ id: 'compiled-mixed-request', baseRuleDigest: rule.digest, requestedRuleVersion: 'candidate',
    feedbackIds: ['compiled-0', 'compiled-1'], requestedChange: 'Introduce the captured explicitly public-read exception while retaining the same-file private-read authorization violation.',
    actor: 'authored-fixture', source: 'fixture', createdAt: '2026-10-02T00:00:00Z' });
  const comparison = await store.createRevisionComparison({ id: 'compiled-mixed-comparison', requestDigest: revision.digest, candidateRuleDigest: candidate.digest,
    reviewPairs: [{ baseReviewId: saved.id, candidateReviewId: candidateReview.id }], caseBindings: [] });
  assert.equal(comparison.comparison.scorer, 'per-anchor-context-v4');
  assert.equal(comparison.comparison.summary.status, 'compatible');
  assert.equal(comparison.comparison.summary.corrected, 1); assert.equal(comparison.comparison.summary.preserved, 1);
  assert.equal(comparison.comparison.summary.inconclusive, 0);
  assert.equal((await cleanupWorkspace(workspace)).record.status, 'closed-clean');
  await rm(repoPath, { recursive: true, force: true });
  await store.close(); store = await QualEvoStore.openPGlite(dbPath);
  assert.deepEqual(await store.getSemanticReview(saved.id), saved);
  assert.deepEqual(await store.getSemanticReview(candidateReview.id), candidateReview);
  assert.deepEqual(await store.getRevisionComparison(comparison.digest), comparison);
  assert.equal(await store.getActive(rule.rule.ruleId), null);
  const receipt = saved.executionReceipt;
  console.log(JSON.stringify({ mode: 'authored-compiled-sdk-selected-context-review-smoke', contextDigest: selectedContext.digest, repositoryContextCheck: receipt.repositoryContextCheck, historicalAvailability: 'unproven', sourceRepositoryRemovedBeforeReopen: true, contextAbsentFindings: withoutContext.findings.map(f => f.status), liveModel: 'not_run', isolation: 'not_verified', ruleDigest: saved.ruleDigest, snapshotDigest: saved.snapshotDigest, reviewId: saved.id, reviewDigest: digestOf(saved), reopenedIdentically: true, protocol: receipt.workerResult.outputContract, sessionId: receipt.workerResult.sessionId, modelExecution: receipt.modelExecution, snapshotCheck: receipt.snapshotCheck, cleanup: receipt.cleanup, lifecycle: receipt.lifecycle, candidateReviewId: candidateReview.id, candidateTargetState: candidateReview.coverage.targets[0].semantic.state, requiredContext: candidate.rule.semantics.requiredContext, candidateException: candidate.rule.semantics.exceptions, capturedPolicy: policyEvidence.content, candidateAnchorDecisions: candidateReview.findings.map(item => ({ path: item.anchor.path, offset: item.anchor.span.start.offset, status: item.status, evidenceRefs: item.evidenceRefs })), comparisonDigest: comparison.digest, scorer: comparison.comparison.scorer, summary: comparison.comparison.summary, finding: { status: saved.findings[0].status, origin: saved.findings[0].origin, humanVerdict: 'Unknown', introduction: saved.findings[0].introduction, notificationEligibility: saved.findings[0].notificationEligibility }, notification: saved.notification }, null, 2));
} finally { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); }

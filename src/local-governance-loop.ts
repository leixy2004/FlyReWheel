import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runLocalClosedLoop } from './local-closed-loop.js';
import { QualEvoStore } from './storage/store.js';
import { digestOf } from './core/identity.js';
import { SemanticGovernanceCommandSchema } from './core/semantic-governance.js';
import { SemanticReviewSchema } from './core/semantic-review.js';
import { PerAnchorSemanticReviewModelResponseSchema } from './core/semantic-review-model.js';
import { governedReviewJobs, governedReviewStatus, runGovernedReviewPlan } from './governed-semantic-review.js';
import { applicationJobDigest } from './application-job-contract.js';
import { prepareWorkspace, cleanupWorkspace } from './workspace/index.js';
import { workspaceGit } from './workspace/process.js';
import type { CodexWorkspaceBackend } from './workspace/codex-runner.js';
import type { ApplicationDispatcherDependencies } from './application-dispatcher.js';
import { runWorkspaceWorkerCommand } from './workspace-worker-entrypoint.js';

const DATE = '2026-10-04T00:00:00Z';
const KIND = 'authored-local-governance-loop-v1';
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function present(path: string) {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function regular(path: string) { const info = await lstat(path); assert(info.isFile() && !info.isSymbolicLink(), 'Expected regular fixture file'); }
async function immutable(path: string, value: unknown) {
  const bytes = encoded(value);
  if (await present(path)) { await regular(path); assert.equal(await readFile(path, 'utf8'), bytes, `Immutable artifact changed: ${path}`); }
  else await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
}

/** Explicit authored demo only. It does not accept runtime/model/provider settings. */
export async function runLocalGovernanceLoop(options: { outDir: string }): Promise<Record<string, unknown>> {
  await mkdir(resolve(options.outDir), { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(options.outDir)), manifestPath = join(root, 'manifest.json');
  const manifest = { schemaVersion: 1, kind: KIND, outputDirectory: root };
  if (!await present(manifestPath)) assert.equal((await readdir(root)).length, 0, 'Choose an empty --out-dir; unrelated files are never overwritten');
  await immutable(manifestPath, manifest);
  const lock = join(root, '.running');
  try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Governance demo already running or interrupted; inspect .running before recovery'); throw error; }
  let store: QualEvoStore | undefined;
  const checkpoint = join(root, 'last-run.json');
  const recordAttempt = async (status: string, error?: unknown) => {
    if (await present(checkpoint)) await regular(checkpoint);
    await writeFile(checkpoint, encoded({ status, observedAt: new Date().toISOString(), ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }), { mode: 0o600 });
  };
  try {
    await recordAttempt('running');
    const source = join(root, 'source-loop'), artifacts = join(root, 'artifacts');
    for (const directory of [source, artifacts]) {
      if (await present(directory)) { const info = await lstat(directory); assert(info.isDirectory() && !info.isSymbolicLink(), 'Fixture directory cannot be a symlink'); }
      else await mkdir(directory, { mode: 0o700 });
    }
    await runLocalClosedLoop({ outDir: source });
    store = await QualEvoStore.openPGlite(join(source, 'db'));
    const load = async (name: string) => JSON.parse(await readFile(join(source, 'artifacts', `${name}.json`), 'utf8'));
    const base = await store.getRuleVersion((await load('base-rule')).digest);
    const accepted = await store.getRuleVersion((await load('compatible-rule')).digest);
    const rejected = await store.getRuleVersion((await load('regressed-rule')).digest);
    assert.equal(base.rule.schemaVersion, 2); assert.equal(accepted.rule.schemaVersion, 2); assert.equal(rejected.rule.schemaVersion, 2);
    if (base.rule.schemaVersion !== 2 || accepted.rule.schemaVersion !== 2 || rejected.rule.schemaVersion !== 2) throw new Error('Expected semantic rules');
    assert.equal(accepted.rule.provenance.parentDigest, base.digest);
    assert.deepEqual(accepted.rule.provenance.sourceCases, base.rule.provenance.sourceCases);
    const acceptedDecision = await store.getRevisionDecision((await load('compatible-decision')).digest);
    const rejectedDecision = await store.getRevisionDecision((await load('regressed-decision')).digest);
    const reviewFixture = SemanticReviewSchema.parse(await load('compatible-fixture-review'));
    const snapshot = await store.getChangeSnapshot(reviewFixture.snapshotDigest);
    const selectionInput = { repository: snapshot.snapshot.repository.id, paths: ['src/positive.ts', 'src/negative.ts'] };
    const initial = await store.getSemanticGovernance(base.rule.ruleId);
    if (initial.sequence === 0) assert.equal((await store.selectLocalSemanticRules(selectionInput)).selected.length, 0, 'Accept must not automatically select a rule');
    let previous: string | null = null;
    const apply = async (name: string, rule: typeof base, action: string, extra: Record<string, unknown> = {}) => {
      assert.equal(rule.rule.schemaVersion, 2);
      if (rule.rule.schemaVersion !== 2) throw new Error('Expected semantic rule');
      const command = SemanticGovernanceCommandSchema.parse({ id: `${KIND}-${name}`, namespace: 'local-semantic-review',
        action, ruleDigest: rule.digest, scopeDigest: digestOf(rule.rule.scope), expectedHeadDigest: previous,
        actor: 'authored-developer-scenario', source: 'fixture', reason: 'Explicit authored scenario; no authenticated human approval or production activation.', createdAt: DATE, ...extra });
      const event = await store!.applySemanticGovernance(command); previous = event.digest;
      await immutable(join(artifacts, `${name}.json`), event); return event;
    };
    await apply('register-root', base, 'register');
    await apply('bootstrap-root', base, 'bootstrap-shadow');
    const planInput = { ...selectionInput, snapshotDigest: snapshot.digest, workspaceId: KIND };
    const oldPlan = await store.createGovernedReviewPlan({ ...planInput, id: `${KIND}-root-plan` });
    assert.equal(oldPlan.plan.selection.selected[0]?.ruleDigest, base.digest);
    await immutable(join(artifacts, 'root-plan.json'), oldPlan);
    await apply('register-accepted', accepted, 'register');
    await apply('register-rejected', rejected, 'register');
    await apply('supersede-root', base, 'supersede', { successor: { ruleDigest: accepted.digest, scopeDigest: digestOf(accepted.rule.scope) }, decisionDigest: acceptedDecision.digest });
    const head = (await store.getSemanticGovernance(base.rule.ruleId)).headDigest;
    await assert.rejects(store.applySemanticGovernance({ id: `${KIND}-reject-selection`, namespace: 'local-semantic-review', action: 'select-shadow',
      ruleDigest: rejected.digest, scopeDigest: digestOf(rejected.rule.scope), expectedHeadDigest: head, decisionDigest: rejectedDecision.digest,
      actor: 'authored-developer-scenario', source: 'fixture', reason: 'Rejected revision must not be selected.', createdAt: DATE }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'GOVERNANCE_SELECTION_BLOCKED');
    const currentPlan = await store.createGovernedReviewPlan({ ...planInput, id: `${KIND}-successor-plan` });
    assert.equal(currentPlan.plan.selection.selected.length, 1);
    assert.equal(currentPlan.plan.selection.selected[0]?.ruleDigest, accepted.digest);
    await immutable(join(artifacts, 'successor-plan.json'), currentPlan);

    // Fixed response is derived solely from the existing authored compatible fixture.
    const fixtures = reviewFixture.fixtures;
    assert(fixtures?.schemaVersion === 1);
    const response = PerAnchorSemanticReviewModelResponseSchema.parse({ ruleDigest: accepted.digest, snapshotDigest: snapshot.digest,
      evidence: fixtures.evidence, judgments: fixtures.judgments.map(j => ({ targetId: j.targetId, decision: j.decision,
        reasoning: j.reasoning, evidenceRefs: j.evidenceRefs, missingContext: [], anchorJudgments: (j.findingAnchors ?? []).map(anchor => ({
          anchor, decision: j.decision, reasoning: j.reasoning, evidenceRefs: j.evidenceRefs, missingContext: [] })) })) });
    const runtimeDir = join(root, 'runtime');
    if (await present(runtimeDir)) { const info = await lstat(runtimeDir); assert(info.isDirectory() && !info.isSymbolicLink()); }
    else await mkdir(runtimeDir, { mode: 0o700 });
    const executable = join(runtimeDir, 'authored-cli.cjs'), requestPath = join(runtimeDir, 'worker-request.json');
    const code = `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));send({type:'thread.started',thread_id:'authored-governance-review'});send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(response)})}});send({type:'turn.completed',usage:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0}});});\n`;
    if (await present(executable)) { await regular(executable); assert.equal(await readFile(executable, 'utf8'), code); }
    else await writeFile(executable, code, { flag: 'wx', mode: 0o700 });
    const limits = { maxInputBytes: 262144, maxOutputBytes: 131072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 10000, cleanupTimeoutMs: 3000 };
    let calls = 0, resolved = 0;
    const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(request, record) {
      assert.equal(request.outputContract, 'semantic-review-v2');
      assert.equal(request.toolPolicy, 'full-repo-shell-v1');
      let stopped = true;
      return { async prepare() {
        const headSha = (await workspaceGit(record.worktreePath, 'rev-parse', 'HEAD')).trim();
        const clean = !(await workspaceGit(record.worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).trim();
        return { expectedSha: request.expectedSha, headSha, clean, identityValid: headSha === request.expectedSha, historyPolicy: 'all-local-refs-v1' };
      }, async execute(signal) {
        calls++; stopped = false;
        await writeFile(join(runtimeDir, 'execution.json'), encoded({ contract: request.outputContract, ruleDigest: accepted.digest }), { flag: 'wx', mode: 0o600 });
        await writeFile(requestPath, encoded({ workingDirectory: record.worktreePath, model: request.model, prompt: request.prompt,
          outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits }), { flag: 'wx', mode: 0o600 });
        const result = JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: root,
          workingDirectory: record.worktreePath, requestPath, codexPathOverride: executable, imageConfig: { schemaVersion: 1,
            gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://fixture.invalid/v1', allowedHost: 'fixture.invalid' } } }, signal));
        stopped = result.processEvidence?.processGroupStopped === true;
        return result;
      }, async stop() { return { stopped, verified: stopped }; }, async collect() { return []; },
      async destroy() { return { destroyed: stopped, verified: stopped }; } };
    } };
    const [currentJob] = governedReviewJobs(currentPlan);
    assert(currentJob);
    const workspace = { repoPath: join(source, 'repository'), runId: KIND, attemptId: applicationJobDigest(currentJob).slice(0, 24) };
    const dependencies: ApplicationDispatcherDependencies = { store, config: { enabled: true, model: 'authored-fixture', limits: { maxInputBytes: 262144, maxOutputBytes: 131072, timeoutMs: 10000 } },
      runtime: { id: KIND, backend, limits }, resolveWorkspace: async selection => {
        resolved++; assert.equal(selection.jobDigest, applicationJobDigest(currentJob));
        await prepareWorkspace({ ...workspace, baseSha: selection.expectedSha }); return workspace;
      } };
    const oldStatus = await runGovernedReviewPlan(dependencies, oldPlan.digest, new AbortController().signal);
    assert.equal(oldStatus.currentGovernance, 'stale-plan');
    assert.equal(oldStatus.jobs[0]?.result?.reason, 'stale_governance_plan');
    assert.equal(oldStatus.jobs[0]?.admission, null);
    assert.equal(resolved, 0); assert.equal(calls, 0);
    const status = await runGovernedReviewPlan(dependencies, currentPlan.digest, new AbortController().signal);
    const record = await store.getApplicationJob(applicationJobDigest(currentJob));
    assert.equal(record?.result?.status, 'completed');
    assert(record?.result?.status === 'completed' && record.result.outcome?.kind === 'semantic-review');
    const review = await store.getSemanticReview(record.result.outcome.id);
    assert.equal(review.ruleDigest, accepted.digest);
    assert.equal(review.executionReceipt?.execution, 'completed');
    assert.equal(review.executionReceipt?.modelExecution, 'not_run');
    assert.equal(status.jobs[0]?.admission?.planDigest, currentPlan.digest);
    assert.equal(status.jobs[0]?.admission?.selectionDigest, currentPlan.plan.selectionDigest);
    for (const finding of review.findings) assert.equal((await store.getReviewFinding(finding.id)).verdict, 'Unknown');
    const feedback = await Promise.all(['positive-feedback', 'negative-feedback'].map(load));
    for (const item of feedback) {
      assert.equal(item.source, 'fixture'); assert.equal(item.ruleDigest, base.digest);
      assert.equal((await store.getReviewFinding(item.findingId)).verdict, 'Unknown');
    }
    assert.equal(await store.getActive(base.rule.ruleId), null);
    // Completed jobs bypass the resolver on replay. Finalize their persisted workspace too.
    assert.equal(record.result.cleanup, 'verified');
    assert.equal(review.snapshotDigest, snapshot.digest);
    assert.equal(review.executionReceipt.cleanup, 'verified');
    assert.equal(review.executionReceipt.ruleDigest, accepted.digest);
    assert.equal(review.executionReceipt.snapshotDigest, snapshot.digest);
    assert.equal(review.executionReceipt.expectedSha, snapshot.snapshot.head);
    assert.deepEqual(review.executionReceipt.context.workspace, workspace);
    const finalized = await cleanupWorkspace(review.executionReceipt.context.workspace);
    assert.equal(finalized.record.status, 'closed-clean');
    assert.equal(finalized.observation.branchHeadSha, snapshot.snapshot.head, 'Retained workspace branch SHA changed');
    const history = await store.getSemanticGovernanceHistory(base.rule.ruleId);
    assert.equal(history.length, 5);
    await immutable(join(artifacts, 'governed-review.json'), review);
    await immutable(join(artifacts, 'current-status.json'), status);
    await immutable(join(artifacts, 'stale-status.json'), oldStatus);
    await immutable(join(artifacts, 'feedback-attribution.json'), feedback);
    await store.close(); store = undefined;
    store = await QualEvoStore.openPGlite(join(source, 'db'));
    assert.deepEqual(await store.getSemanticReview(review.id), review);
    assert.deepEqual(await store.getSemanticGovernanceHistory(base.rule.ruleId), history);
    assert.deepEqual(await governedReviewStatus(store, currentPlan.digest), status);
    assert.equal(await store.getActive(base.rule.ruleId), null);
    const report = { schemaVersion: 1, kind: KIND, status: 'succeeded', modelExecution: 'not_run', humanVerdicts: 'Unknown',
      productionActivation: 'not_performed', notification: 'not_performed', isolation: 'not_verified',
      database: join(source, 'db'), sourceReport: join(source, 'report.json'), artifactsDirectory: artifacts,
      rootRuleDigest: base.digest, successorRuleDigest: accepted.digest, rejectedRuleDigest: rejected.digest,
      governanceEvents: history.length, rootPlanDigest: oldPlan.digest, successorPlanDigest: currentPlan.digest,
      nextReview: { id: review.id, ruleDigest: review.ruleDigest, execution: review.executionReceipt.execution,
        modelExecution: review.executionReceipt.modelExecution, admission: status.jobs[0]!.admission },
      checks: { rejectionBlocked: true, stalePlanBlockedBeforeAdmission: true, acceptedDecisionDoesNotAutoSelect: true,
        immutableSourceProvenance: true, reopenedIdentically: true, fixtureFeedbackCount: feedback.length },
      limitations: ['Authored developer scenario, not authenticated developer feedback or scientific effectiveness.',
        'One explicit local-shadow successor; historical digest-pinned reviews remain readable.',
        'Real PGlite and SDK authored executable; no provider, live runtime, external publication or production activation.'] };
    await immutable(join(root, 'report.json'), report);
    await store.close(); store = undefined;
    await recordAttempt('succeeded');
    return report;
  } catch (error) {
    try { await recordAttempt('failed', error); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { try { if (store) await store.close(); } finally { await rm(lock, { recursive: true, force: true }); } }
}

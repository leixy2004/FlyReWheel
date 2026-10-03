import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { QualEvoStore } from './storage/store.js';
import { captureChangeSnapshot, SnapshotReceiptSchema, type StoredChangeSnapshot } from './change-snapshot.js';
import { validateGithubPrEvidence } from './github-pr-evidence.js';
import { createPrMiningModelAdapter } from './adapters/pr-mining-model.js';
import { makeReviewEvidence, makeSnapshotAnchor } from './adapters/semantic-review-fixture.js';
import { type ReviewFixture, type StoredRevisionRequest } from './core/semantic-review.js';
import { SemanticRuleVersionSchema, type StoredRuleVersion } from './core/semantic-rule.js';
import { digestOf } from './core/identity.js';
import type { StoredRevisionCandidate } from './core/revision-generation.js';
import { RevisionModelResponseSchema } from './core/revision-model.js';
import { prepareWorkspace, cleanupWorkspace } from './workspace/index.js';
import { workspaceEnvironment, workspaceGit } from './workspace/process.js';
import { type CodexWorkspaceBackend } from './workspace/codex-runner.js';
import { runWorkspaceWorkerCommand } from './workspace-worker-entrypoint.js';
import { generateRuleRevision } from './rule-revision.js';

const exec = promisify(execFile);
const DATE = '2026-10-02T00:00:00Z';
const REPOSITORY = 'github:flyrewheel-fixture/local-closed-loop';
const FIXTURE = 'local-closed-loop-fixture-v1';
const RULE = 'local-closed-loop-guard-policy';
const POLICY = '// Authored fixture policy: protected reads require isAuthorized().\n';
const historyBefore = POLICY + 'export function historical() { return dangerousRead(); }\n';
const historyAfter = POLICY + 'export function historical() { if (isAuthorized()) return dangerousRead(); return null; }\n';
const targets = [
  { name: 'positive', path: 'src/positive.ts', source: POLICY + 'export function positive() { return dangerousRead(); }\n', label: 'TP' as const },
  { name: 'negative', path: 'src/negative.ts', source: POLICY + 'export function negative() { if (isAuthorized()) return dangerousRead(); return null; }\n', label: 'FP' as const },
];
const limits = { maxInputBytes: 262144, maxOutputBytes: 131072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 10000, cleanupTimeoutMs: 3000 };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
const limitations = [
  'Fixture-only plumbing demonstration: proposals, semantic judgments, TP/FP expectations and local decisions are authored; no live model or developer feedback.',
  'The Git history is real but synthetic. GitHub metadata is authored in the evidence format, not acquired from GitHub; package integrity is not provider verification.',
  'Mining consumes only selected historical changed sides; source cases remain unknown. Later fixture feedback is anchor-scoped, not whole-file ground truth.',
  'The authored CLI runs through the installed Codex SDK with selected evidence and tools disabled; this is not sandbox isolation or a production backend.',
  'Comparisons cover two selected feedback anchors only. No regression cases are invented for unlabelled mined sources; these scenarios are not empirical efficacy or a heldout evaluation.',
  'Full local history is available to workspace infrastructure. No certified temporal isolation, repository-wide semantic correctness or notification eligibility is established.',
  'Local accept/reject never activates a rule. Immutable mining/revision requests remain pending and synthesis not_run; fixture feedback leaves human verdicts Unknown.',
];
const pendingProduction = [
  'Supply authorized real PR evidence, independently assessed feedback and a protected heldout evaluation.',
  'Explicitly configure and verify an isolated model runtime and credential gateway before any live inference.',
  'Review generated semantics and regression coverage; production promotion, scheduling and publication remain separate authorized operations.',
];
const Manifest = z.object({ schemaVersion: z.literal(1), kind: z.literal(FIXTURE), database: z.string().min(1) }).strict();
const History = z.object({ schemaVersion: z.literal(1), base: z.string().regex(/^[a-f0-9]{40}$/), historicalFix: z.string().regex(/^[a-f0-9]{40}$/), target: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
type Artifact = { path: string; sha256: string; byteLength: number; entity: string | null; identity: string | null };
type Check = { artifact: string; read: (store: QualEvoStore) => Promise<unknown> };
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function exists(path: string) { return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return false; }); }
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, encoded(value), { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

/** Creates only a dedicated synthetic repository; never executes its source code. */
async function createHistory(root: string) {
  const repo = join(root, 'repository'), historyPath = join(root, 'history.json');
  if (await exists(historyPath)) {
    const history = History.parse(JSON.parse(await readFile(historyPath, 'utf8')));
    assert.equal((await workspaceGit(repo, 'rev-parse', 'HEAD')).trim(), history.target, 'Fixture repository HEAD changed');
    assert.equal((await workspaceGit(repo, 'status', '--porcelain=v1', '--untracked-files=all')).trim(), '', 'Fixture repository has local changes');
    assert.equal((await workspaceGit(repo, 'rev-parse', `${history.target}^`)).trim(), history.historicalFix);
    assert.equal((await workspaceGit(repo, 'rev-parse', `${history.historicalFix}^`)).trim(), history.base);
    assert.equal(await workspaceGit(repo, 'show', `${history.base}:src/history.ts`), historyBefore);
    assert.equal(await workspaceGit(repo, 'show', `${history.historicalFix}:src/history.ts`), historyAfter);
    for (const target of targets) assert.equal(await workspaceGit(repo, 'show', `${history.target}:${target.path}`), target.source);
    return { repo, history };
  }
  if (await exists(repo)) throw new Error('Incomplete fixture repository retained. Inspect it and choose a fresh --out-dir; no automatic deletion or reset is performed');
  await mkdir(join(repo, 'src'), { recursive: true });
  const git = async (...args: string[]) => (await workspaceGit(repo, ...args)).trim();
  await git('init', '--initial-branch=main', '--object-format=sha1');
  await git('config', 'user.name', 'Authored FlyReWheel Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  const commit = async (message: string) => {
    await git('add', '.');
    await exec('git', ['commit', '-m', message], { cwd: repo, env: { ...workspaceEnvironment(), GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE }, timeout: 30000, maxBuffer: 1_000_000 });
    return git('rev-parse', 'HEAD');
  };
  await writeFile(join(repo, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(repo, 'src/history.ts'), historyBefore);
  const base = await commit('fixture: historical unguarded read');
  await writeFile(join(repo, 'src/history.ts'), historyAfter);
  const historicalFix = await commit('fixture: historical guarded read');
  for (const target of targets) await writeFile(join(repo, target.path), target.source);
  const target = await commit('fixture: later positive and guarded negative review targets');
  const history = { schemaVersion: 1 as const, base, historicalFix, target };
  await atomicJson(historyPath, history);
  return { repo, history };
}

function historicalEvidence(snapshot: StoredChangeSnapshot) {
  const repository = REPOSITORY.slice('github:'.length), url = `https://github.com/${repository}/pull/1`;
  return validateGithubPrEvidence({ schemaVersion: 1, kind: 'github-pr-evidence', snapshotDigest: snapshot.digest, snapshot: snapshot.snapshot,
    pull: { id: 1, number: 1, repository, url, title: 'Authored fixture: historical guard change', body: 'Synthetic local history only; no GitHub request or developer review occurred.', author: null,
      state: 'closed', draft: false, merged: true, createdAt: DATE, updatedAt: DATE, closedAt: DATE, mergedAt: DATE, baseRef: 'main', baseTip: snapshot.snapshot.baseTip,
      headRef: 'fixture-history', head: snapshot.snapshot.head, headRepository: repository, mergeCommit: snapshot.snapshot.head, reportedChangedFiles: 1, reportedIssueComments: 0, reportedReviewComments: 0 },
    source: { provider: 'github', apiOrigin: 'https://api.github.com', observation: 'current-api-state', historicalReviewCheckpoint: false,
      ancestry: 'provider-declared', inventory: 'provider-declared-compare', repositoryContext: 'changed-paths-only', discussionConsistency: 'non-atomic-current-observation',
      discussionCoverage: 'all-pages-returned-within-limits', compareFileCount: 1, sourceStatements: 'untrusted-not-ground-truth-or-feedback' },
    discussions: { issueComments: [], reviews: [], reviewComments: [] } });
}

async function fixtureReview(store: QualEvoStore, rule: StoredRuleVersion, snapshot: StoredChangeSnapshot, positive: 'safe' | 'violation', negative: 'safe' | 'violation') {
  const structural = await store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest });
  assert.equal(structural.occurrences.length, 2, 'Both targets must actually be detected by ast-grep');
  assert.ok(structural.coverage.targets.every(target => target.scans.every(scan => !['execution_error', 'budget_exceeded'].includes(scan.state))));
  const evidence = targets.map(target => makeReviewEvidence(snapshot, makeSnapshotAnchor(snapshot, 'after', target.path, 0, POLICY.length - 1), 'local-policy'));
  const fixtures: ReviewFixture = { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence,
    judgments: targets.map((target, i) => {
      const decision = i === 0 ? positive : negative;
      const start = target.source.indexOf('dangerousRead()');
      return { targetId: structural.coverage.targets.find(item => item.path === target.path)!.id, decision,
        reasoning: `Authored fixture ${decision}; not a model result or independent assessment.`, evidenceRefs: [evidence[i].id],
        findingAnchors: [makeSnapshotAnchor(snapshot, 'after', target.path, start, start + 'dangerousRead()'.length)] };
    }) };
  return { structural, review: await store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest, fixtures }) };
}

/** Fixed authored executable reused from the compiled revision smoke approach.
 * No caller executable/model endpoint, ambient authentication or live fallback. */
async function authoredRuntime(root: string, response: unknown, name: string) {
  const directory = join(root, 'runtime', `${name}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, 'authored-cli.cjs'), requestPath = join(directory, 'worker-request.json');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));send({type:'thread.started',thread_id:'closed-loop-authored-${name}'});send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(response)})}});send({type:'turn.completed',usage:${JSON.stringify(usage)}});});\n`, { mode: 0o700, flag: 'wx' });
  let stopped = true;
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(request, record) {
    assert.equal(request.outputContract, 'rule-revision-v2'); assert.equal(request.toolPolicy, 'selected-evidence-no-tools-v1');
    return { async prepare() {
      const head = (await workspaceGit(record.worktreePath, 'rev-parse', 'HEAD')).trim();
      const clean = !(await workspaceGit(record.worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).trim();
      return { expectedSha: request.expectedSha, headSha: head, clean, identityValid: head === request.expectedSha, historyPolicy: 'all-local-refs-v1' };
    }, async execute(signal) {
      stopped = false;
      await atomicJson(requestPath, { workingDirectory: record.worktreePath, model: request.model, prompt: request.prompt,
        outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits });
      // Worker supervision verifies subprocess termination before returning a result.
      const result = JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: root,
        workingDirectory: record.worktreePath, requestPath, codexPathOverride: executable, imageConfig: { schemaVersion: 1,
          gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } } }, signal));
      stopped = result.processEvidence?.processGroupStopped === true;
      return result;
    }, async stop() { return { stopped, verified: stopped }; }, async collect() { return []; },
    async destroy() { return { destroyed: stopped, verified: stopped }; } };
  } };
  return { id: 'closed-loop-authored-sdk', backend, limits };
}

/** Local-only orchestration of existing evidence, review, generation and comparison APIs.
 * It is intentionally not a production backend or a replacement state machine. */
export async function runLocalClosedLoop(options: { outDir: string; db?: string }) {
  await mkdir(resolve(options.outDir), { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(options.outDir)), manifestPath = join(root, 'manifest.json'), reportPath = join(root, 'report.json');
  const database = resolve(options.db ?? join(root, 'db'));
  if (database === root || root.startsWith(database + '/') || (database.startsWith(root + '/') && database !== join(root, 'db'))) throw new Error('Use <out-dir>/db or a separate, non-overlapping database directory');
  const manifest = { schemaVersion: 1 as const, kind: FIXTURE, database };
  if (await exists(manifestPath)) assert.deepEqual(Manifest.parse(JSON.parse(await readFile(manifestPath, 'utf8'))), manifest, 'Output directory belongs to a different demo/database');
  else {
    if ((await readdir(root)).length) throw new Error('Choose an empty --out-dir; unrelated files are never overwritten');
    await writeFile(manifestPath, encoded(manifest), { mode: 0o600, flag: 'wx' });
  }
  const lock = join(root, '.running');
  try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This output directory is already running or has an interrupted lock; inspect .running before manual recovery'); throw error; }
  let store: QualEvoStore | undefined, stage = 'initializing';
  const artifacts: Artifact[] = [], checks: Check[] = [];
  const summary: Record<string, unknown> = { schemaVersion: 1, kind: 'local-closed-loop-report', mode: 'authored-fixture-only', modelExecution: 'not_run',
    isolation: 'not_verified', paths: { outputDirectory: root, database, report: reportPath }, limitations, pendingProduction };
  const checkpoint = async (status: 'running' | 'succeeded' | 'failed', error?: string) => atomicJson(reportPath, { ...summary, status, stage, artifacts, ...(error ? { error } : {}) });
  const save = async (name: string, value: unknown, entity?: string, identity?: string, reader?: Check['read']) => {
    const path = `artifacts/${name}.json`, bytes = encoded(value), file = join(root, path);
    if (await exists(file)) {
      const info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink(), 'Artifact must be a regular file');
      assert.equal(hash(await readFile(file)), hash(bytes), `Immutable artifact differs: ${path}`);
    } else await atomicJson(file, value);
    artifacts.push({ path, sha256: hash(bytes), byteLength: Buffer.byteLength(bytes), entity: entity ?? null, identity: identity ?? null });
    if (reader) checks.push({ artifact: path, read: reader });
    return value;
  };
  try {
    await checkpoint('running');
    await mkdir(join(root, 'artifacts'), { recursive: true });
    stage = 'synthetic-git-history'; await checkpoint('running');
    const { repo, history } = await createHistory(root);
    summary.history = { ...history, repository: REPOSITORY, repositoryPath: repo, provenance: 'real-git-synthetic-content', miningInput: 'historical-base-to-fix', reviewInput: 'historical-fix-to-later-target' };
    await mkdir(dirname(database), { recursive: true });
    store = await QualEvoStore.openPGlite(database);
    const saveReceipt = async (name: string, receipt: unknown) => {
      const path = join(root, 'artifacts', `${name}.json`);
      if (await exists(path)) {
        const previous = SnapshotReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        const current = SnapshotReceiptSchema.parse(receipt);
        assert.ok(previous.kind === 'local-git-check' && current.kind === 'local-git-check');
        assert.deepEqual({ ...previous, checkedAt: undefined }, { ...current, checkedAt: undefined }, 'Capture receipt source changed');
        // Keep the original acquisition time; capture above freshly revalidated the exact bytes.
        return save(name, previous);
      }
      return save(name, receipt);
    };
    stage = 'historical-pr-evidence'; await checkpoint('running');
    const historical = await captureChangeSnapshot({ repositoryPath: repo, repositoryId: REPOSITORY, baseTip: history.base, head: history.historicalFix,
      prMetadata: { verification: 'caller-supplied-unverified', provider: 'github', repository: REPOSITORY.slice('github:'.length), number: 1, url: `https://github.com/${REPOSITORY.slice('github:'.length)}/pull/1` } });
    const historicSnapshot = await store.importChangeSnapshot(historical.snapshot);
    await save('historical-snapshot', historicSnapshot, 'snapshot', historicSnapshot.digest, db => db.getChangeSnapshot(historicSnapshot.digest));
    await saveReceipt('historical-capture-receipt', historical.receipt);
    const evidence = await store.importGithubPrEvidence(historicalEvidence(historicSnapshot).evidence);
    await save('historical-pr-evidence', evidence, 'github-pr-evidence', evidence.digest, db => db.getGithubPrEvidence(evidence.digest));
    const request = await store.createPrMiningRequest({ id: `${FIXTURE}-mining-request`, evidenceDigest: evidence.digest,
      sources: [{ side: 'before', path: 'src/history.ts' }, { side: 'after', path: 'src/history.ts' }], statements: [{ kind: 'pull' }],
      requestedRule: { ruleId: RULE, version: 'mined-fixture-base', parentDigest: null }, objective: 'Authored fixture: investigate a protected-read guard policy; retain unknown source labels.',
      actor: FIXTURE, source: 'fixture', createdAt: DATE });
    await save('mining-request', request, 'mining-request', request.digest, db => db.getPrMiningRequest(request.digest));
    stage = 'authored-mining-proposal'; await checkpoint('running');
    const proposal = { result: { status: 'candidate' as const,
      semantics: { title: 'Authored protected-read guard policy', mechanism: 'An unguarded protected read may violate the declared local policy.', invariant: 'Protected reads require an applicable guard.',
        applicability: ['Protected reads'], exceptions: [], requiredContext: ['local-policy'], expectedBehavior: 'Use policy evidence and preserve unknowns. The base fixture deliberately over-reports the guarded target.' },
      paths: { include: ['src'], exclude: [] }, detectionAssets: [{ id: 'protected-read', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'dangerousRead()' } }],
      rationale: 'Authored proposal demonstrating adapter validation and exact historical provenance; not a discovered or verified rule.',
      evidenceRefs: request.request.sourceBindings.map(source => `case:${source.caseId}`) } };
    const adapter = createPrMiningModelAdapter({ enabled: true, model: 'authored-fixture-no-model' }, {
      kind: 'authored-test', id: FIXTURE, async generate(input) {
        assert.ok(!input.prompt.includes('export function positive()') && !input.prompt.includes('export function negative()'), 'Future target bytes entered historical mining');
        return JSON.stringify(proposal);
      } });
    const generated = await adapter.generate({ request, evidence, candidateId: `${FIXTURE}-mined-candidate`, candidateCreatedAt: DATE, context: { kind: 'selected-evidence' } });
    assert.ok(generated.execution === 'succeeded' && generated.status === 'candidate_requires_review', `Authored mining did not produce a reviewable candidate: ${JSON.stringify(generated)}`);
    await save('authored-mining-response', generated);
    const mined = await store.importPrMiningCandidate(generated.candidateInput);
    await save('mined-candidate', mined, 'mining-candidate', mined.digest, db => db.getPrMiningCandidate(mined.digest));
    const baseRule = await store.getRuleVersion(mined.candidate.ruleDigest);
    const base = SemanticRuleVersionSchema.parse(baseRule.rule);
    await save('base-rule', baseRule, 'rule', baseRule.digest, db => db.getRuleVersion(baseRule.digest));
    for (const source of request.request.sourceBindings) {
      const item = await store.getProblemCase(source.caseId); assert.equal(item.expected, 'unknown');
      await save(`mining-source-${source.side}`, item, 'problem-case', item.id, db => db.getProblemCase(item.id));
    }
    stage = 'future-target-review'; await checkpoint('running');
    const captured = await captureChangeSnapshot({ repositoryPath: repo, repositoryId: REPOSITORY, baseTip: history.historicalFix, head: history.target });
    const snapshot = await store.importChangeSnapshot(captured.snapshot);
    await save('target-snapshot', snapshot, 'snapshot', snapshot.digest, db => db.getChangeSnapshot(snapshot.digest));
    await saveReceipt('target-capture-receipt', captured.receipt);
    const baseline = await fixtureReview(store, baseRule, snapshot, 'violation', 'violation');
    await save('base-structural-review', baseline.structural, 'review', baseline.structural.id, db => db.getSemanticReview(baseline.structural.id));
    await save('base-fixture-review', baseline.review, 'review', baseline.review.id, db => db.getSemanticReview(baseline.review.id));
    const feedback = [];
    for (const target of targets) {
      const finding = baseline.review.findings.find(item => item.anchor.path === target.path)!;
      assert.ok(finding, `Missing expected ${target.name} finding`);
      const item = await store.appendReviewFeedback({ id: `${FIXTURE}-${target.name}-feedback`, findingId: finding.id, reviewId: baseline.review.id,
        ruleDigest: baseRule.digest, ruleVersion: base.version, source: 'fixture', actor: FIXTURE, kind: 'label', label: target.label,
        reason: `Authored fixture ${target.label} expectation at this exact anchor only; no developer feedback or whole-file label.`, createdAt: DATE });
      feedback.push(item);
      await save(`${target.name}-feedback`, item, 'feedback', item.id, async db => (await db.getReviewFinding(item.findingId)).feedback.find(value => value.id === item.id));
    }
    const outcomes = [];
    for (const scenario of ['compatible', 'regressed'] as const) {
      stage = `${scenario}-revision-generation`; await checkpoint('running');
      const revisionRequest: StoredRevisionRequest = await store.createRevisionRequest({ id: `${FIXTURE}-${scenario}-request`, baseRuleDigest: baseRule.digest,
        requestedRuleVersion: `generated-fixture-${scenario}`, feedbackIds: feedback.map(item => item.id),
        requestedChange: scenario === 'compatible' ? 'Fixture: recognize the guarded negative without losing the unguarded positive.' : 'Fixture regression scenario: deliberately overgeneralize the guard exception to demonstrate rejection.',
        actor: FIXTURE, source: 'fixture', createdAt: DATE });
      await save(`${scenario}-revision-request`, revisionRequest, 'revision-request', revisionRequest.digest, db => db.getRevisionRequest(revisionRequest.digest));
      const response = RevisionModelResponseSchema.parse({ policyVersion: 'diagnosis-operators-v1', requestDigest: revisionRequest.digest, baseRuleDigest: baseRule.digest, requestedRuleVersion: revisionRequest.request.requestedRuleVersion,
        result: { ...proposal.result, operator: 'boundary_update', replacement: null, semantics: { ...base.semantics, exceptions: scenario === 'compatible' ? ['An applicable isAuthorized() guard protects the read.'] : ['Deliberately overbroad authored exception: all protected reads.'] },
          rationale: `Authored ${scenario} proposal only; local review and comparison remain required.`,
          evidenceRefs: [`rule:${baseRule.digest}`, ...feedback.flatMap(item => [`feedback:${item.id}`, `finding:${item.findingId}`])],
          diagnoses: feedback.map(item => ({ feedbackId: item.id, category: 'boundary', reasoning: 'Authored guard-boundary proposal, not established fact.', missingEvidence: [],
            evidenceRefs: [`feedback:${item.id}`, `finding:${item.findingId}`], claim: 'proposal-not-established-fact' })) } });
      await save(`${scenario}-authored-revision-response`, response);
      const candidateId = `${FIXTURE}-${scenario}-candidate`;
      let candidate: StoredRevisionCandidate | undefined = (await store.listRevisionCandidates(revisionRequest.digest)).find(item => item.candidate.id === candidateId);
      if (!candidate) {
        const workspace = { repoPath: repo, runId: `closed-loop-${scenario}`, attemptId: `try-${randomUUID().replaceAll('-', '')}` };
        await prepareWorkspace({ ...workspace, baseSha: history.target });
        const outcome = await generateRuleRevision(store, { requestDigest: revisionRequest.digest, candidateId, candidateCreatedAt: DATE,
          context: { kind: 'selected-evidence-no-tools', workspace, snapshotDigest: snapshot.digest } }, { enabled: true, model: 'authored-fixture-no-model' }, await authoredRuntime(root, response, scenario));
        // Keep failed workspaces/receipts for inspection. Never claim success or erase failure evidence.
        if (outcome.execution !== 'succeeded') await save(`${scenario}-generation-failure-${workspace.attemptId}`, outcome);
        assert.ok(outcome.execution === 'succeeded' && outcome.status === 'candidate_requires_review' && 'saved' in outcome,
          `Revision generation failed; inspect the report artifacts for ${scenario}`);
        candidate = outcome.saved;
      }
      assert.deepEqual(candidate.candidate.executionReceipt.workerResult.value, response, 'Saved candidate differs from the fixed authored response');
      const cleanup = await cleanupWorkspace(candidate.candidate.executionReceipt.context.workspace);
      assert.equal(cleanup.record.status, 'closed-clean', 'Authored fixture worktree was not cleaned');
      assert.equal(candidate.candidate.source, 'fixture'); assert.equal(candidate.candidate.synthesis, 'not_run');
      await save(`${scenario}-revision-candidate`, candidate, 'revision-candidate', candidate.digest, db => db.getRevisionCandidate(candidate!.digest));
      const rule = await store.getRuleVersion(candidate.candidate.ruleDigest);
      assert.equal(rule.rule.provenance.parentDigest, baseRule.digest);
      assert.deepEqual(SemanticRuleVersionSchema.parse(rule.rule).provenance.sourceCases, base.provenance.sourceCases);
      assert.deepEqual(rule.rule.regressionCases, base.regressionCases);
      await save(`${scenario}-rule`, rule, 'rule', rule.digest, db => db.getRuleVersion(rule.digest));
      stage = `${scenario}-comparison-and-decision`; await checkpoint('running');
      const revised = await fixtureReview(store, rule, snapshot, scenario === 'compatible' ? 'violation' : 'safe', 'safe');
      await save(`${scenario}-structural-review`, revised.structural, 'review', revised.structural.id, db => db.getSemanticReview(revised.structural.id));
      await save(`${scenario}-fixture-review`, revised.review, 'review', revised.review.id, db => db.getSemanticReview(revised.review.id));
      const comparison = await store.createRevisionComparison({ id: `${FIXTURE}-${scenario}-comparison`, requestDigest: revisionRequest.digest, candidateRuleDigest: rule.digest,
        reviewPairs: [{ baseReviewId: baseline.review.id, candidateReviewId: revised.review.id }], caseBindings: [] });
      assert.equal(comparison.comparison.summary.status, scenario);
      assert.equal(comparison.comparison.summary.corrected, 1);
      assert.equal(scenario === 'compatible' ? comparison.comparison.summary.preserved : comparison.comparison.summary.regressed, 1);
      await save(`${scenario}-comparison`, comparison, 'comparison', comparison.digest, db => db.getRevisionComparison(comparison.digest));
      if (scenario === 'regressed') await assert.rejects(store.recordRevisionDecision({ id: `${FIXTURE}-blocked-accept`, comparisonDigest: comparison.digest, choice: 'accept', actor: FIXTURE,
        source: 'fixture', reason: 'Authored negative test: regression must block acceptance.', createdAt: DATE }), (error: unknown) => (error as { code: string }).code === 'REVISION_ACCEPT_BLOCKED');
      const decision = await store.recordRevisionDecision({ id: `${FIXTURE}-${scenario}-decision`, comparisonDigest: comparison.digest,
        choice: scenario === 'compatible' ? 'accept' : 'reject', actor: FIXTURE, source: 'fixture', reason: `Authored fixture-only ${scenario} decision; no activation or human approval.`, createdAt: DATE });
      await save(`${scenario}-decision`, decision, 'decision', decision.digest, db => db.getRevisionDecision(decision.digest));
      outcomes.push({ scenario, requestDigest: revisionRequest.digest, candidateDigest: candidate.digest, ruleDigest: rule.digest, reviewId: revised.review.id,
        comparisonDigest: comparison.digest, summary: comparison.comparison.summary, decisionDigest: decision.digest, localDecision: decision.decision.choice,
        acceptance: scenario === 'regressed' ? 'blocked-as-expected' : 'fixture-only', activation: decision.decision.activation });
    }
    for (const item of feedback) {
      const finding = await store.getReviewFinding(item.findingId); assert.equal(finding.verdict, 'Unknown');
      await save(`${item.label === 'TP' ? 'positive' : 'negative'}-finding`, finding, 'finding', item.findingId, db => db.getReviewFinding(item.findingId));
    }
    assert.equal(await store.getActive(RULE), null);
    summary.evidence = { historicalSnapshotDigest: historicSnapshot.digest, prEvidenceDigest: evidence.digest, miningRequestDigest: request.digest,
      minedCandidateDigest: mined.digest, baseRuleDigest: baseRule.digest, targetSnapshotDigest: snapshot.digest, baseReviewId: baseline.review.id };
    summary.outcomes = outcomes;
    stage = 'reopen-and-verify'; await checkpoint('running');
    await store.close(); store = undefined;
    store = await QualEvoStore.openPGlite(database);
    for (const check of checks) assert.equal(digestOf(await check.read(store)), digestOf(JSON.parse(await readFile(join(root, check.artifact), 'utf8'))), `Reopened record differs: ${check.artifact}`);
    assert.equal(await store.getActive(RULE), null);
    await store.close(); store = undefined;
    summary.checks = { realAstGrepTargets: 2, historicalSourceLabels: 'unknown-only', futureBytesExcludedFromMiningPrompt: true,
      positivePreserved: true, negativeCorrected: true, regressionAcceptanceBlocked: true, humanVerdicts: 'Unknown', activation: 'not_performed',
      reopenedIdentically: true, reopenedRecords: checks.length, rerunPolicy: 'reuse-and-revalidate-immutable-records', fullModelRun: 'not_run' };
    stage = 'complete'; await checkpoint('succeeded');
    return JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    await checkpoint('failed', error instanceof Error ? error.message : 'Closed-loop fixture failed');
    throw new Error(`Local closed-loop failed at ${stage}; inspect ${reportPath}. ${error instanceof Error ? error.message : ''}`);
  } finally {
    try { if (store) await store.close(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
}

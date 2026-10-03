import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestOf, ruleVersionDigest } from '../src/core/identity.js';
import { captureChangeSnapshot, validateChangeSnapshot } from '../src/change-snapshot.js';
import { makeSnapshotAnchor, makeReviewEvidence } from '../src/adapters/semantic-review-fixture.js';
import { buildExecutedSemanticReview, buildSemanticReview, validateSemanticReview } from '../src/semantic-review.js';
import { SemanticReviewExecutionReceiptSchema } from '../src/core/semantic-review-execution.js';
import { buildSemanticReviewModelInput, createSemanticReviewWorkspaceModelAdapter, readTrustedSemanticReview, validateSemanticReviewExecution,
  type SemanticReviewModelInput, type SemanticReviewWorkspaceOutcome, type TrustedSemanticReview } from '../src/adapters/semantic-review-model.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { prepareWorkspace, cleanupWorkspace } from '../src/workspace/index.js';
import { workspaceGit } from '../src/workspace/process.js';
import type { CodexWorkspaceBackend, CodexWorkspaceRuntime } from '../src/workspace/codex-runner.js';
import type { PerAnchorSemanticReviewWorkspaceWorkerResult } from '../src/workspace/worker-protocol.js';
import { runWorkspaceWorkerCommand } from '../src/workspace-worker-entrypoint.js';
import { buildSemanticReviewWorkspaceRequest } from '../src/semantic-review-execution.js';
import { bytesDigest, workspaceRuntimeResultBinding } from '../src/workspace/execution-receipt.js';
import { capturedSide, readAsset, semanticInputs } from './helpers/semantic-review-fixture.js';

const config = { enabled: true, model: 'authored-executor-no-model' };
const limits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
let root: string, count = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'semantic-workspace-fixture-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
async function fixture(detector = true) {
  const directory = join(root, String(++count)), repoPath = join(directory, 'repo');
  await mkdir(join(repoPath, 'src'), { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Fixture'); await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  const before = '\ufeff// Policy: α\r\nfunction run() { return 0; }\r\n';
  const after = '\ufeff// Policy: α\r\nfunction run() { dangerousRead(); dangerousRead(); }\r\n';
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n'); await writeFile(join(repoPath, 'src/sample.ts'), before);
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored before');
  const base = await git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'src/sample.ts'), after); await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored after');
  const head = await git(repoPath, 'rev-parse', 'HEAD');
  const original = semanticInputs({ before, after, assets: detector ? [readAsset] : [] });
  const snapshot = await captureChangeSnapshot({ repositoryPath: repoPath, repositoryId: original.snapshot.snapshot.repository.id, baseTip: base, head });
  const problemCase = { ...original.problemCase, commit: base };
  const ruleInput = { ...original.rule.rule, provenance: { ...original.rule.rule.provenance,
    sourceCases: original.rule.rule.provenance.sourceCases.map(value => ({ ...value, commit: base })) } };
  const rule = { rule: ruleInput, digest: ruleVersionDigest(ruleInput) };
  const workspace = { repoPath, runId: 'review', attemptId: 'authored' };
  const prepared = await prepareWorkspace({ ...workspace, baseSha: head });
  const input: SemanticReviewModelInput = { rule, snapshot, context: { kind: 'full-repository', repository: snapshot.snapshot.repository.id, checkout: 'after', workspace }, attempt: 'authored' };
  const target = buildSemanticReview({ rule, snapshot }).coverage.targets[0];
  const start = after.indexOf('dangerousRead()');
  const anchor = makeSnapshotAnchor(snapshot, 'after', target.path, start, start + 'dangerousRead()'.length);
  const evidence = makeReviewEvidence(snapshot, makeSnapshotAnchor(snapshot, 'before', target.path, 0, before.length), 'local-policy');
  const value = { ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence: [evidence],
    judgments: [{ targetId: target.id, decision: 'violation' as const, reasoning: 'Authored exact-source fixture, no model or human correctness claim.', evidenceRefs: [evidence.id], missingContext: [] as string[],
      anchorJudgments: [{ anchor, decision: 'violation' as const, reasoning: 'Authored exact-source anchor fixture.', evidenceRefs: [evidence.id], missingContext: [] as string[] }] }] };
  const envelope: PerAnchorSemanticReviewWorkspaceWorkerResult = { protocolVersion: 2, outputContract: 'semantic-review-v2', value, usage, sessionId: 'authored-session',
    processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true }, boundary: 'authored-test-no-isolation' };
  const calls: string[] = [];
  const runtime: CodexWorkspaceRuntime = {
    async prepare() { calls.push('prepare'); return { expectedSha: head, headSha: head, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
    async execute() { calls.push('execute'); return envelope; },
    async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
    async collect() { calls.push('collect'); return [{ name: 'authored.txt', bytes: Buffer.from('authored fixture, no model') }]; },
    async destroy() { calls.push('destroy'); return { destroyed: true, verified: true }; },
  };
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(request) {
    expect(request).toMatchObject({ expectedSha: head, outputContract: 'semantic-review-v2' }); calls.push('reserve'); return runtime;
  } };
  const adapter = () => createSemanticReviewWorkspaceModelAdapter(config, { id: 'authored-review-runtime', backend, limits });
  return { directory, repoPath, before, after, base, head, rule, snapshot, problemCase, workspace, prepared, input, target, value, envelope, calls, runtime, backend, adapter };
}
function succeeded(outcome: SemanticReviewWorkspaceOutcome) {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ execution: 'succeeded', modelExecution: 'not_run', origin: 'authored-test' });
  if (outcome.execution !== 'succeeded') throw new Error('Missing review');
  return outcome;
}
async function seed(store: QualEvoStore, f: Awaited<ReturnType<typeof fixture>>) {
  await store.importRuleVersion(f.rule.rule, [f.problemCase]); await store.importChangeSnapshot(f.snapshot.snapshot);
}

async function useSdkFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const requestPath = join(f.directory, 'request.json'), executable = join(f.directory, 'authored-cli.cjs');
  f.backend.reserve = (request, workspace) => {
    expect(request).toMatchObject({ expectedSha: f.head, outputContract: 'semantic-review-v2' });
    f.runtime.execute = async signal => {
      await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));
        send({type:'thread.started',thread_id:'authored-sdk-session'});
        send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(f.envelope.value)})}});
        send({type:'turn.completed',usage:${JSON.stringify(usage)}});});\n`, { mode: 0o700 });
      await writeFile(requestPath, JSON.stringify({ workingDirectory: workspace.worktreePath, model: request.model, prompt: request.prompt,
        outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits }));
      return JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: f.directory,
        workingDirectory: workspace.worktreePath, requestPath, codexPathOverride: executable,
        imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } } }, signal));
    };
    return f.runtime;
  };
}

describe('semantic-v3 supervised workspace application (authored executors, no model/isolation)', () => {
  it('connects typed official SDK execution to exact findings and immutable persistence across reopen', async () => {
    const f = await fixture(); await useSdkFixture(f);
    const outcome = succeeded(await f.adapter().review(f.input)), { review } = outcome;
    expect(review).toMatchObject({ config: { mode: 'workspace_execution', fixtureDigest: null }, fixtures: null, notification: 'not_performed',
      executionReceipt: { expectedSha: f.head, snapshotCheck: 'exact-local-git-recapture-matched', modelExecution: 'not_run', cleanup: 'verified',
        workerResult: { sessionId: 'authored-sdk-session', boundary: 'authored-test-no-isolation', processEvidence: { processGroupStopped: true } } },
      coverage: { scope: 'changed-entries-only', snapshotVerification: 'package-integrity-only', repositoryContext: 'incomplete', introduction: 'unverified' } });
    expect(review.findings).toHaveLength(2);
    expect(review.findings.filter(item => item.status === 'violation')).toMatchObject([{ origin: 'fixture', introduction: 'unverified', notificationEligibility: 'unverified' }]);
    expect(review.findings.filter(item => item.status === 'not_verified')).toHaveLength(1);
    expect(review.executionReceipt!.workerResult.value.evidence[0].content).toBe(f.before);
    expect(review.executionReceipt!.lifecycle.slice(-4)).toEqual(['stop-verified', 'evidence-collected', 'destroy-verified', 'lease-released']);
    const path = join(f.directory, 'db'); let store = await QualEvoStore.openPGlite(path);
    try {
      await seed(store, f);
      expect(await store.saveSemanticReviewModelResult(outcome.persistence)).toEqual(review);
      expect(await store.saveSemanticReviewModelResult(outcome.persistence)).toEqual(review);
      await store.close();
      // Stored reads depend only on immutable bound evidence, not a live workspace/scanner/model.
      expect((await cleanupWorkspace(f.workspace)).record.status).toBe('closed-clean');
      store = await QualEvoStore.openPGlite(path);
      expect(await store.getSemanticReview(review.id)).toEqual(review);
      expect(await store.listSemanticReviews()).toEqual([review]);
      for (const finding of review.findings) expect(await store.getReviewFinding(finding.id)).toEqual({ finding, feedback: [], verdict: 'Unknown', identityVerification: 'caller-declared-unverified' });
      expect(await store.getActive(f.rule.rule.ruleId)).toBeNull();
    } finally { await store.close(); }
  }, 60_000);

  it.each(['safe', 'violation'] as const)('forces %s to unknown for declared and missing required context', async decision => {
    const f = await fixture();
    f.envelope.value.judgments[0] = { ...f.value.judgments[0], decision, missingContext: ['caller authorization absent'],
      anchorJudgments: [{ ...f.value.judgments[0].anchorJudgments[0], decision, missingContext: ['caller authorization absent'] }] };
    const accepted = succeeded(await f.adapter().review(f.input));
    expect(accepted.review.coverage.targets[0].semantic).toMatchObject({ state: 'unknown', missingContext: ['caller authorization absent'] });
    expect(accepted.review.findings.filter(finding => finding.status === 'unknown')).toMatchObject([{ origin: 'evidence_gate' }]);
    expect(accepted.review.findings.filter(finding => finding.status === 'not_verified')).toHaveLength(1);
    f.envelope.value.judgments[0].evidenceRefs = [];
    f.envelope.value.judgments[0].decision = 'unknown'; f.envelope.value.judgments[0].anchorJudgments = [];
    const missing = succeeded(await f.adapter().review(f.input));
    expect(missing.review.coverage.targets[0].semantic.missingContext).toEqual(['local-policy', 'caller authorization absent']);
    expect(missing.review.findings.every(finding => finding.status === 'not_verified')).toBe(true);
  });

  it('persists detectorless unknowns without fabricating findings or safe coverage', async () => {
    const f = await fixture(false);
    f.envelope.value.judgments[0] = { ...f.value.judgments[0], decision: 'unknown', anchorJudgments: [], evidenceRefs: [], missingContext: ['uncaptured policy dependency'] };
    const outcome = succeeded(await f.adapter().review(f.input)), store = await QualEvoStore.openPGlite();
    try {
      await seed(store, f); const saved = await store.saveSemanticReviewModelResult(outcome.persistence);
      expect(saved.findings).toEqual([]); expect(saved.occurrences).toEqual([]);
      expect((await store.getSemanticReview(saved.id)).coverage.targets[0].semantic).toMatchObject({ state: 'unknown', missingContext: ['local-policy', 'uncaptured policy dependency'] });
    } finally { await store.close(); }
  }, 30_000);

  it('rejects a valid legacy output envelope for a newly requested per-anchor contract', async () => {
    const f = await fixture();
    f.runtime.execute = async () => ({ ...f.envelope, outputContract: 'semantic-review-v1', value: { ...f.value,
      judgments: f.value.judgments.map(({ anchorJudgments, ...judgment }) => ({ ...judgment, findingAnchors: anchorJudgments.map(item => item.anchor) })) } });
    expect(await f.adapter().review(f.input)).toMatchObject({ execution: 'failed', stage: 'output',
      error: 'Review worker output contract does not match requested judgment contract', review: null });
    expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
  });

  it('keeps mixed same-file SDK anchor decisions independent through storage and comparison', async () => {
    const f = await fixture(false); await useSdkFixture(f);
    const first = f.value.judgments[0].anchorJudgments[0].anchor;
    const offset = f.after.lastIndexOf('dangerousRead()');
    const second = makeSnapshotAnchor(f.snapshot, 'after', first.path, offset, offset + 'dangerousRead()'.length);
    const evidence = [first, second].map(anchor => makeReviewEvidence(f.snapshot, anchor, 'local-policy'));
    f.envelope.value.evidence = evidence;
    f.envelope.value.judgments[0].evidenceRefs = evidence.map(item => item.id);
    f.envelope.value.judgments[0].anchorJudgments = evidence.map(item => ({ anchor: item.anchor,
      decision: 'violation', reasoning: 'Authored base rule flags both reads.', evidenceRefs: [item.id], missingContext: [] }));
    const storePath = join(f.directory, 'mixed-db'); let store = await QualEvoStore.openPGlite(storePath);
    try {
      await seed(store, f);
      const base = await store.saveSemanticReviewModelResult(succeeded(await f.adapter().review(f.input)).persistence);
      const candidate = await store.importRuleVersion({ ...f.rule.rule, version: 'mixed-candidate', provenance: { ...f.rule.rule.provenance, parentDigest: f.rule.digest } });
      const target = buildSemanticReview({ rule: candidate, snapshot: f.snapshot }).coverage.targets[0];
      f.envelope.value.ruleDigest = candidate.digest;
      f.envelope.value.judgments[0] = { targetId: target.id, decision: 'unknown', reasoning: 'Whole-file coverage remains unresolved.',
        evidenceRefs: [], missingContext: ['Remaining target context unresolved'], anchorJudgments: [
          { anchor: first, decision: 'safe', reasoning: 'Authored legitimate exception.', evidenceRefs: [evidence[0].id], missingContext: [] },
          { anchor: second, decision: 'violation', reasoning: 'Authored retained violation.', evidenceRefs: [evidence[1].id], missingContext: [] },
        ] };
      const updated = await store.saveSemanticReviewModelResult(succeeded(await f.adapter().review({ ...f.input, rule: candidate })).persistence);
      expect(updated).toMatchObject({ occurrences: [], executionReceipt: { judgmentContract: 'per-anchor-v3', modelExecution: 'not_run',
        workerResult: { outputContract: 'semantic-review-v2', boundary: 'authored-test-no-isolation' } } });
      expect(updated.coverage.targets[0].semantic).toMatchObject({ state: 'unknown' });
      expect(updated.findings.map(item => item.status).sort()).toEqual(['safe', 'violation']);
      for (const [index, anchor] of [first, second].entries()) {
        const finding = base.findings.find(item => digestOf(item.anchor) === digestOf(anchor))!;
        await store.appendReviewFeedback({ id: `mixed-${index}`, findingId: finding.id, reviewId: base.id, ruleDigest: f.rule.digest,
          ruleVersion: f.rule.rule.version, source: 'fixture', actor: 'authored-fixture', kind: 'label', label: index === 0 ? 'FP' : 'TP',
          reason: 'Authored regression expectation, not a human label.', createdAt: '2026-10-02T00:00:00Z' });
      }
      const request = await store.createRevisionRequest({ id: 'mixed-sdk-request', baseRuleDigest: f.rule.digest, requestedRuleVersion: 'mixed-candidate',
        feedbackIds: ['mixed-0', 'mixed-1'], requestedChange: 'Separate a legitimate exception from a same-file violation.',
        actor: 'authored-fixture', source: 'fixture', createdAt: '2026-10-02T00:00:00Z' });
      const comparison = await store.createRevisionComparison({ id: 'mixed-sdk-comparison', requestDigest: request.digest, candidateRuleDigest: candidate.digest,
        reviewPairs: [{ baseReviewId: base.id, candidateReviewId: updated.id }], caseBindings: [] });
      expect(comparison.comparison).toMatchObject({ scorer: 'per-anchor-semantic-v3', summary: { status: 'compatible', corrected: 1, preserved: 1, inconclusive: 0 } });
      await store.close(); expect((await cleanupWorkspace(f.workspace)).record.status).toBe('closed-clean');
      store = await QualEvoStore.openPGlite(storePath);
      expect(await store.getSemanticReview(updated.id)).toEqual(updated);
      expect(await store.getRevisionComparison(comparison.digest)).toEqual(comparison);
      expect(await store.getActive(f.rule.rule.ruleId)).toBeNull();
    } finally { await store.close(); }
  }, 60_000);

  it('rejects JSON persistence authority and deeply freezes the accepted result', async () => {
    const f = await fixture(), outcome = succeeded(await f.adapter().review(f.input)), store = await QualEvoStore.openPGlite();
    try {
      await seed(store, f);
      for (const forged of [outcome.review, outcome.review.executionReceipt, structuredClone(outcome.persistence), {}, { trustedReview: true }, null]) {
        await expect(store.saveSemanticReviewModelResult(forged as TrustedSemanticReview)).rejects.toThrow('trusted runtime capability');
      }
      await expect(store.runSemanticReview({ ruleDigest: f.rule.digest, snapshotDigest: f.snapshot.digest, executionReceipt: outcome.review.executionReceipt } as never)).rejects.toThrow();
      expect(await store.listSemanticReviews()).toEqual([]);
      expect(readTrustedSemanticReview(outcome.persistence)).toEqual(outcome.review);
      expect(() => { readTrustedSemanticReview(outcome.persistence).executionReceipt!.workerResult.value.judgments[0].reasoning = 'changed'; }).toThrow();
      const claimed = structuredClone(outcome.review.executionReceipt!);
      claimed.modelExecution = 'completed'; claimed.workerResult.boundary = 'isolated-runtime';
      expect(SemanticReviewExecutionReceiptSchema.safeParse(claimed).success).toBe(true);
      expect(() => readTrustedSemanticReview(claimed as unknown as TrustedSemanticReview)).toThrow();
      expect(() => validateSemanticReviewExecution(claimed, f.rule, f.snapshot)).toThrow('binding mismatch');
    } finally { await store.close(); }
  }, 30_000);

  it('rederives exact receipt fields, rule scope and typed semantic output without rerunning', async () => {
    const f = await fixture(), outcome = succeeded(await f.adapter().review(f.input)), original = outcome.review.executionReceipt!;
    for (const field of ['ruleDigest', 'snapshotDigest', 'generationDigest', 'promptDigest', 'responseDigest', 'workspaceRequestDigest', 'runtimeResultDigest'] as const) {
      const receipt = structuredClone(original); receipt[field] = 'f'.repeat(64);
      expect(() => validateSemanticReviewExecution(receipt, f.rule, f.snapshot)).toThrow(/binding|exact/);
    }
    for (const modify of [
      (r: typeof original) => { r.expectedSha = f.base; },
      (r: typeof original) => { r.model = 'other-model'; },
      (r: typeof original) => { r.context.workspace.attemptId = 'other-attempt'; },
      (r: typeof original) => { r.workerResult.sessionId = 'other-session'; },
      (r: typeof original) => { r.lifecycle.pop(); },
      (r: typeof original) => { r.workerResult.value.judgments[0].missingContext.push('invented new field'); },
      (r: typeof original) => { r.artifacts[0].sha256 = 'e'.repeat(64); },
    ]) { const receipt = structuredClone(original); modify(receipt); expect(() => validateSemanticReviewExecution(receipt, f.rule, f.snapshot)).toThrow(); }
    const changedRule = structuredClone(f.rule.rule); changedRule.scope.paths.exclude.push('src/sample.ts');
    expect(() => validateSemanticReviewExecution(original, { rule: changedRule, digest: ruleVersionDigest(changedRule) }, f.snapshot)).toThrow();
    const altered = structuredClone(outcome.review); altered.coverage.targets[0].semantic.state = 'safe';
    expect(() => validateSemanticReview(altered, f.rule, f.snapshot)).toThrow('bound semantic evidence');
    expect(f.calls.filter(call => call === 'execute')).toHaveLength(1);
  });

  it('rejects tampered stored provenance even when the stored payload digest is recomputed', async () => {
    const f = await fixture(), outcome = succeeded(await f.adapter().review(f.input));
    const db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db);
    try {
      await seed(store, f); await store.saveSemanticReviewModelResult(outcome.persistence);
      await db.exec('ALTER TABLE qe_semantic_reviews DISABLE TRIGGER qe_semantic_reviews_immutable');
      const forged = structuredClone(outcome.review); forged.executionReceipt!.promptDigest = 'f'.repeat(64);
      await db.query('UPDATE qe_semantic_reviews SET payload_digest=$1,payload=$2::jsonb WHERE id=$3', [digestOf(forged), JSON.stringify(forged), forged.id]);
      await expect(store.getSemanticReview(forged.id)).rejects.toThrow('execution configuration mismatch');
    } finally { await store.close(); }
  }, 30_000);

  it('preserves runtime receipt provenance through existing feedback and revision comparisons', async () => {
    const f = await fixture(), outcome = succeeded(await f.adapter().review(f.input)), store = await QualEvoStore.openPGlite();
    try {
      await seed(store, f); const baseReview = await store.saveSemanticReviewModelResult(outcome.persistence);
      const candidate = await store.importRuleVersion({ ...f.rule.rule, version: 'candidate', provenance: { ...f.rule.rule.provenance, parentDigest: f.rule.digest } });
      const candidateReview = await store.runSemanticReview({ ruleDigest: candidate.digest, snapshotDigest: f.snapshot.digest });
      const finding = baseReview.findings.find(item => item.status === 'violation')!;
      await store.appendReviewFeedback({ id: 'runtime-review-note', findingId: finding.id, reviewId: baseReview.id, ruleDigest: f.rule.digest,
        ruleVersion: f.rule.rule.version, source: 'fixture', actor: 'authored-fixture', kind: 'note', label: null,
        reason: 'Authored plumbing note, not a correctness label', createdAt: '2026-10-02T00:00:00Z' });
      const request = await store.createRevisionRequest({ id: 'runtime-review-revision', baseRuleDigest: f.rule.digest, requestedRuleVersion: 'candidate',
        feedbackIds: ['runtime-review-note'], requestedChange: 'Investigate missing context without assigning truth labels', actor: 'authored-fixture', source: 'fixture', createdAt: '2026-10-02T00:00:00Z' });
      const comparison = await store.createRevisionComparison({ id: 'runtime-review-comparison', requestDigest: request.digest, candidateRuleDigest: candidate.digest,
        reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: candidateReview.id }], caseBindings: [] });
      expect(comparison.comparison).toMatchObject({ summary: { status: 'inconclusive' }, trust: { semanticEvidence: 'includes-workspace-execution-receipts', certification: 'none' }, synthesis: 'not_run', activation: 'not_performed' });
      expect(await store.getRevisionComparison(comparison.digest)).toEqual(comparison);
      expect((await store.getReviewFinding(finding.id)).verdict).toBe('Unknown');
    } finally { await store.close(); }
  }, 30_000);

  it('scores detectorless exact safe anchors through supervised authored execution and storage', async () => {
    const f = await fixture(false), baseOutcome = succeeded(await f.adapter().review(f.input)), store = await QualEvoStore.openPGlite();
    try {
      await seed(store, f); const baseReview = await store.saveSemanticReviewModelResult(baseOutcome.persistence);
      const candidate = await store.importRuleVersion({ ...f.rule.rule, version: 'candidate', provenance: { ...f.rule.rule.provenance, parentDigest: f.rule.digest } });
      const target = buildSemanticReview({ rule: candidate, snapshot: f.snapshot }).coverage.targets[0];
      f.envelope.value = { ...f.value, ruleDigest: candidate.digest,
        judgments: [{ ...f.value.judgments[0], targetId: target.id, decision: 'safe', anchorJudgments: [{ ...f.value.judgments[0].anchorJudgments[0], decision: 'safe' }] }] };
      const candidateOutcome = succeeded(await f.adapter().review({ ...f.input, rule: candidate }));
      const candidateReview = await store.saveSemanticReviewModelResult(candidateOutcome.persistence);
      expect(candidateReview).toMatchObject({ occurrences: [], executionReceipt: { judgmentContract: 'per-anchor-v3', modelExecution: 'not_run' } });
      expect(candidateReview.findings).toMatchObject([{ status: 'safe', occurrenceIds: [], origin: 'fixture' }]);
      const finding = baseReview.findings[0];
      await store.appendReviewFeedback({ id: 'detectorless-fp', findingId: finding.id, reviewId: baseReview.id, ruleDigest: f.rule.digest,
        ruleVersion: f.rule.rule.version, source: 'fixture', actor: 'authored-fixture', kind: 'label', label: 'FP',
        reason: 'Authored exact-anchor expectation, not human truth', createdAt: '2026-10-02T00:00:00Z' });
      const request = await store.createRevisionRequest({ id: 'detectorless-request', baseRuleDigest: f.rule.digest, requestedRuleVersion: 'candidate',
        feedbackIds: ['detectorless-fp'], requestedChange: 'Compare explicit semantic anchors without detectors', actor: 'authored-fixture', source: 'fixture', createdAt: '2026-10-02T00:00:00Z' });
      const comparison = await store.createRevisionComparison({ id: 'detectorless-comparison', requestDigest: request.digest, candidateRuleDigest: candidate.digest,
        reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: candidateReview.id }], caseBindings: [] });
      expect(comparison.comparison).toMatchObject({ scorer: 'per-anchor-semantic-v3', summary: { status: 'compatible', corrected: 1 },
        trust: { semanticEvidence: 'includes-workspace-execution-receipts', certification: 'none' } });
      expect(await store.getRevisionComparison(comparison.digest)).toEqual(comparison);
    } finally { await store.close(); }
  }, 30_000);

  it('prepares the per-anchor contract by default without implying target safety or detector coverage', () => {
    const { rule, snapshot } = semanticInputs();
    const prepared = buildSemanticReviewModelInput({ rule, snapshot, context: { kind: 'full-repository',
      repository: snapshot.snapshot.repository.id, checkout: 'after', workspace: { repoPath: '/tmp/prompt-proof', runId: 'prompt-proof', attemptId: 'one' } } }, config);
    expect(prepared.judgmentContract).toBe('per-anchor-v3');
    expect(buildSemanticReviewWorkspaceRequest(prepared, limits).outputContract).toBe('semantic-review-v2');
    for (const text of ['exactly one target-level judgment', 'mixed legitimate exceptions and violations',
      'each require their own cited snapshot evidence', 'another adjudication cannot supply its evidence or context implicitly',
      'An evidence citation alone never declares its anchor safe', 'their absence is never evidence of safety']) {
      expect(prepared.generation.prompt).toContain(text);
    }
    expect(JSON.stringify(prepared.generation.outputSchema)).toContain('anchorJudgments');
    expect(JSON.stringify(prepared.generation.outputSchema)).not.toContain('findingAnchors');
  });

  it.each([['legacy-target-v1', '048937f7de1cce41ac94b00d6ff32847e80ad3af4fb8d1f7fd89076d9a86e1e9'], ['target-and-anchors-v2', '8b158ad067c6d43239151365403b1b34b505561b96c78f97adf7b57a8611282c']] as const)('reproduces immutable generation bytes for %s', (contract, expected) => {
    const { rule, snapshot } = semanticInputs();
    const prepared = buildSemanticReviewModelInput({ rule, snapshot, context: { kind: 'full-repository',
      repository: snapshot.snapshot.repository.id, checkout: 'after', workspace: { repoPath: '/tmp/legacy-proof', runId: 'legacy-proof', attemptId: 'one' } } },
    { model: 'authored-no-model' }, contract);
    // Compared directly with the original implementation at e0e6c38.
    expect(digestOf(prepared.generation)).toBe(expected);
    expect(digestOf(prepared.generation.outputSchema)).toBe('4d9c391edfed28e903a80f95ce55c19d443933853b4d562d73b6bd7db9852dd0');
  });

  it.each(['legacy-target-v1', 'target-and-anchors-v2'] as const)('validates legacy %s receipts without reinterpreting their anchor contract', async contract => {
    const f = await fixture(), outcome = succeeded(await f.adapter().review(f.input));
    const current = structuredClone(outcome.review.executionReceipt!);
    const dropped = structuredClone(current); delete dropped.judgmentContract;
    expect(() => validateSemanticReviewExecution(dropped, f.rule, f.snapshot)).toThrow(/contract mismatch/);
    const legacyValue = { ...f.value, judgments: f.value.judgments.map(({ anchorJudgments, ...judgment }) => ({
      ...judgment, findingAnchors: anchorJudgments.map(item => item.anchor),
    })) };
    const legacy = { ...dropped, ...(contract === 'target-and-anchors-v2' ? { judgmentContract: contract } : {}),
      workerResult: { ...current.workerResult, outputContract: 'semantic-review-v1' as const, value: legacyValue } };
    const prepared = buildSemanticReviewModelInput(f.input, config, contract);
    expect(prepared.generation.prompt).toContain(contract === 'legacy-target-v1' ? 'Safe/unknown judgments have no finding anchors.' : 'findingAnchors lists exact after-side spans');
    legacy.generationDigest = digestOf(prepared.generation); legacy.promptDigest = bytesDigest(prepared.generation.prompt);
    legacy.workspaceRequestDigest = bytesDigest(JSON.stringify(buildSemanticReviewWorkspaceRequest(prepared, legacy.workspaceLimits)));
    legacy.responseDigest = digestOf(legacyValue);
    legacy.runtimeResultDigest = digestOf(workspaceRuntimeResultBinding(legacy));
    expect(validateSemanticReviewExecution(legacy, f.rule, f.snapshot)).toEqual(legacyValue);
    const review = buildExecutedSemanticReview({ rule: f.rule, snapshot: f.snapshot, executionReceipt: legacy });
    expect(validateSemanticReview(review, f.rule, f.snapshot)).toEqual(review);
    if (contract === 'legacy-target-v1') expect(review.executionReceipt).not.toHaveProperty('judgmentContract');
    else expect(review.executionReceipt!.judgmentContract).toBe(contract);
    const changed = { ...legacy, judgmentContract: contract === 'legacy-target-v1' ? 'target-and-anchors-v2' as const : undefined };
    expect(() => validateSemanticReviewExecution(changed, f.rule, f.snapshot)).toThrow('receipt binding mismatch');
  });

  it('keeps previously persisted fixture context gaps byte-for-byte compatible', () => {
    const input = semanticInputs({ assets: [readAsset], requiredContext: ['policy', 'policy'] });
    const target = buildSemanticReview(input).coverage.targets[0];
    const review = buildSemanticReview({ ...input, fixtures: { schemaVersion: 1, kind: 'semantic-review-offline-fixtures',
      ruleDigest: input.rule.digest, snapshotDigest: input.snapshot.digest, evidence: [],
      judgments: [{ targetId: target.id, decision: 'unknown', reasoning: 'Legacy authored unknown', evidenceRefs: [], findingAnchors: [] }] } });
    expect(review.coverage.targets[0].semantic).toEqual({ state: 'unknown',
      reasoning: 'Required contextual evidence is missing. Fixture context labels are declarations, not independently verified facts.', missingContext: ['policy', 'policy'] });
    expect(review).not.toHaveProperty('executionReceipt'); expect(review.config).not.toHaveProperty('executionDigest');
    expect(validateSemanticReview(review, input.rule, input.snapshot)).toEqual(review);
  });

  it('atomically rolls back generated review and all finding index rows, then retries the capability', async () => {
    const f = await fixture(), outcome = succeeded(await f.adapter().review(f.input)), db = await openPGliteDatabase();
    let fail = true, inserts = 0;
    const wrapped: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, params) => {
      if (fail && sql.startsWith('INSERT INTO qe_semantic_review_findings') && ++inserts === 2) throw new Error('Authored index failure');
      return tx.query(sql, params);
    } })) };
    const store = await QualEvoStore.initialize(wrapped);
    try {
      await seed(store, f); await expect(store.saveSemanticReviewModelResult(outcome.persistence)).rejects.toThrow('Authored index failure');
      expect(await store.listSemanticReviews()).toEqual([]);
      expect((await db.query('SELECT id FROM qe_semantic_review_findings')).rows).toEqual([]);
      fail = false; expect(await store.saveSemanticReviewModelResult(outcome.persistence)).toEqual(outcome.review);
    } finally { await store.close(); }
  }, 30_000);

  it('rejects internally valid snapshot bytes unrelated to the exact workspace commit before allocation', async () => {
    const f = await fixture(), forged = structuredClone(f.snapshot.snapshot);
    forged.changes[0].after = capturedSide('src/sample.ts', 'unrelatedCapturedBytes();\n');
    forged.coverage.capturedBytes = (forged.changes[0].before as { byteLength: number }).byteLength + (forged.changes[0].after as { byteLength: number }).byteLength;
    const input = { ...f.input, snapshot: validateChangeSnapshot(forged) };
    expect(() => buildSemanticReviewModelInput(input, config)).not.toThrow();
    expect(await f.adapter().review(input)).toMatchObject({ execution: 'failed', stage: 'input', review: null, error: 'Review snapshot does not match exact local Git recapture' });
    expect(f.calls).toEqual([]);
  });

  it('freezes independent source/scope/attempt before trusted runtime code executes', async () => {
    const f = await fixture(), original = structuredClone(f.input);
    f.runtime.execute = async () => {
      if (f.input.rule.rule.schemaVersion === 2) f.input.rule.rule.scope.paths.exclude.push('src');
      f.input.attempt = 'mutated'; return f.envelope;
    };
    const outcome = succeeded(await f.adapter().review(f.input));
    expect(outcome.review.config.attempt).toBe('authored');
    expect(validateSemanticReview(outcome.review, original.rule, original.snapshot)).toEqual(outcome.review);
  });
});

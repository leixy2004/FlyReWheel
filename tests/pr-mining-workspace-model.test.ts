import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { PrMiningCandidateSchema, PrMiningCandidateInputSchema } from '../src/core/pr-mining.js';
import { PrMiningExecutionReceiptSchema } from '../src/core/pr-mining-execution.js';
import { captureChangeSnapshot, validateChangeSnapshot } from '../src/change-snapshot.js';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';
import { derivePrMiningRequest } from '../src/pr-mining.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { prepareWorkspace, cleanupWorkspace } from '../src/workspace/index.js';
import { workspaceGit } from '../src/workspace/process.js';
import type { CodexWorkspaceBackend, CodexWorkspaceRuntime } from '../src/workspace/codex-runner.js';
import { runWorkspaceWorkerCommand } from '../src/workspace-worker-entrypoint.js';
import { createPrMiningWorkspaceModelAdapter, readTrustedPrMiningCandidate, validateExecutedPrMiningCandidate,
  type PrMiningModelInput, type PrMiningWorkspaceModelOutcome, type TrustedPrMiningCandidate } from '../src/adapters/pr-mining-model.js';
import { miningDate, miningFixture } from './helpers/pr-mining-fixture.js';

const config = { enabled: true, model: 'authored-executor-no-model' };
const limits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
let root: string, count = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'mining-runtime-fixture-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
async function fixture(supplied = false) {
  const directory = join(root, String(++count)), repoPath = join(directory, 'repo');
  await mkdir(repoPath, { recursive: true }); await mkdir(join(repoPath, 'src'));
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Fixture'); await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(repoPath, 'src/sample.ts'), '\ufefffunction run() { dangerousRead(); }\r\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored before');
  const base = await git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'src/sample.ts'), 'function run() { return 0; }\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored after');
  const head = await git(repoPath, 'rev-parse', 'HEAD');
  const original = miningFixture();
  const captured = await captureChangeSnapshot({ repositoryPath: repoPath, repositoryId: original.evidence.evidence.snapshot.repository.id, baseTip: base, head });
  const snapshot = validateChangeSnapshot({ ...captured.snapshot, prMetadata: original.evidence.evidence.snapshot.prMetadata });
  const evidence = validateGithubPrEvidence({ ...original.evidence.evidence, snapshot: snapshot.snapshot, snapshotDigest: snapshot.digest,
    pull: { ...original.evidence.evidence.pull, baseTip: base, head } });
  const requestInput = { ...original.input, evidenceDigest: evidence.digest, source: supplied ? 'supplied' as const : 'fixture' as const };
  const { request, cases } = derivePrMiningRequest(requestInput, evidence);
  const workspace = { repoPath, runId: 'mining', attemptId: 'authored' };
  const prepared = await prepareWorkspace({ ...workspace, baseSha: base, headSha: head });
  const input: PrMiningModelInput = { request, evidence, candidateId: 'authored-runtime-candidate', candidateCreatedAt: miningDate,
    context: { kind: 'full-repository', repository: snapshot.snapshot.repository.id, checkout: 'before', workspace } };
  const value = { result: { status: 'candidate' as const, semantics: original.candidate.rule.semantics,
    paths: { include: ['src'], exclude: [] }, detectionAssets: [], rationale: 'Authored executable fixture; no model or isolated sandbox run.',
    evidenceRefs: [`case:${request.request.sourceBindings[0].caseId}`, `statement:${request.request.statementBindings[0].digest}`] } };
  const envelope = { protocolVersion: 2, outputContract: 'pr-mining-v1', value, usage, sessionId: 'authored-session',
    processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true },
    boundary: 'authored-test-no-isolation' };
  const calls: string[] = [];
  const runtime: CodexWorkspaceRuntime = {
    async prepare() { calls.push('prepare'); return { expectedSha: base, headSha: base, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
    async execute() { calls.push('execute'); return envelope; },
    async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
    async collect() { calls.push('collect'); return [{ name: 'authored.txt', bytes: Buffer.from('authored fixture, no model') }]; },
    async destroy() { calls.push('destroy'); return { destroyed: true, verified: true }; },
  };
  let received: unknown;
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(request) { received = request; calls.push('reserve'); return runtime; } };
  const adapter = () => createPrMiningWorkspaceModelAdapter(config, { id: 'authored-fixture-runtime', backend, limits });
  return { directory, repoPath, input, requestInput, cases, value, envelope, runtime, backend, calls, prepared, workspace,
    adapter, received: () => received };
}
function candidate(result: PrMiningWorkspaceModelOutcome) {
  expect(result, JSON.stringify(result)).toMatchObject({ execution: 'succeeded', status: 'candidate_requires_review' });
  if (result.execution !== 'succeeded' || result.status !== 'candidate_requires_review') throw new Error('Missing candidate');
  return result;
}

describe('trusted mining runtime provenance (all executors authored fixtures, no model/isolation claims)', () => {
  it('connects official SDK typed worker, lifecycle runner and immutable persistence across reopen', async () => {
    const f = await fixture(true), requestPath = join(f.directory, 'request.json'), executable = join(f.directory, 'authored-cli.cjs');
    await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));
      send({type:'thread.started',thread_id:'authored-sdk-session'});
      send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(f.value)})}});
      send({type:'turn.completed',usage:${JSON.stringify(usage)}});});\n`, { mode: 0o700 });
    f.backend.reserve = (request, workspace) => {
      expect(request.outputContract).toBe('pr-mining-v1');
      f.runtime.execute = async signal => {
        await writeFile(requestPath, JSON.stringify({ workingDirectory: workspace.worktreePath, model: request.model, prompt: request.prompt,
          outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits }));
        return JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: f.directory,
          workingDirectory: workspace.worktreePath, requestPath, codexPathOverride: executable,
          imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } } }, signal));
      };
      return f.runtime;
    };
    const outcome = candidate(await f.adapter().generate(f.input)), receipt = outcome.executionReceipt;
    expect(outcome).toMatchObject({ modelExecution: 'not_run', origin: 'authored-test', candidate: { schemaVersion: 2, source: 'fixture', synthesis: 'not_run',
      semanticValidation: 'not_run', regressionExecution: 'not_run', activation: 'not_performed', certification: 'none' } });
    expect(receipt).toMatchObject({ model: config.model, runtimeId: 'authored-fixture-runtime', execution: 'completed', cleanup: 'verified',
      workerResult: { sessionId: 'authored-sdk-session', boundary: 'authored-test-no-isolation', processEvidence: { exitCode: 0, processGroupStopped: true } } });
    expect(outcome.candidateInput.rule.regressionCases).toEqual([]);
    expect(receipt.workerResult.value).toEqual(f.value);
    expect(receipt.lifecycle.slice(-4)).toEqual(['stop-verified', 'evidence-collected', 'destroy-verified', 'lease-released']);
    expect(outcome.candidateInput.rule.provenance.author).toBe('authored-test:authored-fixture-runtime');
    const path = join(f.directory, 'db'); let store = await QualEvoStore.openPGlite(path);
    try {
      await store.importGithubPrEvidence(f.input.evidence.evidence); await store.createPrMiningRequest(f.requestInput);
      const saved = await store.savePrMiningModelCandidate(outcome.persistence);
      expect(saved.candidate).toEqual(outcome.candidate);
      expect(await store.savePrMiningModelCandidate(outcome.persistence)).toEqual(saved);
      expect(await store.listPrMiningCandidates()).toEqual([saved]);
      expect(await store.getActive(outcome.candidateInput.rule.ruleId)).toBeNull();
      for (const value of f.cases) expect(await store.getProblemCase(value.id)).toEqual(value);
      await store.close(); store = await QualEvoStore.openPGlite(path);
      expect(await store.getPrMiningCandidate(saved.digest)).toEqual(saved);
      expect((await store.getRuleVersion(saved.candidate.ruleDigest)).rule).toEqual(outcome.candidateInput.rule);
      const review = await store.runSemanticReview({ ruleDigest: saved.candidate.ruleDigest, snapshotDigest: f.input.evidence.evidence.snapshotDigest });
      expect(review.findings).toEqual([]); expect(review.coverage.targets.every(item => item.semantic.state === 'not_run')).toBe(true);
    } finally { await store.close(); }
    expect((await cleanupWorkspace(f.workspace)).record.status).toBe('closed-clean');
  }, 60_000);

  it('never accepts JSON, a copied capability or a self-declared model import as runtime authority', async () => {
    const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input)), store = await QualEvoStore.openPGlite();
    try {
      await store.importGithubPrEvidence(f.input.evidence.evidence); await store.createPrMiningRequest(f.requestInput);
      for (const forged of [outcome.candidateInput, outcome.candidate, JSON.parse(JSON.stringify(outcome.persistence)), {}, { trustedCandidate: true }, null]) {
        await expect(store.savePrMiningModelCandidate(forged as TrustedPrMiningCandidate)).rejects.toThrow('trusted runtime capability');
      }
      expect(PrMiningCandidateInputSchema.safeParse({ ...outcome.candidateInput, source: 'model' }).success).toBe(false);
      await expect(store.importPrMiningCandidate({ ...outcome.candidateInput, source: 'fixture' } as never)).rejects.toThrow();
      expect(await store.listPrMiningCandidates()).toEqual([]); expect(await store.listRuleVersions()).toEqual([]);
      expect(readTrustedPrMiningCandidate(outcome.persistence)).toEqual(outcome.candidateInput);
      expect(() => { readTrustedPrMiningCandidate(outcome.persistence).rule.semantics.title = 'changed'; }).toThrow();
      expect(Object.isFrozen(outcome.candidateInput.executionReceipt.workerResult.value.result)).toBe(true);
    } finally { await store.close(); }
  }, 30_000);

  it('rederives every generation/result/request binding and reconstructed rule when reading a receipt', async () => {
    const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input));
    for (const field of ['requestDigest', 'generationDigest', 'promptDigest', 'responseDigest', 'workspaceRequestDigest', 'runtimeResultDigest'] as const) {
      const input = structuredClone(outcome.candidateInput); input.executionReceipt[field] = 'f'.repeat(64);
      expect(() => validateExecutedPrMiningCandidate(input, f.input.request, f.input.evidence)).toThrow(/binding/);
    }
    for (const modify of [
      (input: typeof outcome.candidateInput) => { input.executionReceipt.model = 'different-model'; },
      (input: typeof outcome.candidateInput) => { input.executionReceipt.context.checkout = 'after'; },
      (input: typeof outcome.candidateInput) => { input.executionReceipt.lifecycle.pop(); },
      (input: typeof outcome.candidateInput) => { input.executionReceipt.workerResult.sessionId = 'different-session'; },
      (input: typeof outcome.candidateInput) => { input.rule.semantics.title = 'Substituted hypothesis'; },
      (input: typeof outcome.candidateInput) => { input.rule.regressionCases.push({ caseId: f.cases[0].id, role: 'positive' }); },
      (input: typeof outcome.candidateInput) => { input.rule.provenance.sourceCases[0].commit = 'f'.repeat(40); },
    ]) {
      const input = structuredClone(outcome.candidateInput); modify(input);
      expect(() => validateExecutedPrMiningCandidate(input, f.input.request, f.input.evidence)).toThrow();
    }
    expect(PrMiningExecutionReceiptSchema.safeParse({ ...outcome.executionReceipt, modelExecution: 'completed' }).success).toBe(false);
    expect(PrMiningCandidateSchema.safeParse({ ...outcome.candidate, source: 'model' }).success).toBe(false);
    expect(PrMiningCandidateSchema.safeParse({ ...outcome.candidate, synthesis: 'completed' }).success).toBe(false);
  });

  it('represents a model-completed record in the schema without granting a forged receipt persistence authority', async () => {
    const f = await fixture(true), outcome = candidate(await f.adapter().generate(f.input));
    // Schema-only representation test. This JSON is forged, not a model execution,
    // and must never be persisted as one.
    const claimed = structuredClone(outcome.candidate);
    claimed.source = 'model'; claimed.synthesis = 'completed';
    claimed.executionReceipt.modelExecution = 'completed';
    claimed.executionReceipt.workerResult.boundary = 'isolated-runtime';
    expect(PrMiningCandidateSchema.safeParse(claimed).success).toBe(true);
    expect(() => readTrustedPrMiningCandidate(claimed as unknown as TrustedPrMiningCandidate)).toThrow('trusted runtime capability');
    const forged = { ...outcome.candidateInput, executionReceipt: claimed.executionReceipt };
    expect(() => validateExecutedPrMiningCandidate(forged, f.input.request, f.input.evidence)).toThrow('binding mismatch');
    expect(readTrustedPrMiningCandidate(outcome.persistence).executionReceipt.modelExecution).toBe('not_run');
  });

  it('rejects tampered stored receipt bindings even with a recomputed candidate digest', async () => {
    const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input)), db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db);
    try {
      await store.importGithubPrEvidence(f.input.evidence.evidence); await store.createPrMiningRequest(f.requestInput);
      const saved = await store.savePrMiningModelCandidate(outcome.persistence);
      await db.exec('ALTER TABLE qe_pr_mining_candidates DISABLE TRIGGER qe_pr_mining_candidates_immutable');
      const forged = structuredClone(outcome.candidate); forged.executionReceipt.promptDigest = 'f'.repeat(64);
      const digest = digestOf(forged);
      await db.query('UPDATE qe_pr_mining_candidates SET digest=$1,payload=$2::jsonb WHERE digest=$3', [digest, JSON.stringify(forged), saved.digest]);
      await expect(store.getPrMiningCandidate(digest)).rejects.toThrow('binding mismatch');
    } finally { await store.close(); }
  }, 30_000);

  it('atomically rolls back a rule on generated candidate write failure and retries the same capability', async () => {
    const f = await fixture(), outcome = candidate(await f.adapter().generate(f.input)), db = await openPGliteDatabase();
    let fail = true;
    const wrapped: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, params) => {
      if (fail && sql.startsWith('INSERT INTO qe_pr_mining_candidates(')) throw new Error('Authored write failure');
      return tx.query(sql, params);
    } })) };
    const store = await QualEvoStore.initialize(wrapped);
    try {
      await store.importGithubPrEvidence(f.input.evidence.evidence); await store.createPrMiningRequest(f.requestInput);
      await expect(store.savePrMiningModelCandidate(outcome.persistence)).rejects.toThrow('Authored write failure');
      expect(await store.listRuleVersions()).toEqual([]); expect(await store.listPrMiningCandidates()).toEqual([]);
      fail = false; expect((await store.savePrMiningModelCandidate(outcome.persistence)).candidate).toEqual(outcome.candidate);
    } finally { await store.close(); }
  }, 30_000);

  it('retains complete execution provenance for insufficient evidence without a candidate capability', async () => {
    const f = await fixture();
    f.runtime.execute = async () => ({ ...f.envelope, value: { result: { status: 'insufficient_evidence', reasoning: 'Authored no-rule response', missingEvidence: ['Policy'], evidenceRefs: [] } } });
    const outcome = await f.adapter().generate(f.input);
    expect(outcome).toMatchObject({ execution: 'succeeded', status: 'insufficient_evidence', candidate: null, modelExecution: 'not_run',
      executionReceipt: { execution: 'completed', cleanup: 'verified' } });
    expect(outcome).not.toHaveProperty('persistence'); expect(outcome).not.toHaveProperty('candidateInput');
  });

  it.each(['provenance', 'labels', 'certification', 'regressionCases', 'invalid-citation', 'legacy-envelope', 'boundary', 'exit', 'stop', 'supervision', 'process-bytes', 'oversized'])(
    'rejects %s output after cleanup without granting persistence', async kind => {
      const f = await fixture();
      const value = structuredClone(f.envelope);
      if (kind === 'invalid-citation') value.value.result.evidenceRefs = ['case:invented'];
      else if (kind === 'legacy-envelope') Object.assign(value, { protocolVersion: 1 });
      else if (kind === 'boundary') value.boundary = 'isolated-runtime';
      else if (kind === 'exit') value.processEvidence.exitCode = 1;
      else if (kind === 'stop') value.processEvidence.processGroupStopped = false;
      else if (kind === 'supervision') value.processEvidence.reason = 'timeout';
      else if (kind === 'process-bytes') value.processEvidence.stdoutBytes = limits.maxOutputBytes + 1;
      else if (kind === 'oversized') value.value.result.rationale = 'x'.repeat(140_000);
      else Object.assign(value.value.result, { [kind]: 'self-declared' });
      f.runtime.execute = async () => value;
      const outcome = await f.adapter().generate(f.input);
      expect(outcome).toMatchObject({ execution: 'failed', modelExecution: 'not_run', candidate: null, runtimeResult: { cleanup: 'verified' } });
      expect(outcome).not.toHaveProperty('persistence'); expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
    });

  it.each(['prepare', 'execute', 'stop', 'collect', 'destroy'] as const)('withholds a candidate on %s failure and preserves recovery state', async stage => {
    const f = await fixture();
    f.runtime[stage] = async () => { throw new Error(`Authored ${stage} failure`); };
    const outcome = await f.adapter().generate(f.input);
    expect(outcome).toMatchObject({ execution: 'failed', stage: 'runtime', candidate: null, modelExecution: 'not_run' });
    if (outcome.execution !== 'failed' || !outcome.runtimeResult) throw new Error('Missing runtime receipt');
    if (['stop', 'collect', 'destroy'].includes(stage)) {
      expect(outcome.runtimeResult.cleanup).toBe('retained-for-recovery'); await expect(access(outcome.runtimeResult.leasePath)).resolves.toBeUndefined();
    } else expect(outcome.runtimeResult.cleanup).toBe('verified');
    expect(outcome).not.toHaveProperty('persistence');
  });

  it('fails closed before allocation for disabled, missing, cancelled, selected-only, invalid limits and forged JSON runtime', async () => {
    const f = await fixture(), dependency = { id: 'fixture', backend: f.backend, limits };
    expect(await createPrMiningWorkspaceModelAdapter({ ...config, enabled: false }, dependency).generate(f.input)).toMatchObject({ reason: 'disabled' });
    expect(await createPrMiningWorkspaceModelAdapter(config).generate(f.input)).toMatchObject({ reason: 'runtime_unavailable' });
    const controller = new AbortController(); controller.abort();
    expect(await f.adapter().generate(f.input, controller.signal)).toMatchObject({ reason: 'cancelled' });
    expect(await f.adapter().generate({ ...f.input, context: { kind: 'selected-evidence' } })).toMatchObject({ execution: 'failed', stage: 'input' });
    expect(await createPrMiningWorkspaceModelAdapter(config, { ...dependency, limits: { ...limits, maxOutputBytes: 262_144 } }).generate(f.input))
      .toMatchObject({ execution: 'failed', stage: 'input' });
    expect(() => createPrMiningWorkspaceModelAdapter(config, JSON.parse(JSON.stringify(dependency)))).toThrow();
    expect(f.calls).toEqual([]);
  });

  it.each(['cancelled', 'timed-out'] as const)('waits for runner cleanup after %s without claiming a real model ran', async type => {
    const f = await fixture(), controller = new AbortController();
    f.runtime.execute = async () => { if (type === 'cancelled') controller.abort(); return new Promise(() => {}); };
    const run = createPrMiningWorkspaceModelAdapter(config, { id: 'authored-fixture', backend: f.backend, limits: { ...limits, timeoutMs: 50 } });
    const outcome = await run.generate(f.input, controller.signal);
    expect(outcome).toMatchObject({ execution: 'failed', modelExecution: 'not_run', candidate: null,
      runtimeResult: { execution: type, cleanup: 'verified' } });
    expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
  });

  it('withholds acceptance when caller cancels while verified cleanup is in progress', async () => {
    const f = await fixture(), controller = new AbortController();
    f.runtime.stop = async () => { controller.abort(); return { stopped: true, verified: true }; };
    const outcome = await f.adapter().generate(f.input, controller.signal);
    expect(outcome).toMatchObject({ execution: 'failed', modelExecution: 'not_run', candidate: null,
      runtimeResult: { execution: 'succeeded', cleanup: 'verified' } });
    expect(outcome).not.toHaveProperty('persistence');
  });

  it('freezes independent source evidence before handing the request to runtime code', async () => {
    const f = await fixture(), original = structuredClone(f.input);
    f.runtime.execute = async () => { f.input.evidence.evidence.pull.body = 'mutated'; f.input.request.request.input.objective = 'mutated'; f.input.candidateId = 'changed'; return f.envelope; };
    const outcome = candidate(await f.adapter().generate(f.input));
    expect(outcome.candidate.id).toBe(original.candidateId);
    expect(validateExecutedPrMiningCandidate(outcome.candidateInput, original.request, original.evidence)).toEqual(outcome.candidate);
    expect(f.received()).toMatchObject({ outputContract: 'pr-mining-v1' });
  });
});

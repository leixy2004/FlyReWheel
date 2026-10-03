import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeReviewEvidence, makeSnapshotAnchor, snapshotSource } from '../src/adapters/semantic-review-fixture.js';
import { createSemanticReviewWorkspaceModelAdapter, type SemanticReviewModelInput,
  type SemanticReviewWorkspaceOutcome } from '../src/adapters/semantic-review-model.js';
import { captureChangeSnapshot, validateChangeSnapshot } from '../src/change-snapshot.js';
import { makeReviewTargets } from '../src/semantic-review-inputs.js';
import { prepareWorkspace } from '../src/workspace/index.js';
import { workspaceGit } from '../src/workspace/process.js';
import type { CodexWorkspaceBackend, CodexWorkspaceRuntime, WorkspaceLimits } from '../src/workspace/codex-runner.js';
import type { PerAnchorSemanticReviewWorkspaceWorkerResult } from '../src/workspace/worker-protocol.js';
import { capturedSide, semanticInputs } from './helpers/semantic-review-fixture.js';

// Every executor below is explicitly authored. No model, credential, network,
// sandbox service, or isolation guarantee is exercised by these tests.
const config = { enabled: true, model: 'authored-review-no-model' };
const limits: WorkspaceLimits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, maxArtifactBytes: 4096,
  maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
let root: string, count = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'semantic-review-limits-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();

async function fixture(checkout: 'after' | 'before' = 'after') {
  const repoPath = join(root, String(++count), 'repo');
  await mkdir(join(repoPath, 'src/generated'), { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Review Fixture');
  await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(repoPath, 'src/sample.ts'), '\ufeff// 😀 before\r\nfunction run() { return 0; }\r\n');
  await writeFile(join(repoPath, 'src/second.ts'), 'export const second = 0;\n');
  await writeFile(join(repoPath, 'src/deleted.ts'), 'export const removed = 1;\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored before');
  const base = await git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'src/sample.ts'), '\ufeff// 😀 after\r\nfunction run() { dangerousRead(); }\r\n');
  await writeFile(join(repoPath, 'src/second.ts'), 'export const second = dangerousRead();\n');
  await rm(join(repoPath, 'src/deleted.ts'));
  await writeFile(join(repoPath, 'src/generated/ignored.ts'), 'generatedRead();\n');
  await writeFile(join(repoPath, 'src/odd:name.ts'), 'unsupportedPath();\n');
  await symlink('sample.ts', join(repoPath, 'src/link.ts'));
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored after');
  const head = await git(repoPath, 'rev-parse', 'HEAD');
  const { rule } = semanticInputs();
  const snapshot = await captureChangeSnapshot({ repositoryPath: repoPath, repositoryId: 'synthetic:review', baseTip: base, head });
  const workspace = { repoPath, runId: 'review', attemptId: 'authored' };
  await prepareWorkspace({ ...workspace, baseSha: checkout === 'after' ? snapshot.snapshot.head : base });
  const input: SemanticReviewModelInput = { rule, snapshot,
    context: { kind: 'full-repository', repository: 'synthetic:review', checkout: 'after', workspace } };
  const targets = makeReviewTargets(rule.rule, rule.digest, snapshot);
  const captured = targets.filter(target => target.disposition === 'captured');
  const evidence = captured.map(target => makeReviewEvidence(snapshot,
    makeSnapshotAnchor(snapshot, 'after', target.path, 0, snapshotSource(snapshot, 'after', target.path).length), 'local-policy'));
  const envelope: PerAnchorSemanticReviewWorkspaceWorkerResult = {
    protocolVersion: 2, outputContract: 'semantic-review-v2',
    value: { ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence,
      judgments: captured.map((target, index) => {
        const start = snapshotSource(snapshot, 'after', target.path).indexOf('dangerousRead()');
        return { targetId: target.id, decision: 'violation', reasoning: 'Authored fixture judgment; no model or policy certification.',
          evidenceRefs: [evidence[index].id], missingContext: [], anchorJudgments: [{
            anchor: makeSnapshotAnchor(snapshot, 'after', target.path, start, start + 'dangerousRead()'.length),
            decision: 'violation', reasoning: 'Authored exact anchor judgment.', evidenceRefs: [evidence[index].id], missingContext: [],
          }] };
      }) },
    usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    sessionId: 'authored-review-session', boundary: 'authored-test-no-isolation',
    processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true },
  };
  const calls: string[] = [];
  const runtime: CodexWorkspaceRuntime = {
    async prepare() { calls.push('prepare'); return { expectedSha: head, headSha: head, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
    async execute() { calls.push('execute'); return envelope; },
    async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
    async collect() { calls.push('collect'); return [{ name: 'authored.txt', bytes: Buffer.from('authored review only') }]; },
    async destroy() { calls.push('destroy'); return { destroyed: true, verified: true }; },
  };
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve() { calls.push('reserve'); return runtime; } };
  const dependency = { id: 'authored-review-runtime', backend, limits };
  const adapter = () => createSemanticReviewWorkspaceModelAdapter(config, dependency);
  return { input, envelope, calls, runtime, backend, dependency, adapter, targets, base, head };
}

function rejected(outcome: SemanticReviewWorkspaceOutcome, stage: 'input' | 'runtime' | 'output') {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ execution: 'failed', modelExecution: 'not_run', stage, review: null });
  expect(outcome).not.toHaveProperty('persistence');
  if (outcome.execution !== 'failed') throw new Error('Expected a failed review');
  return outcome;
}

describe('semantic workspace review fails closed (authored executors, no live model or isolation claims)', () => {
  it('rejects disabled, absent, serialized and already-cancelled runtime before allocating', async () => {
    const f = await fixture();
    expect(await createSemanticReviewWorkspaceModelAdapter({ ...config, enabled: false }, f.dependency).review(f.input))
      .toEqual({ execution: 'not_run', modelExecution: 'not_run', reason: 'disabled', review: null });
    expect(await createSemanticReviewWorkspaceModelAdapter(config).review(f.input))
      .toEqual({ execution: 'not_run', modelExecution: 'not_run', reason: 'runtime_unavailable', review: null });
    const controller = new AbortController(); controller.abort();
    expect(await f.adapter().review(f.input, controller.signal))
      .toEqual({ execution: 'not_run', modelExecution: 'not_run', reason: 'cancelled', review: null });
    expect(() => createSemanticReviewWorkspaceModelAdapter(config, JSON.parse(JSON.stringify(f.dependency)))).toThrow();
    expect(() => createSemanticReviewWorkspaceModelAdapter(config, { ...f.dependency, limits: { ...limits, maxArtifacts: -1 } })).toThrow();
    expect(f.calls).toEqual([]);
  });

  it.each(['selected-only', 'before-checkout', 'wrong-repository', 'rule-digest', 'snapshot-digest', 'blank-attempt'])(
    'rejects invalid %s input before allocating', async kind => {
      const f = await fixture(), input = structuredClone(f.input);
      if (kind === 'selected-only') Object.assign(input, { context: { kind: 'selected-evidence' } });
      else if (kind === 'before-checkout') Object.assign(input.context, { checkout: 'before' });
      else if (kind === 'wrong-repository') input.context.repository = 'unrelated:repository';
      else if (kind === 'rule-digest') input.rule.digest = 'f'.repeat(64);
      else if (kind === 'snapshot-digest') input.snapshot.digest = 'f'.repeat(64);
      else input.attempt = '';
      expect(rejected(await f.adapter().review(input), 'input').runtimeResult).toBeNull();
      expect(f.calls).toEqual([]);
    });

  it.each(['generation-bytes', 'workspace-bytes', 'output-limit', 'time-limit'])(
    'enforces %s before runtime allocation', async kind => {
      const f = await fixture();
      const options = kind === 'generation-bytes' ? { ...config, limits: { maxInputBytes: 1, maxOutputBytes: 131_072, timeoutMs: 30_000 } } : config;
      const workspaceLimits = { ...limits, ...(kind === 'workspace-bytes' ? { maxInputBytes: 1 } : {}),
        ...(kind === 'output-limit' ? { maxOutputBytes: 262_144 } : {}), ...(kind === 'time-limit' ? { timeoutMs: 30_001 } : {}) };
      const outcome = await createSemanticReviewWorkspaceModelAdapter(options, { ...f.dependency, limits: workspaceLimits }).review(f.input);
      expect(rejected(outcome, 'input').runtimeResult).toBeNull(); expect(f.calls).toEqual([]);
    });

  it('rejects an internally valid imported snapshot whose bytes do not match exact local Git recapture', async () => {
    const f = await fixture(), snapshot = structuredClone(f.input.snapshot.snapshot);
    const change = snapshot.changes.find(item => item.after.state !== 'absent' && item.after.path === 'src/sample.ts')!;
    if (change.after.state !== 'captured') throw new Error('Missing authored source');
    const originalBytes = change.after.byteLength;
    change.after = capturedSide('src/sample.ts', 'inventedRead();\n');
    snapshot.coverage.capturedBytes += change.after.byteLength - originalBytes;
    const outcome = rejected(await f.adapter().review({ ...f.input, snapshot: validateChangeSnapshot(snapshot) }), 'input');
    expect(outcome.error).toContain('exact local Git recapture'); expect(outcome.runtimeResult).toBeNull(); expect(f.calls).toEqual([]);
  });

  it('rejects a host workspace prepared at the before SHA before backend reservation', async () => {
    const f = await fixture('before');
    const outcome = rejected(await f.adapter().review(f.input), 'runtime');
    expect(outcome.runtimeResult).toBeNull(); expect(outcome.error).toMatch(/workspace|SHA|identity/i); expect(f.calls).toEqual([]);
  });

  it.each(['expected-sha', 'head-sha', 'dirty', 'identity', 'history'])(
    'rejects runtime %s verification without starting a worker and still cleans up', async kind => {
      const f = await fixture();
      f.runtime.prepare = async () => ({ expectedSha: kind === 'expected-sha' ? f.base : f.head,
        headSha: kind === 'head-sha' ? f.base : f.head, clean: kind !== 'dirty', identityValid: kind !== 'identity',
        historyPolicy: (kind === 'history' ? 'unknown' : 'all-local-refs-v1') as 'all-local-refs-v1' });
      const outcome = rejected(await f.adapter().review(f.input), 'runtime');
      expect(outcome.runtimeResult).toMatchObject({ execution: 'failed', cleanup: 'verified' });
      expect(outcome.runtimeResult?.lifecycle).not.toContain('worker-started'); expect(f.calls).not.toContain('execute');
      expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
    });

  const outputCorruptions: Array<[string, (value: PerAnchorSemanticReviewWorkspaceWorkerResult) => void]> = [
    ['rule binding', p => { p.value.ruleDigest = 'f'.repeat(64); }],
    ['snapshot binding', p => { p.value.snapshotDigest = 'f'.repeat(64); }],
    ['invented target', p => { p.value.judgments[0].targetId = 'f'.repeat(64); }],
    ['missing target', p => { p.value.judgments.pop(); }],
    ['duplicate target', p => { p.value.judgments.push(p.value.judgments[0]); }],
    ['duplicate evidence', p => { p.value.evidence.push(p.value.evidence[0]); }],
    ['unknown evidence reference', p => { p.value.judgments[0].evidenceRefs = ['f'.repeat(64)]; }],
    ['duplicate evidence reference', p => { p.value.judgments[0].evidenceRefs.push(p.value.judgments[0].evidenceRefs[0]); }],
    ['uncited decisive judgment', p => { p.value.judgments[0].evidenceRefs = []; }],
    ['forged evidence content', p => { p.value.evidence[0].content += 'invented'; }],
    ['forged evidence identity', p => { p.value.evidence[0].id = 'f'.repeat(64); }],
    ['forged source digest', p => { p.value.evidence[0].anchor.sourceDigest = 'f'.repeat(64); }],
    ['forged anchor snapshot', p => { p.value.judgments[0].anchorJudgments[0].anchor.snapshotDigest = 'f'.repeat(64); }],
    ['wrong UTF-16 location', p => { p.value.judgments[0].anchorJudgments[0].anchor.span.start.column++; }],
    ['empty finding anchor', p => { p.value.judgments[0].anchorJudgments[0].anchor.span.end = p.value.judgments[0].anchorJudgments[0].anchor.span.start; }],
    ['missing violation anchor', p => { p.value.judgments[0].anchorJudgments = []; }],
    ['duplicate finding anchor', p => { p.value.judgments[0].anchorJudgments.push(p.value.judgments[0].anchorJudgments[0]); }],
    ['foreign captured target anchor', p => { p.value.judgments[0].anchorJudgments = p.value.judgments[1].anchorJudgments; }],
    ['foreign safe finding anchor', p => { p.value.judgments[0].decision = 'safe'; p.value.judgments[0].anchorJudgments = p.value.judgments[1].anchorJudgments.map(item => ({ ...item, decision: 'safe' })); }],
    ['safe target with violating anchor', p => { p.value.judgments[0].decision = 'safe'; }],
    ['duplicate missing context', p => { p.value.judgments[0].missingContext = ['unseen-policy', 'unseen-policy']; }],
    ['missing missingContext declaration', p => { delete (p.value.judgments[0] as Partial<typeof p.value.judgments[0]>).missingContext; }],
    ['uncited decisive anchor', p => { p.value.judgments[0].anchorJudgments[0].evidenceRefs = []; }],
    ['unavailable anchor evidence', p => { p.value.judgments[0].anchorJudgments[0].evidenceRefs = ['f'.repeat(64)]; }],
    ['duplicate anchor evidence', p => { p.value.judgments[0].anchorJudgments[0].evidenceRefs.push(p.value.evidence[0].id); }],
    ['missing anchor context declaration', p => { const anchor = p.value.judgments[0].anchorJudgments[0]; delete (anchor as Partial<typeof anchor>).missingContext; }],
    ['duplicate anchor missing context', p => { p.value.judgments[0].anchorJudgments[0].missingContext = ['gap', 'gap']; }],
    ['forged certification', p => { Object.assign(p.value, { certification: 'human-approved' }); }],
    ['forged execution provenance', p => { Object.assign(p.value, { modelExecution: 'completed' }); }],
    ['forged notification eligibility', p => { Object.assign(p.value.judgments[0], { notificationEligibility: 'verified' }); }],
    ['legacy protocol', p => { Object.assign(p, { protocolVersion: 1 }); }],
    ['wrong output contract', p => { Object.assign(p, { outputContract: 'pr-mining-v1' }); }],
    ['self-declared isolation', p => { p.boundary = 'isolated-runtime'; }],
    ['nonzero process exit', p => { p.processEvidence.exitCode = 1; }],
    ['missing process exit', p => { p.processEvidence.exitCode = null; }],
    ['unfinished process group', p => { p.processEvidence.processGroupStopped = false; }],
    ['timeout process result', p => { p.processEvidence.reason = 'timeout'; }],
    ['combined process bytes', p => { p.processEvidence.stdoutBytes = limits.maxOutputBytes; p.processEvidence.stderrBytes = 1; }],
    ['forwarded byte overflow', p => { p.processEvidence.stdoutBytes = limits.maxOutputBytes; p.processEvidence.forwardedBytes = limits.maxOutputBytes + 1; }],
    ['impossible forwarded bytes', p => { p.processEvidence.forwardedBytes = 1; }],
  ];
  it.each(outputCorruptions)('rejects %s after verified cleanup without accepting a review', async (_name, mutate) => {
    const f = await fixture(), value = structuredClone(f.envelope); mutate(value);
    f.runtime.execute = async () => value;
    const outcome = rejected(await f.adapter().review(f.input), 'output');
    expect(outcome.runtimeResult).toMatchObject({ execution: 'succeeded', cleanup: 'verified' });
    expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
  });

  it.each(['deleted', 'excluded', 'out_of_scope', 'unsupported_scope'] as const)(
    'rejects a judgment about a %s target despite valid captured target judgments', async disposition => {
      const f = await fixture(), target = f.targets.find(item => item.disposition === disposition);
      expect(target).toBeDefined();
      f.envelope.value.judgments.push({ targetId: target!.id, decision: 'unknown', reasoning: 'Authored invalid scope claim.',
        evidenceRefs: [], anchorJudgments: [], missingContext: ['uncaptured context'] });
      expect(rejected(await f.adapter().review(f.input), 'output').error).toContain('target');
      expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
    });

  it('rejects a valid before-side span as a finding anchor', async () => {
    const f = await fixture(), source = snapshotSource(f.input.snapshot, 'before', 'src/sample.ts');
    f.envelope.value.judgments[0].anchorJudgments[0].anchor = makeSnapshotAnchor(f.input.snapshot, 'before', 'src/sample.ts', 0, source.length);
    expect(rejected(await f.adapter().review(f.input), 'output').error).toContain('after-side');
  });

  it.each(['undefined', 'null', 'plain-string', 'oversized'])(
    'rejects %s worker output with verified cleanup', async kind => {
      const f = await fixture();
      f.runtime.execute = async () => kind === 'undefined' ? undefined : kind === 'null' ? null : kind === 'plain-string' ? 'not a typed envelope' : 'x'.repeat(limits.maxOutputBytes + 1);
      const outcome = rejected(await f.adapter().review(f.input), kind === 'undefined' || kind === 'oversized' ? 'runtime' : 'output');
      expect(outcome.runtimeResult?.cleanup).toBe('verified'); expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
    });

  it.each(['prepare', 'execute', 'stop', 'collect', 'destroy'] as const)(
    'withholds review on a thrown %s failure and retains unverifiable cleanup for recovery', async stage => {
      const f = await fixture();
      f.runtime[stage] = async () => { throw new Error(`Authored ${stage} failure`); };
      const outcome = rejected(await f.adapter().review(f.input), 'runtime');
      expect(outcome.runtimeResult?.errors.join(' ')).toContain(`Authored ${stage} failure`);
      if (['stop', 'collect', 'destroy'].includes(stage)) {
        expect(outcome.runtimeResult?.cleanup).toBe('retained-for-recovery');
        await expect(access(outcome.runtimeResult!.leasePath)).resolves.toBeUndefined();
        expect(outcome.runtimeResult?.lifecycle).not.toContain('lease-released');
      } else {
        expect(outcome.runtimeResult?.cleanup).toBe('verified');
        await expect(access(outcome.runtimeResult!.leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });

  it.each(['stop-false', 'stop-unverified', 'destroy-false', 'destroy-unverified', 'artifact-count', 'artifact-bytes', 'artifact-duplicate', 'artifact-traversal', 'cleanup-timeout'])(
    'retains recovery lease and no review on %s', async kind => {
      const f = await fixture();
      if (kind.startsWith('stop-')) f.runtime.stop = async () => ({ stopped: kind !== 'stop-false', verified: kind !== 'stop-unverified' });
      else if (kind.startsWith('destroy-')) f.runtime.destroy = async () => ({ destroyed: kind !== 'destroy-false', verified: kind !== 'destroy-unverified' });
      else if (kind === 'artifact-count') f.runtime.collect = async () => Array.from({ length: limits.maxArtifacts + 1 }, (_, i) => ({ name: `artifact-${i}`, bytes: Buffer.from('fixture') }));
      else if (kind === 'artifact-bytes') f.runtime.collect = async () => [{ name: 'large', bytes: Buffer.alloc(limits.maxArtifactBytes + 1) }];
      else if (kind === 'artifact-duplicate') f.runtime.collect = async () => [{ name: 'same', bytes: Buffer.from('a') }, { name: 'same', bytes: Buffer.from('b') }];
      else if (kind === 'artifact-traversal') f.runtime.collect = async () => [{ name: '../outside', bytes: Buffer.from('fixture') }];
      else f.runtime.stop = async () => new Promise(() => {});
      const adapter = createSemanticReviewWorkspaceModelAdapter(config, { ...f.dependency, limits: { ...limits, cleanupTimeoutMs: kind === 'cleanup-timeout' ? 20 : limits.cleanupTimeoutMs } });
      const outcome = rejected(await adapter.review(f.input), 'runtime');
      expect(outcome.runtimeResult).toMatchObject({ execution: 'failed', cleanup: 'retained-for-recovery' });
      expect(outcome.runtimeResult?.lifecycle).not.toContain('lease-released');
      await expect(access(outcome.runtimeResult!.leasePath)).resolves.toBeUndefined();
    });

  it.each(['cancelled', 'timed-out'] as const)('waits for cleanup after execution is %s', async kind => {
    const f = await fixture(), controller = new AbortController();
    f.runtime.execute = async () => { if (kind === 'cancelled') controller.abort(); return new Promise(() => {}); };
    const adapter = createSemanticReviewWorkspaceModelAdapter(config, { ...f.dependency, limits: { ...limits, timeoutMs: 30 } });
    const outcome = rejected(await adapter.review(f.input, controller.signal), 'runtime');
    expect(outcome.runtimeResult).toMatchObject({ execution: kind, cleanup: 'verified' });
    expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
  });

  it.each(['stop', 'collect', 'destroy'] as const)('rejects late cancellation during %s even after successful execution', async stage => {
    const f = await fixture(), controller = new AbortController();
    const original = f.runtime[stage].bind(f.runtime);
    if (stage === 'collect') f.runtime.collect = async () => { controller.abort(); return await (original as CodexWorkspaceRuntime['collect'])(limits); };
    else if (stage === 'stop') f.runtime.stop = async () => { controller.abort(); return await (original as CodexWorkspaceRuntime['stop'])(); };
    else f.runtime.destroy = async () => { controller.abort(); return await (original as CodexWorkspaceRuntime['destroy'])(); };
    const outcome = rejected(await f.adapter().review(f.input, controller.signal), 'runtime');
    expect(outcome.runtimeResult).toMatchObject({ execution: 'succeeded', cleanup: 'verified' });
    expect(outcome.error).toContain('cancelled'); expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
  });
});

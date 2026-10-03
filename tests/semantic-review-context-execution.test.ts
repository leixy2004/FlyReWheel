import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { captureChangeSnapshot } from '../src/change-snapshot.js';
import { captureRepositoryContext, validateRepositoryContext, makeRepositoryContextAnchor, makeRepositoryContextEvidence,
  type StoredRepositoryContext } from '../src/repository-context.js';
import { makeSnapshotAnchor, makeReviewEvidence } from '../src/adapters/semantic-review-fixture.js';
import { buildSemanticReview, validateSemanticReview } from '../src/semantic-review.js';
import { SemanticReviewExecutionReceiptSchema } from '../src/core/semantic-review-execution.js';
import { buildSemanticReviewModelInput, buildSemanticReviewWorkspaceRequest, validateSemanticReviewExecution,
  validateSemanticReviewModelResponse, type SemanticReviewModelInput } from '../src/semantic-review-execution.js';
import { createSemanticReviewWorkspaceModelAdapter } from '../src/adapters/semantic-review-model.js';
import { prepareWorkspace } from '../src/workspace/index.js';
import { workspaceGit } from '../src/workspace/process.js';
import type { CodexWorkspaceBackend, CodexWorkspaceRuntime } from '../src/workspace/codex-runner.js';
import { SemanticReviewWorkspaceWorkerResult, type ContextSemanticReviewWorkspaceWorkerResult } from '../src/workspace/worker-protocol.js';
import { capturedSide, semanticInputs } from './helpers/semantic-review-fixture.js';

const config = { enabled: true, model: 'authored-executor-no-model' };
const limits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
let root: string, count = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'semantic-context-execution-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = join(root, String(++count)), repoPath = join(directory, 'repo');
  await mkdir(join(repoPath, 'src'), { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Fixture'); await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  const before = 'function run() { return 0; }\n', after = 'function run() { dangerousRead(); }\n';
  const policy = '\ufeff// Policy: α😀\r\nPrivileged reads require authorization.\r\n';
  await writeFile(join(repoPath, 'policy.txt'), policy); await writeFile(join(repoPath, 'test-policy.txt'), 'Authored unchanged contract test.\n');
  await writeFile(join(repoPath, 'src/sample.ts'), before);
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored before'); const base = await git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'src/sample.ts'), after); await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'authored after');
  const head = await git(repoPath, 'rev-parse', 'HEAD'), { rule } = semanticInputs({ before, after, assets: [] });
  const snapshot = await captureChangeSnapshot({ repositoryPath: repoPath, repositoryId: 'synthetic:review', baseTip: base, head });
  const capture = async (path: string): Promise<StoredRepositoryContext> => {
    const { digest, context } = await captureRepositoryContext({ repositoryPath: repoPath, repositoryId: 'synthetic:review', head, paths: [path] });
    return { digest, context };
  };
  const repositoryContexts = await Promise.all(['policy.txt', 'test-policy.txt'].map(capture));
  const workspace = { repoPath, runId: 'review', attemptId: 'context' }; await prepareWorkspace({ ...workspace, baseSha: head });
  const input: SemanticReviewModelInput = { rule, snapshot, repositoryContexts,
    context: { kind: 'full-repository', repository: 'synthetic:review', checkout: 'after', workspace } };
  const target = buildSemanticReview({ rule, snapshot }).coverage.targets[0];
  const start = after.indexOf('dangerousRead()'), anchor = makeSnapshotAnchor(snapshot, 'after', target.path, start, start + 'dangerousRead()'.length);
  const targetEvidence = makeReviewEvidence(snapshot, anchor, 'changed-source');
  const contextEvidence = makeRepositoryContextEvidence(repositoryContexts[0], makeRepositoryContextAnchor(repositoryContexts[0], 'policy.txt', 0, policy.length), 'local-policy');
  const evidenceRefs = [targetEvidence.id, contextEvidence.id];
  const value = { ruleDigest: rule.digest, snapshotDigest: snapshot.digest,
    repositoryContextDigests: repositoryContexts.map(value => value.digest).sort(), evidence: [targetEvidence, contextEvidence],
    judgments: [{ targetId: target.id, decision: 'violation' as const, reasoning: 'Authored changed-source and selected-policy fixture.', evidenceRefs, missingContext: [],
      anchorJudgments: [{ anchor, decision: 'violation' as const, reasoning: 'Authored independent anchor fixture.', evidenceRefs, missingContext: [] }] }] };
  const envelope: ContextSemanticReviewWorkspaceWorkerResult = { protocolVersion: 2, outputContract: 'semantic-review-v3', value,
    usage, sessionId: 'authored-session', processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true },
    boundary: 'authored-test-no-isolation' };
  const calls: string[] = [];
  const runtime: CodexWorkspaceRuntime = {
    async prepare() { calls.push('prepare'); return { expectedSha: head, headSha: head, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
    async execute() { calls.push('execute'); return envelope; },
    async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
    async collect() { calls.push('collect'); return []; },
    async destroy() { calls.push('destroy'); return { destroyed: true, verified: true }; },
  };
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(request) {
    expect(request).toMatchObject({ expectedSha: head, outputContract: 'semantic-review-v3' }); calls.push('reserve'); return runtime;
  } };
  const adapter = () => createSemanticReviewWorkspaceModelAdapter(config, { id: 'authored-context-runtime', backend, limits });
  return { repoPath, rule, snapshot, repositoryContexts, input, target, value, envelope, targetEvidence, contextEvidence, runtime, calls, adapter };
}

describe('selected repository context execution contract (authored local Git only)', () => {
  it('preserves the exact per-anchor-v3 generation, prompt and request bytes when contexts are absent', () => {
    const { rule, snapshot } = semanticInputs();
    const input: SemanticReviewModelInput = { rule, snapshot, context: { kind: 'full-repository', repository: snapshot.snapshot.repository.id,
      checkout: 'after', workspace: { repoPath: '/tmp/legacy-proof', runId: 'legacy-proof', attemptId: 'one' } } };
    const prepared = buildSemanticReviewModelInput(input, { model: 'authored-no-model' });
    expect(prepared.judgmentContract).toBe('per-anchor-v3');
    expect(digestOf(prepared.generation)).toBe('6097ffb7a1872a75c779fbe59f909b6644df09a373cc28327296b751976d354a');
    expect(digestOf(prepared.generation.prompt)).toBe('7d55137b610264698e0b84d7200c7cc08d3256741aaedec7f440d03abe39c4c0');
    expect(digestOf(buildSemanticReviewWorkspaceRequest(prepared, limits))).toBe('c737b978fb334e9ccc0f240f3f2009bd3ffb75c875661ad9b8b1032bead9fb70');
    expect(() => buildSemanticReviewModelInput({ ...input, repositoryContexts: [] }, { model: 'authored-no-model' })).toThrow();
    expect(prepared).not.toHaveProperty('repositoryContexts');
    expect(() => buildSemanticReviewModelInput(input, config, 'per-anchor-context-v4')).toThrow('nonempty selected');
  });

  it('selects v4 only for a bounded nonempty frozen selection and binds full package bytes in canonical order', async () => {
    const f = await fixture(), prepared = buildSemanticReviewModelInput(f.input, config);
    expect(prepared.judgmentContract).toBe('per-anchor-context-v4');
    expect(buildSemanticReviewWorkspaceRequest(prepared, limits).outputContract).toBe('semantic-review-v3');
    expect(prepared.repositoryContexts!.map(value => value.digest)).toEqual(f.value.repositoryContextDigests);
    const payload = JSON.parse(prepared.generation.prompt.split('\n\n')[1]);
    expect(payload.task).toBe('review_semantic_rule_v4');
    expect(payload.untrustedEvidence.repositoryContexts).toEqual(prepared.repositoryContexts);
    expect(payload.untrustedEvidence.repositoryContextDigests).toEqual(f.value.repositoryContextDigests);
    expect(prepared.generation.prompt).toContain('Full-repository inspection cannot expand that selection');
    expect(prepared.generation.prompt).toContain('independently cite after-side snapshot evidence from its own exact target');
    expect(Object.isFrozen(prepared.repositoryContexts![0].context.entries)).toBe(true);
    expect(buildSemanticReviewModelInput({ ...f.input, repositoryContexts: [...f.repositoryContexts].reverse() }, config).generation).toEqual(prepared.generation);
    expect(() => buildSemanticReviewModelInput(f.input, config, 'per-anchor-v3')).toThrow('legacy contracts forbid');
    expect(() => buildSemanticReviewModelInput({ ...f.input, repositoryContexts: [...f.repositoryContexts, f.repositoryContexts[0]] }, config)).toThrow();
    const prior = prepared.generation.prompt;
    f.repositoryContexts[0].context.entries[0].path = 'mutated.txt';
    expect(prepared.generation.prompt).toBe(prior);
    expect(payload.untrustedEvidence.repositoryContexts[0].context.entries[0].path).not.toBe('mutated.txt');
  });

  it('validates the exact selected digest set and never permits context anchors to become changed targets', async () => {
    const f = await fixture(), prepared = buildSemanticReviewModelInput(f.input, config);
    expect(validateSemanticReviewModelResponse(prepared, f.value)).toEqual(f.value);
    for (const repositoryContextDigests of [[], [f.value.repositoryContextDigests[0]], [...f.value.repositoryContextDigests].reverse(),
      [f.value.repositoryContextDigests[0], f.value.repositoryContextDigests[0]], [...f.value.repositoryContextDigests, 'f'.repeat(64)].sort()]) {
      expect(() => validateSemanticReviewModelResponse(prepared, { ...f.value, repositoryContextDigests })).toThrow();
    }
    const movedTarget = structuredClone(f.value) as unknown as { judgments: { anchorJudgments: { anchor: unknown }[] }[] };
    movedTarget.judgments[0].anchorJudgments[0].anchor = f.contextEvidence.anchor;
    expect(() => validateSemanticReviewModelResponse(prepared, movedTarget)).toThrow();
    const contextOnly = structuredClone(f.value); contextOnly.judgments[0].evidenceRefs = [f.contextEvidence.id];
    expect(() => validateSemanticReviewModelResponse(prepared, contextOnly)).toThrow('after-side snapshot evidence');
    const legacy = buildSemanticReviewModelInput({ ...f.input, repositoryContexts: undefined }, config);
    expect(() => validateSemanticReviewModelResponse(legacy, f.value)).toThrow();
    expect(SemanticReviewWorkspaceWorkerResult.safeParse({ ...f.envelope, outputContract: 'semantic-review-v2' }).success).toBe(false);
  });

  it('checks local Git before allocation, binds selection through receipts, and validates without rereading workspaces', async () => {
    const f = await fixture(), outcome = await f.adapter().review(f.input);
    expect(outcome).toMatchObject({ execution: 'succeeded', origin: 'authored-test', modelExecution: 'not_run' });
    if (outcome.execution !== 'succeeded') throw new Error(JSON.stringify(outcome));
    const receipt = outcome.review.executionReceipt!;
    expect(receipt).toMatchObject({ judgmentContract: 'per-anchor-context-v4', repositoryContextDigests: f.value.repositoryContextDigests,
      repositoryContextCheck: 'exact-local-git-recapture-matched', workerResult: { outputContract: 'semantic-review-v3' } });
    expect(outcome.review.repositoryContexts).toEqual(buildSemanticReviewModelInput(f.input, config).repositoryContexts);
    expect(outcome.review.findings).toMatchObject([{ status: 'violation', origin: 'fixture' }]);
    expect(validateSemanticReviewExecution(receipt, f.rule, f.snapshot, [...f.repositoryContexts].reverse())).toEqual(f.value);
    expect(() => validateSemanticReviewExecution(receipt, f.rule, f.snapshot)).toThrow('nonempty selected');
    expect(() => validateSemanticReviewExecution(receipt, f.rule, f.snapshot, [f.repositoryContexts[0]])).toThrow('context binding mismatch');
    for (const key of ['repositoryContextDigests', 'repositoryContextCheck'] as const) {
      const altered = structuredClone(receipt); delete altered[key];
      expect(SemanticReviewExecutionReceiptSchema.safeParse(altered).success).toBe(false);
    }
    expect(SemanticReviewExecutionReceiptSchema.safeParse({ ...receipt, repositoryContextDigests: ['f'.repeat(64)] }).success).toBe(false);
    expect(SemanticReviewExecutionReceiptSchema.safeParse({ ...receipt, judgmentContract: 'per-anchor-v3' }).success).toBe(false);
    await rm(f.repoPath, { recursive: true, force: true });
    expect(validateSemanticReview(outcome.review, f.rule, f.snapshot)).toEqual(outcome.review);
    expect(f.calls).toEqual(['reserve', 'prepare', 'execute', 'stop', 'collect', 'destroy']);
  });

  it('rejects internally consistent fabricated selected context at local Git verification before any runtime allocation', async () => {
    const f = await fixture(), context = structuredClone(f.repositoryContexts[0].context);
    const forged = capturedSide('policy.txt', 'Fabricated bytes claim authorization.\n');
    context.entries = [forged]; context.coverage.capturedBytes = forged.byteLength;
    const fabricated = validateRepositoryContext(context);
    const input = { ...f.input, repositoryContexts: [fabricated, f.repositoryContexts[1]] };
    expect(() => buildSemanticReviewModelInput(input, config)).not.toThrow();
    expect(await f.adapter().review(input)).toMatchObject({ execution: 'failed', stage: 'input', review: null,
      error: 'Repository context does not match the exact local Git commit/path bindings' });
    expect(f.calls).toEqual([]);
  });

  it('recaptures every selected package even when the response does not cite it', async () => {
    const f = await fixture(), context = structuredClone(f.repositoryContexts[1].context), entry = context.entries[0];
    if (entry.state !== 'captured') throw new Error('Authored fixture missing captured entry');
    entry.mode = '100755';
    const input = { ...f.input, repositoryContexts: [f.repositoryContexts[0], validateRepositoryContext(context)] };
    expect(() => buildSemanticReviewModelInput(input, config)).not.toThrow();
    expect(await f.adapter().review(input)).toMatchObject({ execution: 'failed', stage: 'input', review: null,
      error: 'Repository context does not match the exact local Git commit/path bindings' });
    expect(f.calls).toEqual([]);
  });

  it('rejects snapshot-only worker output when context-aware output was requested', async () => {
    const f = await fixture();
    const { repositoryContextDigests, ...legacyValue } = f.value;
    f.runtime.execute = async () => ({ ...f.envelope, outputContract: 'semantic-review-v2', value: { ...legacyValue,
      evidence: [f.targetEvidence], judgments: [] } });
    expect(await f.adapter().review(f.input)).toMatchObject({ execution: 'failed', stage: 'output', review: null,
      error: 'Review worker output contract does not match requested judgment contract' });
  });
});

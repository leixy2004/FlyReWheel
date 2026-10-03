import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJson, digestOf } from '../src/core/identity.js';
import { ComparisonApplicabilityExecutionReceiptSchema } from '../src/core/comparison-applicability-execution.js';
import { createComparisonApplicabilityWorkspaceModelAdapter, readTrustedComparisonApplicability,
  type ComparisonApplicabilityWorkspaceOutcome, type TrustedComparisonApplicability } from '../src/adapters/comparison-applicability-model.js';
import { buildComparisonApplicabilityModelInput, buildComparisonApplicabilityWorkspaceRequest,
  validateComparisonApplicabilityExecution } from '../src/comparison-applicability-execution.js';
import { runWorkspaceWorkerCommand } from '../src/workspace-worker-entrypoint.js';
import { cleanupWorkspace } from '../src/workspace/index.js';
import { QualEvoStore } from '../src/storage/store.js';
import { revisionConfig, revisionLimits, revisionUsage } from './helpers/revision-generation-fixture.js';
import { comparisonApplicabilityWorkspaceFixture } from './helpers/comparison-applicability-workspace-fixture.js';

// Each fixture captures real local Git objects and opens a fresh embedded database.
vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(withContext = false) { const f = await comparisonApplicabilityWorkspaceFixture(withContext); cleanup.push(f.cleanup); return f; }
function accepted(value: ComparisonApplicabilityWorkspaceOutcome) {
  expect(value, JSON.stringify(value)).toMatchObject({ execution: 'succeeded', modelExecution: 'not_run', origin: 'authored-test' });
  if (value.execution !== 'succeeded') throw new Error('Expected accepted authored applicability');
  return value;
}

it('binds the exact frozen selected input with bounded prompt and fixed no-tools output', async () => {
  const f = await fixture(true), prepared = buildComparisonApplicabilityModelInput(f.input, revisionConfig);
  const prompt = JSON.parse(prepared.generation.prompt.slice(prepared.generation.prompt.indexOf('\n\n') + 2));
  expect(prompt.untrustedEvidence).toEqual(f.selected);
  expect(prompt.bindingDigest).toBe(digestOf(f.selected.binding));
  expect(buildComparisonApplicabilityModelInput(JSON.parse(canonicalJson(f.input)), revisionConfig)).toEqual(prepared);
  expect(prepared.generation.prompt).not.toContain(f.repoPath);
  expect(Object.isFrozen(prepared.input.repositoryContexts)).toBe(true);
  expect(buildComparisonApplicabilityWorkspaceRequest(prepared, revisionLimits)).toMatchObject({
    outputContract: 'comparison-applicability-v1', toolPolicy: 'selected-evidence-no-tools-v1', expectedSha: f.head });
  expect(() => buildComparisonApplicabilityModelInput(f.input, { model: revisionConfig.model,
    limits: { maxInputBytes: 1, maxOutputBytes: 1000, timeoutMs: 1000 } })).toThrow(/byte limit/);
  expect(() => buildComparisonApplicabilityWorkspaceRequest(prepared, { ...revisionLimits, timeoutMs: 30_001 })).toThrow(/adapter limits/);
  expect(() => buildComparisonApplicabilityWorkspaceRequest(prepared, { ...revisionLimits, maxInputBytes: 1 })).toThrow(/byte limit/);
  expect(() => buildComparisonApplicabilityModelInput({ ...f.input, context: { ...f.input.context, repository: 'wrong' } }, revisionConfig)).toThrow(/repository/);
});

it('does not validate inputs or reserve runtime for disabled, unavailable or pre-cancelled paths', async () => {
  const f = await fixture(), invalid = {} as typeof f.input;
  expect(await createComparisonApplicabilityWorkspaceModelAdapter({ ...revisionConfig, enabled: false }, f.dependency).adjudicate(invalid))
    .toMatchObject({ execution: 'not_run', reason: 'disabled' });
  expect(await createComparisonApplicabilityWorkspaceModelAdapter(revisionConfig).adjudicate(invalid))
    .toMatchObject({ execution: 'not_run', reason: 'runtime_unavailable' });
  expect(await f.adapter().adjudicate(invalid, AbortSignal.abort())).toMatchObject({ execution: 'not_run', reason: 'cancelled' });
  expect(f.calls).toEqual([]);
});

it('accepts only completed cleanup, preserves context recapture and rejects JSON/copy capabilities', async () => {
  const f = await fixture(true), outcome = accepted(await f.adapter().adjudicate(f.input));
  expect(outcome.adjudication.receipt).toMatchObject({ expectedSha: f.head, binding: f.selected.binding,
    snapshotCheck: 'exact-local-git-recapture-matched', repositoryContextCheck: 'exact-local-git-recapture-matched',
    modelExecution: 'not_run', cleanup: 'verified', toolPolicy: 'selected-evidence-no-tools-v1' });
  expect(f.calls).toEqual(['reserve', 'prepare', 'execute', 'stop', 'collect', 'destroy']);
  expect(readTrustedComparisonApplicability(outcome.persistence)).toBe(outcome.adjudication);
  for (const forged of [outcome.adjudication, {}, null, structuredClone(outcome.persistence)]) {
    expect(() => readTrustedComparisonApplicability(forged as TrustedComparisonApplicability)).toThrow(/trusted runtime capability/);
  }
  expect(() => { outcome.adjudication.receipt.workerResult.value.reasoning = 'changed'; }).toThrow();
  expect(validateComparisonApplicabilityExecution(outcome.adjudication.receipt, f.comparison)).toEqual(f.value);
  expect(ComparisonApplicabilityExecutionReceiptSchema.safeParse({ ...outcome.adjudication.receipt, modelExecution: 'completed' }).success).toBe(false);
});

it('rederives every receipt digest and rejects contract, lifecycle, result and process substitutions', async () => {
  const f = await fixture(), outcome = accepted(await f.adapter().adjudicate(f.input)), original = outcome.adjudication.receipt;
  for (const field of ['inputDigest', 'generationDigest', 'promptDigest', 'responseDigest', 'workspaceRequestDigest', 'runtimeResultDigest'] as const) {
    const receipt = structuredClone(original); receipt[field] = 'f'.repeat(64);
    expect(() => validateComparisonApplicabilityExecution(receipt, f.comparison)).toThrow(/binding/);
  }
  for (const change of [
    (r: typeof original) => { r.binding.feedbackId = 'other'; },
    (r: typeof original) => { r.binding.findingDigest = 'f'.repeat(64); },
    (r: typeof original) => { r.model = 'other'; },
    (r: typeof original) => { r.workerResult.sessionId = 'other'; },
    (r: typeof original) => { r.workerResult.value.decision = 'APPLICABLE'; },
    (r: typeof original) => { r.workerResult.processEvidence.reason = 'timeout'; },
    (r: typeof original) => { r.workerResult.processEvidence.processGroupStopped = false; },
    (r: typeof original) => { r.workerResult.processEvidence.exitCode = 1; },
    (r: typeof original) => { r.workerResult.processEvidence.stdoutBytes = revisionLimits.maxOutputBytes + 1; },
    (r: typeof original) => { r.lifecycle.pop(); },
  ]) { const receipt = structuredClone(original); change(receipt); expect(() => validateComparisonApplicabilityExecution(receipt, f.comparison)).toThrow(); }
});

it('captures caller input before asynchronous runtime execution and preserves unresolved output', async () => {
  const f = await fixture(true), mutable = structuredClone(f.input);
  f.value.missingContext.push('An unresolved semantic policy requirement');
  f.runtime.execute = async () => { mutable.comparison.request.request.requestedChange = 'mutated after preparation'; return f.envelope; };
  const outcome = accepted(await f.adapter().adjudicate(mutable));
  expect(validateComparisonApplicabilityExecution(outcome.adjudication.receipt, f.comparison).missingContext).toEqual(f.value.missingContext);
  expect(outcome.adjudication.binding).toEqual(f.selected.binding);
});

it.each(['boundary', 'contract', 'incomplete', 'binding', 'invalid-evidence'] as const)('rejects %s worker output without a capability', async kind => {
  const f = await fixture();
  const output = structuredClone(f.envelope);
  if (kind === 'boundary') output.boundary = 'isolated-runtime';
  if (kind === 'contract') Object.assign(output, { outputContract: 'semantic-review-v2' });
  if (kind === 'incomplete') output.processEvidence.processGroupStopped = false;
  if (kind === 'binding') output.value.bindingDigest = 'f'.repeat(64);
  if (kind === 'invalid-evidence') output.value.evidence[0].content = 'forged';
  f.runtime.execute = async () => output;
  const outcome = await f.adapter().adjudicate(f.input);
  expect(outcome).toMatchObject({ execution: 'failed', modelExecution: 'not_run', stage: 'output', adjudication: null });
  expect(outcome).not.toHaveProperty('persistence');
  expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
});

it('rejects a snapshot imported from an unrelated local Git history before runtime reservation', async () => {
  const f = await fixture(), other = await fixture(true);
  const outcome = await f.adapter().adjudicate({ ...f.input, context: { ...f.input.context, workspace: other.workspace } });
  expect(outcome).toMatchObject({ execution: 'failed', stage: 'input', adjudication: null });
  expect(f.calls).toEqual([]);
});

it('does not mint a capability when runtime cleanup cannot be verified', async () => {
  const f = await fixture(); f.runtime.stop = async () => ({ stopped: false, verified: false });
  const outcome = await f.adapter().adjudicate(f.input);
  expect(outcome).toMatchObject({ execution: 'failed', stage: 'runtime', runtimeResult: { cleanup: 'retained-for-recovery' } });
  expect(outcome).not.toHaveProperty('persistence');
});

it('rejects cancellation during local verification or after execution before judgment acceptance', async () => {
  const f = await fixture(), beforeRuntime = new AbortController();
  const pending = f.adapter().adjudicate(f.input, beforeRuntime.signal); beforeRuntime.abort();
  expect(await pending).toMatchObject({ execution: 'failed', stage: 'input', adjudication: null });
  expect(f.calls).toEqual([]);
  const duringCleanup = new AbortController();
  f.runtime.stop = async () => { duringCleanup.abort(); return { stopped: true, verified: true }; };
  const outcome = await f.adapter().adjudicate(f.input, duringCleanup.signal);
  expect(outcome).toMatchObject({ execution: 'failed', adjudication: null });
  expect(outcome).not.toHaveProperty('persistence');
  expect(f.calls).toContain('destroy');
});

it('persists authored SDK applicability with its live capability and reopens after the workspace is gone', async () => {
  const f = await fixture(true), executable = join(f.directory, 'applicability-cli.cjs'), requestPath = join(f.directory, 'applicability-request.json');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));send({type:'thread.started',thread_id:'authored-applicability-sdk'});send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(f.value)})}});send({type:'turn.completed',usage:${JSON.stringify(revisionUsage)}});});`, { mode: 0o700 });
  f.backend.reserve = (request, workspace) => {
    f.runtime.execute = async signal => {
      await writeFile(requestPath, JSON.stringify({ workingDirectory: workspace.worktreePath, model: request.model, prompt: request.prompt,
        outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits }));
      return JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: f.directory,
        workingDirectory: workspace.worktreePath, requestPath, codexPathOverride: executable,
        imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } } }, signal));
    }; return f.runtime;
  };
  const outcome = accepted(await f.adapter().adjudicate(f.input));
  const input = { id: 'workspace-applicability', requestDigest: f.request.digest, candidateRuleDigest: f.candidateRule.digest,
    reviewPairs: [{ baseReviewId: f.baseReview.id, candidateReviewId: f.candidateReview.id }], caseBindings: [],
    applicability: { policyVersion: 'selected-finding-applicability-v1' as const, adjudications: [outcome.adjudication] } };
  await expect(f.store.createRevisionComparison(input)).rejects.toThrow(/capabilit/);
  const saved = await f.store.createRevisionComparison(input, [outcome.persistence]);
  expect(saved.comparison).toMatchObject({ scorer: 'scope-applicability-v5', feedback: [{ outcome: 'corrected' }],
    trust: { semanticEvidence: 'includes-workspace-execution-receipts' } });
  expect((await cleanupWorkspace(f.workspace)).record.status).toBe('closed-clean');
  await rm(f.repoPath, { recursive: true, force: true }); await f.closeStore();
  const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db'));
  try {
    expect(await reopened.getRevisionComparison(saved.digest)).toEqual(saved);
    expect(await reopened.createRevisionComparison(input)).toEqual(saved);
    await expect(reopened.createRevisionComparison({ ...input, id: 'new-imported-receipt' })).rejects.toThrow(/capabilit/);
  }
  finally { await reopened.close(); }
}, 30_000);

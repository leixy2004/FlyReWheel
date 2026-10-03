import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digestOf } from '../src/core/identity.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import { initialMemory, validatePacket, validateProposal } from '../experiments/matched-revision/validation.js';
import { renderState } from '../experiments/matched-revision/prompts.js';
import { evaluateGate, observations, scoreFuture } from '../experiments/matched-revision/scoring.js';
import type { AuthoredTransport, Judgment, ModelRequest, Proposal, TargetInput } from '../experiments/matched-revision/contracts.js';

type Fixture = ReturnType<typeof createMatchedFixture>;
const seal = (f: Fixture) => { f.packet.digest = digestOf(f.packet.episode); f.future.digest = digestOf(f.future.cases); return f; };
const run = (f: Fixture) => runMatchedRevision({ mode: 'authored_fixture', ...seal(f) });
function mutateResponse(f: Fixture, mutate: (output: any, request: ModelRequest) => void) {
  const original = f.transport.execute;
  f.transport.execute = async (request, signal) => { const result = await original(request, signal); mutate(result.output, request); return result; };
}
const isHard = (request: ModelRequest) => request.prompt.includes('EDIT_POLICY=Apply diagnosis-operators-v1');
const isUnrestricted = (request: ModelRequest) => request.prompt.includes('Return retain, abstain, request_context or revise. You may revise');
function nonMutation(proposal: Proposal, action: 'retain' | 'abstain' | 'request_context'): Proposal {
  return { ...proposal, action, state: null, replacement: null, nextStep: 'Inspect the frozen finding before further action' };
}

it('runs a complete matched fixture without pretending to run models or favoring a baseline', async () => {
  const f = createMatchedFixture(), before = digestOf({ packet: f.packet, future: f.future });
  const report = await run(f);
  expect(report.execution).toBe('completed');
  if (report.execution !== 'completed') throw new Error('Expected fixture completion');
  expect(report).toMatchObject({ modelExecution: 'not_run', empiricalEpisodes: 0, independentHumanAnnotations: 0 });
  expect(report.arms.map(a => a.arm)).toEqual(['U', 'F', 'M', 'H']);
  expect(report.arms.every(a => a.gate.passed && a.metrics.scheduledTargets === 3)).toBe(true);
  expect(report.arms.map(a => a.disposition)).toEqual(['changed', 'frozen_reference', 'changed', 'changed']);
  expect(report.arms.map(a => a.usage.transportCalls)).toEqual([3, 2, 3, 3]);
  expect(report.arms.every(a => a.usage.modelCalls === 0 && a.usage.retries === 0)).toBe(true);
  expect(new Set(report.arms.map(a => a.commonRevisionInputDigest)).size).toBe(1);
  expect(new Set(report.arms.map(a => a.sharedDiagnosisDigest)).size).toBe(1);
  expect(new Set(report.arms.map(a => JSON.stringify(a.metrics)))).toHaveProperty('size', 1);
  const u = report.arms.find(a => a.arm === 'U')!, h = report.arms.find(a => a.arm === 'H')!;
  expect(u.effectiveState).toEqual(h.effectiveState);
  expect(before).toBe(digestOf({ packet: f.packet, future: f.future }));
});

it.each([undefined, 'high'] as const)('gives byte-identical revision evidence/settings with reasoning effort %s to all updaters and excludes future bytes/labels', async modelReasoningEffort => {
  const f = createMatchedFixture();
  if (modelReasoningEffort !== undefined) f.packet.episode.settings.modelReasoningEffort = modelReasoningEffort;
  const originalSettings = structuredClone(f.packet.episode.settings);
  f.future.cases[0].input.evidence[0].content += ' SECRET_FUTURE_SENTINEL';
  f.future.cases[0].labelRecordDigest = digestOf('withheld-label-sentinel');
  const report = await run(f);
  const proposals = report.arms.flatMap(a => a.calls.filter(c => c.stage === 'proposal'));
  const blocks = proposals.map(c => c.request.prompt.split('\nCOMMON_INPUT=')[1].split('\nEDIT_POLICY=')[0]);
  expect(new Set(blocks).size).toBe(1);
  expect(proposals.every(c => !c.request.prompt.includes('SECRET_FUTURE_SENTINEL') && !c.request.prompt.includes(f.future.cases[0].labelRecordDigest))).toBe(true);
  expect(new Set(proposals.map(c => JSON.stringify(c.request.outputSchema))).size).toBe(1);
  expect(new Set(proposals.map(c => JSON.stringify([c.request.model, c.request.sampler, c.request.maxOutputTokens, c.request.modelReasoningEffort]))).size).toBe(1);
  expect(f.packet.episode.settings).toEqual(originalSettings);
  for (const arm of report.arms) for (const call of arm.calls) {
    expect(call.request.modelReasoningEffort).toBe(modelReasoningEffort);
    expect(call.request.sampler).toEqual(originalSettings.sampler);
    expect(call.request.model).toBe(call.stage === 'proposal' ? originalSettings.revisionModel : originalSettings.reviewerModel);
    expect(call.request.maxOutputTokens).toBe(call.stage === 'proposal' ? originalSettings.limits.revisionOutputTokens : originalSettings.limits.reviewOutputTokens);
    if (modelReasoningEffort === undefined) expect(call.request).not.toHaveProperty('modelReasoningEffort');
  }
  for (const arm of report.arms) for (const call of arm.calls.filter(c => c.stage !== 'proposal')) {
    expect(call.request.prompt).not.toContain('Authored candidate used equally');
    expect(call.request.prompt).not.toContain('frozenDiagnosis');
    expect(call.request.prompt).not.toContain('evidenceRecordDigest');
    expect(call.request.prompt).not.toContain('labelRecordDigest');
    const reviewInput = JSON.parse(call.request.prompt.split('\nINPUT=')[1]);
    expect(reviewInput.targets.every((target: object) => !('expected' in target) && !('label' in target))).toBe(true);
  }
});

it('keeps U unrestricted while H rejects the same protected-field edit', async () => {
  const f = createMatchedFixture();
  mutateResponse(f, (output, request) => {
    if (request.stage === 'proposal' && output.state.kind === 'structured') output.state.content.semantics.invariant = 'A revised invariant';
  });
  const report = await run(f), u = report.arms.find(a => a.arm === 'U')!, h = report.arms.find(a => a.arm === 'H')!;
  expect(u).toMatchObject({ disposition: 'changed', acceptedChange: true });
  expect(h).toMatchObject({ disposition: 'policy_invalid', acceptedChange: false });
  expect(h.proposalError).toContain('preserve invariant');
  expect(h.effectiveStateDigest).toBe(h.incumbentStateDigest);
  expect(h.calls.filter(c => c.stage === 'proposal' && c.invoked)).toHaveLength(1);
  expect(h.future).toHaveLength(f.future.cases.length);
});

it.each(['judgment', 'context', 'boundary', 'mixed', 'insufficient_evidence'] as const)(
  'honors frozen %s diagnosis instead of allowing updater relabeling', async category => {
    const f = createMatchedFixture();
    const diagnosis = f.packet.episode.diagnosis.diagnoses[0]; diagnosis.category = category;
    if (category === 'insufficient_evidence') diagnosis.missingEvidence = ['Original evidence missing'];
    const hardAction = category === 'judgment' ? 'retain' : category === 'context' ? 'request_context' : 'abstain';
    mutateResponse(f, (output, request) => {
      if (request.stage === 'proposal' && isHard(request)) Object.assign(output, nonMutation(f.proposal, hardAction));
    });
    const report = await run(f), h = report.arms.find(a => a.arm === 'H')!;
    expect(h.disposition).toBe(hardAction === 'retain' ? 'retained' : hardAction === 'request_context' ? 'context_requested' : 'abstained');
    expect(h.effectiveStateDigest).toBe(h.incumbentStateDigest);
    expect(h.contextRequestFulfilled).toBe(false); expect(h.reviewRepairExecuted).toBe(false);
    expect(report.arms.find(a => a.arm === 'U')!.disposition).toBe('changed');
  });

it('rejects boundary retention while U and M may retain without making fake edits', async () => {
  const f = createMatchedFixture();
  mutateResponse(f, (output, request) => { if (request.stage === 'proposal') Object.assign(output, nonMutation(f.proposal, 'retain')); });
  const report = await run(f);
  expect(report.arms.find(a => a.arm === 'U')!.disposition).toBe('retained');
  expect(report.arms.find(a => a.arm === 'M')!.disposition).toBe('retained');
  expect(report.arms.find(a => a.arm === 'H')!.disposition).toBe('policy_invalid');
  expect(report.arms.every(a => a.actualChangedCandidates === 0 && a.metrics.scheduledTargets === 3)).toBe(true);
});

it('exercises inferred contract replacement without converting it into a boundary diagnosis', async () => {
  const f = createMatchedFixture(), e = f.packet.episode;
  e.diagnosis.condition = 'inferred'; e.diagnosis.provenance.upstreamCalls = 1;
  e.diagnosis.provenance.upstreamModel = 'authored-inference-placeholder'; e.diagnosis.diagnoses[0].category = 'contract';
  mutateResponse(f, (output, request) => {
    if (request.stage !== 'proposal' || !isHard(request)) return;
    output.state.content.semantics.invariant = 'Replacement capability contract';
    output.replacement = { priorRuleDigest: e.revision.baseRule.digest, previousContract: 'Guard-based contract', proposedContract: 'Capability-based contract',
      evidenceRefs: f.proposal.evidenceRefs, retirement: { status: 'proposed_requires_review', oldRuleAppliesWhen: 'Old interface',
        replacementAppliesWhen: 'New interface', rationale: 'Authored unverified transition', activation: 'not_performed' } };
  });
  const report = await run(f), h = report.arms.find(a => a.arm === 'H')!;
  expect(h.disposition).toBe('changed'); expect(h.proposal!.replacement!.retirement.activation).toBe('not_performed');
  if (report.execution !== 'completed') throw new Error('Expected fixture completion');
  expect(report.condition).toBe('inferred');
});

it('keeps administrative inferred-diagnosis failure and its cost without another diagnosis call', async () => {
  const f = createMatchedFixture(), d = f.packet.episode.diagnosis;
  d.condition = 'inferred'; d.provenance.origin = 'administrative_failure'; d.provenance.upstreamCalls = 1;
  d.provenance.rawFailure = 'Malformed upstream diagnosis'; d.provenance.inputTokens = 12; d.provenance.outputTokens = 0;
  f.packet.episode.settings.limits.maxCallsPerArm = 4;
  d.diagnoses[0].category = 'insufficient_evidence'; d.diagnoses[0].missingEvidence = ['No valid diagnosis returned'];
  mutateResponse(f, (output, request) => { if (request.stage === 'proposal' && isHard(request)) Object.assign(output, nonMutation(f.proposal, 'abstain')); });
  const report = await run(f);
  if (report.execution !== 'completed') throw new Error('Expected completion');
  expect(report.diagnosisCost).toMatchObject({ upstreamCalls: 1, inputTokens: 12, outputTokens: 0, rawFailure: 'Malformed upstream diagnosis' });
  expect(report.sharedDiagnosis).toEqual(d); expect(report.arms.find(a => a.arm === 'H')!.disposition).toBe('abstained');
});

it.each(['diagnoses', 'labels', 'regressionCases', 'targetRoster', 'provenance'])(
  'rejects arm attempts to write %s rather than silently dropping fields', async field => {
    const f = createMatchedFixture();
    mutateResponse(f, (output, request) => { if (request.stage === 'proposal' && isUnrestricted(request)) output[field] = []; });
    const report = await run(f), u = report.arms.find(a => a.arm === 'U')!;
    expect(u.disposition).toBe('schema_invalid'); expect(u.effectiveStateDigest).toBe(u.incumbentStateDigest);
    expect(u.calls.filter(c => c.stage === 'proposal')).toHaveLength(1); expect(u.future).toHaveLength(3);
  });

it('rejected proposals use the incumbent on every later target without gate-conditioned retry', async () => {
  const f = createMatchedFixture();
  mutateResponse(f, (output, request) => {
    if (request.stage === 'gate') output.judgments[0].prediction = 'safe';
  });
  const report = await run(f);
  for (const arm of report.arms) {
    expect(arm.gate.passed).toBe(false); expect(arm.acceptedChange).toBe(false);
    expect(arm.effectiveStateDigest).toBe(arm.incumbentStateDigest);
    expect(arm.future.map(x => x.targetId)).toEqual(f.future.cases.map(c => c.input.id));
    expect(arm.calls.filter(c => c.stage === 'gate')).toHaveLength(1);
  }
});

it('requires memory initial bytes, one bounded delta, and a representation-neutral gate', async () => {
  const f = createMatchedFixture(), { prepared, episode } = validatePacket(f.packet, f.future);
  expect(renderState(initialMemory(prepared))).toEqual(renderState({ kind: 'structured', content: {
    semantics: f.packet.episode.revision.baseRule.rule.schemaVersion === 2 ? f.packet.episode.revision.baseRule.rule.semantics : {} as never,
    paths: { include: ['src'], exclude: [] }, detectionAssets: [] } }));
  const bad = structuredClone(f.memoryProposal);
  if (bad.state?.kind !== 'scoped_memory') throw new Error('Expected memory');
  bad.state.initialLesson += ' altered'; expect(() => validateProposal(bad, 'M', episode, prepared)).toThrow('exact initial');
  const large = structuredClone(f.memoryProposal);
  if (large.state?.kind !== 'scoped_memory') throw new Error('Expected memory');
  large.state.delta!.text = 'z'.repeat(20_000); expect(() => validateProposal(large, 'M', episode, prepared)).toThrow('common token cap');
  mutateResponse(f, (output, request) => {
    if (request.stage === 'proposal' && output.state.kind === 'scoped_memory') output.state.delta = { operation: 'suppress', text: 'Suppress this lesson pending evidence' };
  });
  const report = await run(f), m = report.arms.find(a => a.arm === 'M')!;
  expect(m.disposition).toBe('changed'); expect(m.future).toHaveLength(3);
  expect(m.calls.find(c => c.stage === 'future')!.request.prompt).toContain('lesson is suppressed');
  expect(m.calls.find(c => c.stage === 'future')!.request.prompt).toContain('initialLesson is audit-only');
});

it('fails closed for production, absent transport, and unavailable usage', async () => {
  const f = createMatchedFixture(), execute = vi.fn(f.transport.execute);
  const transport: AuthoredTransport = { ...f.transport, execute };
  expect(await runMatchedRevision({ mode: 'production', ...f, transport })).toMatchObject({ execution: 'not_run', reason: 'production_adapter_unconfigured', arms: [] });
  expect(execute).not.toHaveBeenCalled();
  expect(await runMatchedRevision({ mode: 'authored_fixture', packet: f.packet, future: f.future })).toMatchObject({ reason: 'authored_transport_required' });
  f.transport.execute = async () => { throw new Error('Injected transport outage'); };
  const report = await run(f);
  expect(report.arms.every(a => a.usage.transportCalls === 1 && !a.usage.usageComplete && a.future.length === 3)).toBe(true);
  expect(report.arms.every(a => a.metrics.positiveRecall.value === 0 && a.metrics.strictLegalResolution.value === 0)).toBe(true);
});

it('retains timeout, invalid-output and budget failures without retry or denominator loss', async () => {
  const f = createMatchedFixture(); f.packet.episode.settings.limits.timeoutMsPerCall = 5;
  f.transport.execute = async () => new Promise(() => {});
  const report = await run(f);
  expect(report.arms.every(a => a.calls[0].status === 'timeout' && a.usage.transportCalls === 1 && a.metrics.scheduledTargets === 3)).toBe(true);
  const budget = createMatchedFixture(); budget.packet.episode.settings.limits.maxCallsPerArm = 1;
  const budgetReport = await run(budget);
  expect(budgetReport.arms.every(a => a.usage.transportCalls === 1 && a.future.every(p => p.prediction === 'unresolved'))).toBe(true);
  const tokens = createMatchedFixture();
  const original = tokens.transport.execute;
  tokens.transport.execute = async (request, signal) => ({ ...await original(request, signal), usage: { inputTokens: 999_999, outputTokens: 1, cachedInputTokens: 0, costMicros: 0 } });
  const tokenReport = await run(tokens);
  expect(tokenReport.arms.every(a => a.calls[0].status === 'budget_exhausted' && a.usage.inputTokens === 999_999 && a.usage.transportCalls === 1)).toBe(true);
});

it('rejects late synchronous callback outputs even when they starve the timeout timer', async () => {
  const f = createMatchedFixture(), original = f.transport.execute;
  f.packet.episode.settings.limits.timeoutMsPerCall = 1;
  f.transport.execute = async (request, signal) => {
    const end = performance.now() + 5; while (performance.now() < end) { /* intentional authored blocking probe */ }
    return original(request, signal);
  };
  const report = await run(f);
  expect(report.arms.every(a => !a.acceptedChange && a.calls.filter(c => c.invoked).every(c => c.status === 'timeout'))).toBe(true);
});

it('charges upstream diagnosis to standalone budgets and preserves unknown accounting', async () => {
  const f = createMatchedFixture(), d = f.packet.episode.diagnosis;
  d.condition = 'inferred'; d.provenance.upstreamCalls = 1; d.provenance.inputTokens = 11;
  const report = await run(f);
  for (const arm of report.arms.filter(a => a.arm !== 'F')) {
    expect(arm.usage.standalone.totalCalls).toBe(3);
    expect(arm.usage.standalone.inputTokensKnownLowerBound).toBe(11);
    expect(arm.calls.find(c => c.stage === 'future')!.invoked).toBe(false);
  }
  d.provenance.costMicros = null;
  const unknown = await run(f);
  for (const arm of unknown.arms.filter(a => a.arm !== 'F')) {
    expect(arm.usage.usageComplete).toBe(false); expect(arm.usage.transportCalls).toBe(0);
    expect(arm.usage.standalone.budgetBlocker).toContain('Upstream diagnosis usage is unknown');
    expect(arm.metrics.scheduledTargets).toBe(3);
  }
});

it('rejects altered packet/labels, gate removal and future lineage/source leakage before any call', async () => {
  for (const change of [
    (f: Fixture) => { f.packet.episode.id = 'tampered'; },
    (f: Fixture) => { f.future.cases[0].label = 'safe_applicable'; },
    (f: Fixture) => { f.packet.episode.gate.shift(); seal(f); },
    (f: Fixture) => { const ref = f.packet.episode.gate[1].obligationRefs.pop()!;
      f.packet.episode.gate[0].obligationRefs.push(ref); seal(f); },
    (f: Fixture) => { f.packet.episode.gate[1].input.issueScope.start = 1; seal(f); },
    (f: Fixture) => { f.future.cases[0].input.lineageId = 'source-a'; seal(f); },
    (f: Fixture) => { f.future.cases[0].input.source = f.packet.episode.gate[0].input.source;
      f.future.cases[0].input.sourceDigest = f.packet.episode.gate[0].input.sourceDigest; seal(f); },
  ]) {
    const f = createMatchedFixture(); const execute = vi.fn(f.transport.execute); f.transport.execute = execute; change(f);
    await expect(runMatchedRevision({ mode: 'authored_fixture', ...f })).rejects.toThrow(); expect(execute).not.toHaveBeenCalled();
  }
});

it('scores silence, unsupported alerts, unknown labels, safe applicability and zero denominators conservatively', () => {
  const f = createMatchedFixture();
  const empty = observations(f.future.cases.map(c => c.input), { judgments: [] }, null);
  expect(scoreFuture(f.future.cases, empty)).toMatchObject({ positiveRecall: { value: 0 }, strictLegalResolution: { value: 0 }, strictBalancedResolution: 0 });
  const judgment = (t: TargetInput, prediction: Judgment['prediction'], evidenceRefs = [t.evidence[0].id]) => ({
    targetId: t.id, prediction, reason: 'judgment', rationale: 'Authored', evidenceRefs, missingEvidence: [] });
  const unsupported = observations(f.future.cases.map(c => c.input), { judgments: f.future.cases.map(c => judgment(c.input, 'violation', ['invented'])) }, null);
  const scores = scoreFuture(f.future.cases, unsupported);
  expect(scores.positiveRecall.value).toBe(0); expect(scores.legalFalseAlarmRate.value).toBe(1); expect(scores.unresolvedReferences).toHaveLength(1);
  expect(scoreFuture(f.future.cases.filter(c => c.label === 'unknown'), [])).toMatchObject({ positiveRecall: { state: 'not_estimable', value: null }, strictBalancedResolution: null });
  const safeCase = { ...f.future.cases[1], label: 'safe_applicable' as const, repeatedFeedbackMechanism: false };
  const notApplicable = observations([safeCase.input], { judgments: [judgment(safeCase.input, 'not_applicable')] }, null);
  expect(scoreFuture([safeCase], notApplicable).safeApplicableResolution.value).toBe(0);
  expect(evaluateGate(f.packet.episode.gate, observations(f.packet.episode.gate.map(g => g.input), { judgments: [] }, null)).passed).toBe(false);
});

it('runs the explicit fixture CLI end to end and refuses implicit production mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matched-cli-'));
  try {
    const directory = join(root, 'output');
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/matched-revision/replay.ts', '--fixture', directory]);
    expect(JSON.parse(stdout)).toMatchObject({ execution: 'completed', modelExecution: 'not_run' });
    const saved = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    expect(saved.arms).toHaveLength(4); expect(saved.empiricalEpisodes).toBe(0);
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/matched-revision/replay.ts', '--production', directory])).rejects.toThrow();
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/matched-revision/replay.ts', '--fixture', directory])).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

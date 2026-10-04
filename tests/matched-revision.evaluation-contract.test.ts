import { describe, expect, it } from 'vitest';
import { canonicalJson, digestOf } from '../src/core/identity.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { freezeAuthoredEvaluationContract, runContractedEvaluation, validateEvaluationContract } from '../experiments/matched-revision/evaluation-contract.js';
import { type ModelRequest, type Observation } from '../experiments/matched-revision/contracts.js';
import { scoreFuture } from '../experiments/matched-revision/scoring.js';

function setup() {
  const f = createMatchedFixture();
  return { ...f, contract: freezeAuthoredEvaluationContract(f.packet, f.future, {
    basis: 'authored-declarations-not-historical-proof', revisionCutoff: '2026-10-02T00:00:00Z',
    futureWindowStart: '2026-10-03T00:00:00Z' }) };
}
describe('minimal matched evaluation contract', () => {
  it('runs existing four-arm authored transport with matched requests and score-only future labels', async () => {
    const f = setup(), requests: ModelRequest[] = [];
    const result = await runContractedEvaluation({ ...f, mode: 'authored_fixture', transport: {
      ...f.transport, async execute(request, signal) {
        requests.push(structuredClone(request)); return f.transport.execute(request, signal);
      } } });
    expect(result.execution).toBe('completed');
    if (!('report' in result) || !result.report) throw Error('Missing completed report');
    expect(result.scientificConclusion).toBe('not_estimated-authored-mechanics-only');
    expect(result.report.arms.map(a => a.usage.transportCalls).sort()).toEqual([2, 3, 3, 3]);
    expect(new Set(result.report.arms.map(a => a.commonRevisionInputDigest)).size).toBe(1);
    expect(new Set(result.report.arms.map(a => a.sharedDiagnosisDigest)).size).toBe(1);
    for (const stage of ['gate', 'future']) {
      const calls = requests.filter(r => r.stage === stage);
      expect(calls).toHaveLength(4);
      const normalized = calls.map(({ prompt, ...settings }) => {
        const input = JSON.parse(prompt.split('\nINPUT=')[1]);
        expect(Object.keys(input).sort()).toEqual(['persistentState', 'targets']);
        expect(input.targets).toEqual(stage === 'gate' ? f.packet.episode.gate.map(g => g.input) : f.future.cases.map(c => c.input));
        return digestOf({ ...settings, prompt: prompt.replace(canonicalJson(input),
          canonicalJson({ ...input, persistentState: '<arm-state>' })) });
      });
      expect(new Set(normalized).size).toBe(1);
    }
    for (const request of requests.filter(r => r.stage === 'proposal')) {
      for (const c of f.future.cases) {
        expect(request.prompt).not.toContain(c.labelRecordDigest);
        expect(request.prompt).not.toContain(c.input.source);
      }
    }
    expect(result.arms.every(a => a.usage.modelCalls === 0 && a.metrics.scheduledTargets === 3)).toBe(true);
    expect(result.arms.find(a => a.arm === 'M')!.persistentBytes).toBeGreaterThan(result.arms.find(a => a.arm === 'H')!.persistentBytes);
    expect(result.report.independentHumanAnnotations).toBe(0);
  });
  it('rejects gate evidence injection even when packet and outer contract hashes are recomputed', () => {
    const f = setup();
    f.packet.episode.gate[0].input.evidence.push({ id: 'injected', content: f.future.cases[0].input.source });
    f.packet.digest = digestOf(f.packet.episode);
    f.contract.value.packetDigest = f.packet.digest; f.contract.digest = digestOf(f.contract.value);
    expect(() => validateEvaluationContract(f.contract, f.packet, f.future)).toThrow('allowlist mismatch');
  });
  it('rejects missing/extra stage entries, late evidence and non-increasing windows', () => {
    for (const change of ['missing', 'extra', 'late', 'window']) {
      const f = setup();
      if (change === 'missing') f.contract.value.inputs.gate.pop();
      if (change === 'extra') f.contract.value.inputs.futureReview.push(f.contract.value.inputs.futureReview[0]);
      if (change === 'late') f.contract.value.inputs.gate[0].declaredAvailableAt = '2026-10-04T00:00:00Z';
      if (change === 'window') f.contract.value.temporal.futureWindowStart = f.contract.value.temporal.revisionCutoff;
      f.contract.digest = digestOf(f.contract.value);
      expect(() => validateEvaluationContract(f.contract, f.packet, f.future)).toThrow();
    }
  });
  it('binds settings and scorer labels separately from target review inputs', () => {
    const a = setup(); a.packet.episode.settings.reviewerModel = 'different-model'; a.packet.digest = digestOf(a.packet.episode);
    expect(() => validateEvaluationContract(a.contract, a.packet, a.future)).toThrow('mismatch');
    const b = setup(); b.future.cases[0].label = 'unknown'; b.future.digest = digestOf(b.future.cases);
    b.contract.value.futureDigest = b.future.digest; b.contract.digest = digestOf(b.contract.value);
    expect(() => validateEvaluationContract(b.contract, b.packet, b.future)).toThrow('allowlist mismatch');
  });
  it('preserves mechanism-specific silence and undefined/Unknown denominators', () => {
    const f = setup();
    const other = structuredClone(f.future.cases[1]); other.input.id = 'other-legal'; other.repeatedFeedbackMechanism = false;
    const predictions: Observation[] = [
      { targetId: 'target-c', prediction: 'violation', reason: 'judgment', evidenceSupport: 'fixture-bound', judgment: null },
      { targetId: 'target-d', prediction: 'unresolved', reason: 'timeout', evidenceSupport: 'not_assessable', judgment: null },
      { targetId: 'other-legal', prediction: 'safe', reason: 'judgment', evidenceSupport: 'fixture-bound', judgment: null },
    ];
    const score = scoreFuture([...f.future.cases, other], predictions);
    expect(score.positiveRecall.value).toBe(1);
    expect(score.repeatedFeedbackFalseAlarmRate.value).toBe(0);
    expect(score.strictLegalResolution.value).toBe(0.5);
    expect(score.repeatedFeedbackStrictResolution.value).toBe(0);
    expect(score.repeatedFeedbackCoverage.value).toBe(0);
    expect(score.unresolvedReferences).toHaveLength(1);
    const unknown = scoreFuture([f.future.cases[2]], []);
    expect(unknown.positiveRecall.value).toBeNull();
    expect(unknown.repeatedFeedbackStrictResolution.state).toBe('not_estimable');
  });
  it('keeps unavailable real execution unexecuted without invoking supplied transport', async () => {
    const f = setup(); let calls = 0;
    const r = await runContractedEvaluation({ ...f, mode: 'production', transport: {
      ...f.transport, async execute() { calls++; throw Error('Must not dispatch'); } } });
    expect(r.execution).toBe('not_run'); expect(r.modelExecution).toBe('not_run'); expect(r.arms).toEqual([]); expect(calls).toBe(0);
  });
  it('retains all arm/target rows when cost is unknown and stops later dispatch', async () => {
    const f = setup();
    const r = await runContractedEvaluation({ ...f, mode: 'authored_fixture', transport: {
      ...f.transport, async execute(request, signal) {
        const response = await f.transport.execute(request, signal);
        return { ...response, usage: null };
      } } });
    if (!('report' in r) || !r.report) throw Error('Expected report');
    expect(r.arms).toHaveLength(4);
    for (const a of r.arms) {
      expect(a.metrics.scheduledTargets).toBe(3); expect(a.usage.usageComplete).toBe(false);
      expect(a.usage.transportCalls).toBe(1); expect(a.metrics.positiveRecall.value).toBe(0);
    }
  });
});

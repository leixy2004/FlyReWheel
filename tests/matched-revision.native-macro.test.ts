import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digestOf } from '../src/core/identity.js';
import { createNativeMacroFixture } from '../experiments/matched-revision/native-macro-fixture.js';
import { aggregateNativeStudy, validateNativeClusters, type NativeMacroInput } from '../experiments/matched-revision/native-macro-report.js';
import { createRecoveryFixture } from '../experiments/matched-revision/evaluation-bridge-fixture.js';
import { createAuthoredCodexNativeMatchedTransport } from '../src/adapters/matched-revision-codex.js';
import { runSdkNativeStudy } from '../experiments/matched-revision/sdk-native-study.js';
import { createSdkNativeSchedule, bindSdkNativeScheduleConfiguration } from '../experiments/matched-revision/sdk-native-schedule.js';
import * as runner from '../experiments/matched-revision/runner.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';

let root: string, input: NativeMacroInput;
const rehash = (r: { digest: string }) => { const { digest, ...body } = r; r.digest = digestOf(body); };
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-native-macro-test-')); input = await createNativeMacroFixture(root); }, 40_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('canonical native study macro reporting', () => {
  it('joins frozen paired units including missing repetitions, retaining Unknown and native unknown costs', () => {
    const result = aggregateNativeStudy(input);
    expect(result.macro).toMatchObject({ plannedUnits: 3, missingReports: 1, empiricalEpisodes: 0 });
    expect(result.macro.strata).toHaveLength(1); // Inferred results/lock times do not split repetitions.
    expect(result.macro.units.every(u => u.unknownReferences === 1)).toBe(true);
    const stratum = result.macro.strata[0];
    expect(stratum.armMacros.every(a => a.metrics.positiveRecall.value === null)).toBe(true);
    expect(stratum.paired.every(p => p.metrics.positiveRecall.value === null)).toBe(true);
    expect(stratum.costs.every(c => c.totalStandaloneCostMicros === null && c.unknownUnits === 3)).toBe(true);
    expect(stratum.uncertainty).toMatchObject({ state: 'withheld', interval: null });
    expect(result.blocks.flatMap(b => b.nativeCalls).every(c => c.observations.cost.status === 'unknown')).toBe(true);
    expect(result.blocks.filter(b => b.reportDigest).every(b => b.diagnosisSlot?.record?.attemptsScheduled === 1)).toBe(true);
    expect(result.declaredClusters).toBe(1);
  });

  it('tolerates reordered imported records, but rejects reordered frozen schedules and duplicate result/source blocks', () => {
    const altered = structuredClone(input); altered.study.blocks.reverse(); altered.sources.reverse(); rehash(altered.study);
    expect(aggregateNativeStudy(altered).macro).toEqual(aggregateNativeStudy(input).macro);
    for (const mode of ['source', 'result', 'schedule']) {
      const invalid = structuredClone(input);
      if (mode === 'source') invalid.sources.push(invalid.sources[0]);
      if (mode === 'result') { invalid.study.blocks.push(invalid.study.blocks[0]); rehash(invalid.study); }
      if (mode === 'schedule') { invalid.study.schedule.blocks.reverse(); rehash(invalid.study.schedule); rehash(invalid.study); }
      expect(() => aggregateNativeStudy(invalid)).toThrow();
    }
  });

  it('retains absent result records using the complete schedule and refuses missing frozen sources', () => {
    const changed = structuredClone(input);
    const removed = changed.study.blocks.find(b => b.report)!;
    changed.study.blocks = changed.study.blocks.filter(b => b !== removed);
    if (removed.status === 'completed') changed.study.counts.completedBlocks--;
    else changed.study.counts.failedBlocks--;
    rehash(changed.study);
    const report = aggregateNativeStudy(changed);
    expect(report.macro.missingReports).toBe(2); expect(report.blocks.some(b => b.resultRecordAbsent)).toBe(true);
    changed.sources.pop(); expect(() => aggregateNativeStudy(changed)).toThrow('Complete frozen sources');
  });

  it('rejects changed block/repetition, native settings, calls, locked diagnosis, future order and cached observations', () => {
    for (const mode of ['repetition', 'settings', 'callid', 'diagnosis', 'future', 'observation', 'usage', 'effective']) {
      const bad = structuredClone(input), block = bad.study.blocks.find(b => b.report)!;
      const report = block.report!, call = report.arms[0].calls[0];
      if (mode === 'repetition') block.repetition++;
      if (mode === 'settings') call.nativeRecord!.requestedSettings.model = 'substituted';
      if (mode === 'callid') call.nativeRecord!.callId = digestOf('substituted');
      if (mode === 'diagnosis') report.diagnosisStage!.allocation.sdkInvocations = 0;
      if (mode === 'future') report.nativeProfile!.futureTargetOrder!.reverse();
      if (mode === 'observation') report.arms[0].future[0].prediction = 'safe';
      if (mode === 'usage') call.usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0 };
      if (mode === 'effective') report.arms[0].effectiveState = { kind: 'scoped_memory', initialLesson: 'substituted', delta: null };
      rehash(report); rehash(bad.study);
      expect(() => aggregateNativeStudy(bad), mode).toThrow();
    }
  });

  it('requires exact explicit lineage mappings and keeps shared cross-repository lineages in one dependence cluster', () => {
    for (const clusters of [[], [{ ...input.clusters[0], lineages: [] }], [...input.clusters, input.clusters[0]]]) {
      expect(() => aggregateNativeStudy({ ...input, clusters })).toThrow();
    }
    const repositories = new Map([['a', new Set(['shared'])], ['b', new Set(['shared'])]]);
    expect(() => validateNativeClusters([{ repository: 'a', clusterId: 'x', lineages: ['shared'] },
      { repository: 'b', clusterId: 'y', lineages: ['shared'] }], repositories)).toThrow('Shared lineage');
    expect(() => validateNativeClusters([{ repository: 'a', clusterId: 'x', lineages: ['shared'] },
      { repository: 'b', clusterId: 'x', lineages: ['shared'] }], repositories)).not.toThrow();
  });

  it('preserves interrupted returned calls and uncertain intents without manufacturing scores or zero costs', async () => {
    const fixture = await createRecoveryFixture(join(root, 'interrupted'));
    const original = runner.runMatchedRevision;
    const spy = vi.spyOn(runner, 'runMatchedRevision').mockImplementationOnce(async args => {
      await original(args); throw new Error('Authored interruption after retained calls');
    });
    try {
      const study = await runSdkNativeStudy({ ...fixture, transport: createAuthoredCodexNativeMatchedTransport(fixture.transportOptions) });
      if (study.execution !== 'completed') throw new Error('Expected canonical report');
      const native: NativeMacroInput = { configuration: fixture.configuration, sources: fixture.blocks, study, clusters: input.clusters };
      const result = aggregateNativeStudy(native);
      expect(result.blocks[0].interrupted).toBe(true); expect(result.blocks[0].interruptedCallRecords).toHaveLength(11);
      expect(result.macro.strata[0].paired[0].metrics.positiveRecall.value).toBeNull();
      expect(result.macro.strata[0].costs.every(c => c.totalStandaloneCostMicros === null)).toBe(true);
      for (const mode of ['request', 'diagnosis']) {
        const bad = structuredClone(native), b = bad.study.blocks[0];
        if (mode === 'request') {
          const call = b.interruptedCallRecords![0].call;
          call.request.model = 'substituted'; call.requestDigest = digestOf(call.request);
        } else {
          b.diagnosisSlot!.record!.allocation.elapsedMs++;
          rehash(b.diagnosisSlot!.record!);
        }
        rehash(bad.study); expect(() => aggregateNativeStudy(bad)).toThrow();
      }
      // Explicit authored recovery-intent fixture: one returned future receipt is absent.
      const uncertain = structuredClone(native), block = uncertain.study.blocks[0];
      const removed = block.interruptedCallRecords!.pop()!;
      block.actualCallOrder.pop();
      block.uncertainCalls = [{ arm: removed.arm, callId: removed.call.nativeRecord!.callId, requestDigest: removed.call.requestDigest }];
      rehash(uncertain.study);
      expect(aggregateNativeStudy(uncertain).blocks[0].uncertainCalls).toHaveLength(1);
      block.uncertainCalls.push(block.uncertainCalls[0]); rehash(uncertain.study);
      expect(() => aggregateNativeStudy(uncertain)).toThrow('uncertain');
    } finally { spy.mockRestore(); }
  }, 30_000);

  it('rejects later dispatch after an uncertain earlier block instead of hiding the interrupted attempt', () => {
    const bad = structuredClone(input), first = bad.study.blocks.find(b => b.report)!;
    const report = first.report!;
    first.interruptedCallRecords = report.arms.flatMap(a => a.calls.map(call => ({ arm: a.arm, call })));
    const lost = first.interruptedCallRecords.pop()!;
    first.interruptedSharedCallRecords = [report.diagnosisStage!.call];
    first.actualCallOrder.pop(); first.interrupted = true; first.report = null; first.status = 'failed';
    first.uncertainCalls = [{ arm: lost.arm, callId: lost.call.nativeRecord!.callId, requestDigest: lost.call.requestDigest }];
    bad.study.counts.completedBlocks--; bad.study.counts.failedBlocks++;
    rehash(bad.study);
    expect(() => aggregateNativeStudy(bad)).toThrow('dispatch after uncertain');
  });

  it('rejects later calls within the same block after unverified cleanup', () => {
    const bad = structuredClone(input), first = bad.study.blocks.find(b => b.report)!;
    first.report!.arms[0].calls[0].transportEvidence!.cleanup = 'unverified';
    rehash(first.report!); rehash(bad.study);
    expect(() => aggregateNativeStudy(bad)).toThrow('dispatch after uncertain');
  });

  it.each([false, true])('supports supplied diagnosis and complete failure reports (failure=%s)', async failure => {
    const fixture = await createRecoveryFixture(join(root, `provided-${failure}`));
    const source = createMatchedFixture();
    const schedule = createSdkNativeSchedule({ schedulingSeed: 4, repetitions: 1, conditions: ['provided'],
      blocks: [{ ...source, repetition: 1 }] });
    const configuration = bindSdkNativeScheduleConfiguration(fixture.configuration, schedule);
    if (failure) await writeFile(fixture.transportOptions.codexPathOverride, `#!${process.execPath}
process.stdin.resume(); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'authored-failure'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));});
`);
    const sources = [{ blockId: schedule.blocks[0].blockId, packet: source.packet, future: source.future }];
    const study = await runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration, blocks: sources,
      transport: createAuthoredCodexNativeMatchedTransport(fixture.transportOptions) });
    if (study.execution !== 'completed') throw new Error('Expected canonical study');
    const result = aggregateNativeStudy({ configuration, study, sources, clusters: input.clusters });
    expect(result.macro.missingReports).toBe(0);
    expect(result.blocks[0].status).toBe(failure ? 'failed' : 'completed');
    expect(result.macro.strata[0].armMacros.every(a => a.metrics.positiveRecall.value === (failure ? 0 : 1))).toBe(true);
    expect(result.macro.strata[0].costs.every(c => c.totalStandaloneCostMicros === null)).toBe(true);
  }, 30_000);

  it('retains all-Unknown zero denominators from a frozen native schedule', async () => {
    const fixture = await createRecoveryFixture(join(root, 'zero-denominator'));
    const source = structuredClone(fixture.blocks[0]);
    source.future.cases.forEach(c => { c.label = 'unknown'; c.repeatedFeedbackMechanism = false; c.labelRecordDigest = digestOf(['authored-unknown-label', c.input.id]); }); source.future.digest = digestOf(source.future.cases);
    const schedule = createSdkNativeSchedule({ schedulingSeed: 9, repetitions: 1, conditions: ['inferred'],
      diagnosis: 'authored-sdk-once-per-inferred-block', blocks: [{ ...source, repetition: 1 }] });
    const configuration = bindSdkNativeScheduleConfiguration(fixture.configuration, schedule);
    const study = await runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration, blocks: [],
      transport: createAuthoredCodexNativeMatchedTransport(fixture.transportOptions) });
    if (study.execution !== 'completed') throw new Error('Expected canonical report');
    const result = aggregateNativeStudy({ configuration, study, sources: [{ ...source, blockId: schedule.blocks[0].blockId }], clusters: input.clusters });
    expect(result.macro.units[0].unknownReferences).toBe(3);
    expect(result.macro.strata[0].uncertainty.reasons).toContain('zero-required-denominator');
    expect(result.macro.strata[0].armMacros.every(a => a.metrics.positiveRecall.value === null)).toBe(true);
  });

  it('runs the supported native CLI from its saved authored input with byte-identical reporting', async () => {
    const { writeEvaluationJson } = await import('../src/paired-evaluation.js');
    const source = join(root, 'native-input.json'), out = join(root, 'native-report.json');
    await writeEvaluationJson(source, input);
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/matched-revision/macro-replay.ts', '--native-study', source, '--out', out]);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(aggregateNativeStudy(input));
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/matched-revision/macro-replay.ts', '--native-study', source, '--out', out])).rejects.toThrow();
  });
});

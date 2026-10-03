import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, digestOf } from '../src/core/identity.js';
import { createAuthoredCodexNativeMatchedTransport } from '../src/adapters/matched-revision-codex.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { ARMS } from '../experiments/matched-revision/contracts.js';
import { SDK_NATIVE_PROFILE_VERSION, type SdkNativeConfiguration } from '../experiments/matched-revision/sdk-native-contracts.js';
import { bindSdkNativeScheduleConfiguration, createSdkNativeSchedule, validateSdkNativeSchedule,
  type SdkNativeSchedule, type SdkNativeScheduleInput } from '../experiments/matched-revision/sdk-native-schedule.js';
import { runSdkNativeStudy, type SdkNativeStudyInput } from '../experiments/matched-revision/sdk-native-study.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import * as runner from '../experiments/matched-revision/runner.js';

function configuration(): SdkNativeConfiguration {
  const digest = digestOf('authored declarations only'), unsupported = { availability: 'unsupported_in_pinned_typed_sdk' as const };
  return { schemaVersion: 1, kind: 'matched-revision-sdk-native-configuration', profileVersion: SDK_NATIVE_PROFILE_VERSION,
    runtimePins: { sdk: '@openai/codex-sdk', sdkVersion: '0.159.2', cliVersion: 'authored-script', providerRoute: 'no-provider',
      sdkDeclarationDigest: digest, runtimeDigest: digest, configurationDigest: digest },
    roles: { construction: { model: 'unused-construction' }, diagnosis: { model: 'unused-diagnosis' },
      proposal: { model: 'authored-proposal', modelReasoningEffort: 'high' }, review: { model: 'authored-review', modelReasoningEffort: 'low' } },
    generationControls: { temperature: unsupported, generationSeed: unsupported, maxOutputTokens: unsupported },
    scheduling: { schedulingSeed: 0, seedPurpose: 'assignment_and_order_only', repetitions: 1, algorithm: 'unbound',
      algorithmDigest: digest, blockRosterDigest: digest, targetScheduleDigest: digest },
    limits: { serializedRequestBytes: 200_000, outputSchemaBytes: 100_000, renderedPersistentStateBytes: 20_000,
      answerBytes: { construction: 100_000, diagnosis: 100_000, proposal: 100_000, review: 100_000 },
      combinedStdoutStderrBytes: 200_000, forwardedEventBytes: 100_000, deadlineMsPerCall: 3000, cleanupTimeoutMs: 1500,
      dispatchedAttemptsPerRole: { construction: 1, diagnosis: 1, proposal: 1, review: 2 },
      dispatchedAttemptsPerArm: 3, providerCallsPerArm: 3, elapsedMsPerArm: 15_000 },
    countingRules: { serialization: 'canonical-json-utf8-v1', persistentState: 'rendered-utf8-including-initial-lesson-delta-and-overhead',
      attempt: 'every-dispatch-including-failure-invalid-abstention', elapsed: 'setup-execution-cleanup-and-allocated-shared-diagnosis',
      providerInternalCalls: 'disabled', retries: 0, freshThreadPerCall: true, outputCacheReuse: false },
    monetaryPolicy: { kind: 'hard_ceiling', currency: 'USD', maxCostMicros: 0, scope: 'whole_study_including_in_flight' } };
}
function inputs(repetitions: number, conditions: ('provided' | 'inferred')[] = ['provided'], episodes = 1) {
  const blocks: SdkNativeScheduleInput[] = [];
  for (let episodeIndex = 0; episodeIndex < episodes; episodeIndex++) {
    for (const condition of conditions) for (let repetition = 1; repetition <= repetitions; repetition++) {
      const fixture = createMatchedFixture(), packet = structuredClone(fixture.packet);
      packet.episode.id = `episode-${episodeIndex}`;
      if (condition === 'inferred') {
        packet.episode.diagnosis.condition = condition;
        // Supplied authored declaration only. Native execution must still reject
        // this nonzero upstream-call record, never pretend to perform inference.
        packet.episode.diagnosis.provenance.upstreamCalls = 1;
        packet.episode.diagnosis.provenance.sourceRecordDigest = digestOf(['authored-diagnosis-attempt', episodeIndex, repetition]);
      }
      packet.digest = digestOf(packet.episode);
      blocks.push({ packet, future: fixture.future, repetition });
    }
  }
  return blocks;
}
function scheduleOf(blocks: SdkNativeScheduleInput[], seed = 42, repetitions = 4, conditions: ('provided' | 'inferred')[] = ['provided', 'inferred']) {
  return createSdkNativeSchedule({ schedulingSeed: seed, repetitions, conditions, blocks });
}
function executionInputs(schedule: SdkNativeSchedule, sources: SdkNativeScheduleInput[]): SdkNativeStudyInput[] {
  return schedule.blocks.map(block => {
    const item = sources.find(s => s.packet.episode.id === block.episodeId && s.packet.episode.diagnosis.condition === block.condition && s.repetition === block.repetition)!;
    return { blockId: block.blockId, packet: item.packet, future: item.future };
  });
}
function rehash<T extends { digest: string }>(value: T) { const { digest: _digest, ...body } = value; value.digest = digestOf(body); return value; }

describe('frozen SDK-native repeated paired schedule', () => {
  it('is canonical, deeply frozen and reproducible independent of input order, with seed changes limited to assignment/order', () => {
    const source = inputs(4, ['provided', 'inferred'], 2), a = scheduleOf(source), b = scheduleOf([...source].reverse());
    expect(a).toEqual(b); expect(validateSdkNativeSchedule(JSON.parse(canonicalJson(a)))).toEqual(a);
    // Golden assignment vector: an algorithm change requires an explicit version decision.
    expect(digestOf(a.blocks)).toBe('d4aa6a161fdaeb196f29d92120161fc3f753b4d520f034eab2c6c931ee0a9fbb');
    expect(Object.isFrozen(a.blocks[0].armOrder)).toBe(true);
    const changed = scheduleOf(source, 43);
    expect(changed.digest).not.toBe(a.digest); expect(changed.sources).toEqual(a.sources);
    expect(changed.blocks.map(b => b.armOrder)).not.toEqual(a.blocks.map(b => b.armOrder));
    expect(changed.blocks.map(b => b.futureTargetOrder)).not.toEqual(a.blocks.map(b => b.futureTargetOrder));
    expect(new Set(a.blocks.map(b => b.blockId)).size).toBe(16);
    const config = bindSdkNativeScheduleConfiguration(configuration(), a);
    expect(validateSdkNativeSchedule(a, config)).toEqual(a);
    expect(config.scheduling).toMatchObject({ schedulingSeed: 42, repetitions: 4, seedPurpose: 'assignment_and_order_only' });
    expect(config.generationControls.generationSeed).toEqual({ availability: 'unsupported_in_pinned_typed_sdk' });
  });

  it('counterbalances every arm position and directed predecessor within four-repeat cycles, and O/I order within two', () => {
    const schedule = scheduleOf(inputs(8, ['provided', 'inferred'], 2), 7, 8);
    for (const episodeId of ['episode-0', 'episode-1']) {
      for (const condition of ['provided', 'inferred']) for (const start of [1, 5]) {
        const blocks = schedule.blocks.filter(b => b.episodeId === episodeId && b.condition === condition && b.repetition >= start && b.repetition < start + 4);
        for (let position = 0; position < 4; position++) expect([...blocks.map(b => b.armOrder[position])].sort()).toEqual([...ARMS].sort());
        const pairs = blocks.flatMap(b => b.armOrder.slice(1).map((arm, i) => `${b.armOrder[i]}-${arm}`));
        expect(new Set(pairs).size).toBe(12);
      }
      for (const start of [1, 3, 5, 7]) {
        const groups = [start, start + 1].map(repetition => schedule.blocks.filter(b => b.episodeId === episodeId && b.repetition === repetition));
        expect(groups[0].map(b => b.condition)).toEqual(groups[1].map(b => b.condition).reverse());
        for (const group of groups) expect(schedule.blocks.indexOf(group[1]) - schedule.blocks.indexOf(group[0])).toBe(1);
      }
    }
  });

  it('rejects incomplete/duplicate rosters, reused inferred attempts and changes to shared episode inputs or provided diagnosis', () => {
    const source = inputs(2, ['provided', 'inferred']);
    expect(() => scheduleOf(source.slice(1), 1, 2)).toThrow(/complete/);
    expect(() => scheduleOf([...source, source[0]], 1, 2)).toThrow(/Duplicate/);
    const reused = structuredClone(source);
    reused[3].packet = structuredClone(reused[2].packet);
    expect(() => scheduleOf(reused, 1, 2)).toThrow(/own supplied diagnosis/);
    const changed = structuredClone(source);
    changed[1].packet.episode.visibilityAndMissingness = 'Different visibility envelope';
    changed[1].packet.digest = digestOf(changed[1].packet.episode);
    expect(() => scheduleOf(changed, 1, 2)).toThrow(/same incumbent/);
    const diagnosis = structuredClone(source);
    diagnosis[1].packet.episode.diagnosis.provenance.description = 'A replacement diagnosis';
    diagnosis[1].packet.digest = digestOf(diagnosis[1].packet.episode);
    expect(() => scheduleOf(diagnosis, 1, 2)).toThrow(/stay locked/);
  });

  it('rejects tampered order/identity even after outer rehash, unsupported algorithms, model seeds and stale configuration bindings', () => {
    const schedule = scheduleOf(inputs(4, ['provided', 'inferred'])), config = bindSdkNativeScheduleConfiguration(configuration(), schedule);
    for (const mutate of [
      (s: SdkNativeSchedule) => { s.blocks[0].armOrder.reverse(); },
      (s: SdkNativeSchedule) => { s.blocks[0].futureTargetOrder.reverse(); },
      (s: SdkNativeSchedule) => { s.blocks[0].blockId = digestOf('substitute'); },
      (s: SdkNativeSchedule) => { s.blocks.reverse(); },
      (s: SdkNativeSchedule) => { s.sources[0].packetDigest = digestOf('substitute'); },
    ]) {
      const copy = structuredClone(schedule); mutate(copy);
      expect(() => validateSdkNativeSchedule(rehash(copy), config)).toThrow();
    }
    expect(() => validateSdkNativeSchedule({ ...schedule, modelSeed: 42 })).toThrow();
    expect(() => validateSdkNativeSchedule({ ...schedule, algorithm: 'another-algorithm' })).toThrow();
    expect(() => validateSdkNativeSchedule(schedule, configuration())).toThrow(/does not bind/);
    expect(() => validateSdkNativeSchedule(schedule, { ...config,
      scheduling: { ...config.scheduling, targetScheduleDigest: digestOf('another order') } })).toThrow(/does not bind/);
  });
});

let root: string, counter = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-scheduled-native-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function harness(partialFailure = false) {
  const fixtureRoot = join(root, String(++counter)); await mkdir(fixtureRoot);
  const workingDirectory = join(fixtureRoot, 'repo'); await mkdir(workingDirectory);
  const codexPathOverride = join(fixtureRoot, 'authored.cjs'), fixture = createMatchedFixture();
  await writeFile(codexPathOverride, `#!${process.execPath}
const fs=require('node:fs'),send=x=>console.log(JSON.stringify(x));
const args=process.argv.slice(2),cwd=args[args.indexOf('--cd')+1];
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
fs.appendFileSync(cwd+'/audit.jsonl',JSON.stringify({args,prompt})+'\\n');
send({type:'thread.started',thread_id:'authored-'+process.pid});
${partialFailure ? `send({type:'turn.completed',usage:{input_tokens:7,output_tokens:5}});` : `let output;
if(prompt.includes('COMMON_INPUT=')) output=prompt.includes('initialLesson is a lossless')?${JSON.stringify(fixture.memoryProposal)}:${JSON.stringify(fixture.proposal)};
else {const input=JSON.parse(prompt.split('\\nINPUT=')[1]);output={judgments:input.targets.map(t=>({targetId:t.id,
prediction:({'gate-0':'violation','gate-1':'safe','target-c':'violation','target-d':'safe','target-e':'unresolved'})[t.id],
reason:t.id==='target-e'?'abstained':'judgment',rationale:'Authored response only',evidenceRefs:[t.evidence[0].id],missingEvidence:[]}))};}
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(output)}});
send({type:'turn.completed',usage:{input_tokens:7,cached_input_tokens:2,cache_write_input_tokens:1,output_tokens:5,reasoning_output_tokens:3}});`}
});`, { mode: 0o700 });
  return { transport: createAuthoredCodexNativeMatchedTransport({ workingDirectory, fixtureRoot, codexPathOverride }), workingDirectory };
}

describe('scheduled authored-native runner integration', () => {
  it('runs independent calls in the frozen arm/target order, retaining a missing repetition without duplicate empirical counts', async () => {
    const f = await harness(), source = inputs(3), schedule = scheduleOf(source, 17, 3, ['provided']);
    const configurationBound = bindSdkNativeScheduleConfiguration(configuration(), schedule);
    const supplied = executionInputs(schedule, source).slice(0, 2);
    const report = await runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration: configurationBound, blocks: supplied, transport: f.transport });
    expect(report).toMatchObject({ execution: 'completed', modelExecution: 'not_run', empiricalEpisodes: 0, providerModelCalls: 0,
      operationalAdmission: 'not_evaluated', counts: { authoredEpisodeIdentities: 1, plannedBlocks: 3, completedBlocks: 2, failedBlocks: 0, missingBlocks: 1, repetitions: 3, retries: 0 } });
    const calls = report.blocks.flatMap(b => b.report?.arms.flatMap(a => a.calls) ?? []);
    expect(calls).toHaveLength(22);
    expect(new Set(calls.map(c => c.nativeRecord!.callId)).size).toBe(22);
    expect(new Set(calls.map(c => c.transportEvidence!.sessionId)).size).toBe(22);
    for (const block of report.blocks) {
      const planned = schedule.blocks.find(b => b.blockId === block.blockId)!;
      expect(block.roster.map(a => a.arm)).toEqual(planned.armOrder);
      for (const arm of block.roster) expect(arm.future.map(t => t.targetId)).toEqual(planned.futureTargetOrder);
      if (!block.report) {
        expect(block.status).toBe('missing'); expect(block.actualCallOrder).toEqual([]);
        expect(block.roster.every(a => a.slots.every(s => s.status === 'missing'))).toBe(true);
        continue;
      }
      expect(block.report.nativeProfile).toMatchObject({ declaredScheduleDigestsVerified: true, scheduleDigest: schedule.digest, blockId: planned.blockId });
      expect(block.actualArmOrder).toEqual(planned.armOrder);
      expect(block.actualCallOrder).toHaveLength(11);
      expect(new Set(block.report.arms.map(a => a.sharedDiagnosisDigest)).size).toBe(1);
      expect(new Set(block.report.arms.map(a => a.commonRevisionInputDigest)).size).toBe(1);
      for (const arm of block.report.arms) {
        expect(arm.future.map(t => t.targetId)).toEqual(planned.futureTargetOrder);
        expect(arm.calls.filter(c => c.stage === 'proposal')).toHaveLength(arm.arm === 'F' ? 0 : 1);
        expect(arm.calls.at(-1)!.nativeRecord!.blockId).toBe(planned.blockId);
        expect(JSON.parse(arm.calls.at(-1)!.request.prompt.split('\nINPUT=')[1]).targets.map((t: { id: string }) => t.id)).toEqual(planned.futureTargetOrder);
        for (const call of arm.calls) {
          expect(Date.parse(call.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(call.startedAt!));
          expect(call.request).not.toHaveProperty('sampler'); expect(call.request).not.toHaveProperty('generationSeed');
        }
      }
    }
    const audit = (await readFile(join(f.workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    expect(audit).toHaveLength(22);
    expect(audit.every(row => !row.args.some((arg: string) => /seed|temperature|resume/.test(arg)))).toBe(true);
  }, 30_000);

  it('preserves all failed/missing slots and every target after unknown usage; there are no diagnosis calls or favorable rerolls', async () => {
    const f = await harness(true), source = inputs(2, ['provided', 'inferred']);
    const schedule = scheduleOf(source, 9, 2), bound = bindSdkNativeScheduleConfiguration(configuration(), schedule);
    const report = await runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration: bound,
      blocks: executionInputs(schedule, source), transport: f.transport });
    expect(report).toMatchObject({ counts: { plannedBlocks: 4, failedBlocks: 4, missingBlocks: 0, retries: 0 }, empiricalEpisodes: 0 });
    // Provided: one failed call per arm; inferred: F only, U/H/M stay blocked by existing upstream admission.
    const calls = report.blocks.flatMap(b => b.report!.arms.flatMap(a => a.calls));
    expect(calls).toHaveLength(44); expect(calls.filter(c => c.invoked)).toHaveLength(10);
    for (const block of report.blocks) {
      expect(block.roster.flatMap(a => a.future)).toHaveLength(12);
      expect(block.report!.arms.every(a => a.future.every(t => t.prediction === 'unresolved'))).toBe(true);
      for (const arm of block.report!.arms) {
        expect(arm.calls.filter(c => c.stage === 'proposal')).toHaveLength(arm.arm === 'F' ? 0 : 1);
        expect(arm.calls.filter(c => c.invoked)).toHaveLength(block.condition === 'inferred' && arm.arm !== 'F' ? 0 : 1);
        expect(arm.usage.retries).toBe(0);
      }
    }
    const audit = (await readFile(join(f.workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n');
    expect(audit).toHaveLength(10);
  }, 30_000);

  it('rejects duplicate, substituted or mismatched scheduled inputs before dispatch; production stays closed', async () => {
    const f = await harness(), source = inputs(1), schedule = scheduleOf(source, 3, 1, ['provided']);
    const bound = bindSdkNativeScheduleConfiguration(configuration(), schedule), blocks = executionInputs(schedule, source);
    const run = (supplied: SdkNativeStudyInput[]) => runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration: bound, blocks: supplied, transport: f.transport });
    await expect(run([blocks[0], blocks[0]])).rejects.toThrow(/Duplicate/);
    const replaced = structuredClone(blocks);
    replaced[0].packet.episode.diagnosis.provenance.description = 'Substitution after freezing';
    replaced[0].packet.digest = digestOf(replaced[0].packet.episode);
    await expect(run(replaced)).rejects.toThrow(/identity mismatch/);
    const relabeled = structuredClone(blocks);
    relabeled[0].future.cases[0].label = 'unknown'; relabeled[0].future.digest = digestOf(relabeled[0].future.cases);
    await expect(run(relabeled)).rejects.toThrow(/identity mismatch/);
    await expect(run([{ ...blocks[0], blockId: digestOf('outside') }])).rejects.toThrow(/not in/);
    await expect(runMatchedRevision({ mode: 'authored_fixture', packet: blocks[0].packet, future: blocks[0].future,
      native: { configuration: bound, repetition: 2, transport: f.transport, schedule: { manifest: schedule, blockId: blocks[0].blockId } } })).rejects.toThrow(/outside/);
    const production = await runSdkNativeStudy({ mode: 'production', schedule, configuration: bound, blocks, transport: f.transport });
    expect(production).toMatchObject({ execution: 'not_run', reason: 'production_adapter_unconfigured' });
    await expect(readFile(join(f.workingDirectory, 'audit.jsonl'))).rejects.toThrow();
  });

  it('retains observed call records and the full planned roster if reporting is interrupted, without retrying', async () => {
    const f = await harness(), source = inputs(1), schedule = scheduleOf(source, 3, 1, ['provided']);
    const bound = bindSdkNativeScheduleConfiguration(configuration(), schedule), original = runner.runMatchedRevision;
    const spy = vi.spyOn(runner, 'runMatchedRevision').mockImplementationOnce(async input => {
      await original(input); throw new Error('Authored reporting interruption after observed calls');
    });
    try {
      const report = await runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration: bound,
        blocks: executionInputs(schedule, source), transport: f.transport });
      expect(report).toMatchObject({ counts: { failedBlocks: 1, retries: 0 } });
      const block = report.blocks[0];
      expect(block).toMatchObject({ status: 'failed', interrupted: true, report: null });
      expect(block.interruptedCallRecords).toHaveLength(11); expect(block.actualCallOrder).toHaveLength(11);
      expect(block.roster.flatMap(a => a.future)).toHaveLength(12);
      expect((await readFile(join(f.workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(11);
    } finally { spy.mockRestore(); }
  }, 20_000);
});

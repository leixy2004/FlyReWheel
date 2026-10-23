import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson, digestOf } from '../src/core/identity.js';
import { bytesDigest } from '../src/workspace/execution-receipt.js';
import { createAuthoredCodexMatchedTransport, createAuthoredCodexNativeMatchedTransport } from '../src/adapters/matched-revision-codex.js';
import { SdkNativeMatchedRequestSchema, ProposalSchema, ReviewSchema } from '../src/core/matched-revision-model.js';
import { enforceMatchedCodexExecution } from '../src/workspace/matched-codex-policy.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import { renderState, reviewRequest } from '../experiments/matched-revision/prompts.js';
import { initialMemory, validatePacket } from '../experiments/matched-revision/validation.js';
import { SDK_NATIVE_PROFILE_VERSION, type SdkNativeCallRecord, type SdkNativeConfiguration } from '../experiments/matched-revision/sdk-native-contracts.js';
import { validateSdkNativeCallRecord } from '../experiments/matched-revision/sdk-native-validation.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rm: vi.fn(original.rm) };
});

let root: string, counter = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-native-sdk-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const usage = { input_tokens: 7, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 3 };
function configuration(): SdkNativeConfiguration {
  const digest = digestOf('authored declarations, not external evidence'), unsupported = { availability: 'unsupported_in_pinned_typed_sdk' as const };
  return { schemaVersion: 1, kind: 'matched-revision-sdk-native-configuration', profileVersion: SDK_NATIVE_PROFILE_VERSION,
    runtimePins: { sdk: '@openai/codex-sdk', sdkVersion: '0.159.2', cliVersion: 'authored-script', providerRoute: 'no-provider',
      sdkDeclarationDigest: digest, runtimeDigest: digest, configurationDigest: digest },
    roles: { construction: { model: 'unused-construction' }, diagnosis: { model: 'unused-diagnosis' },
      proposal: { model: 'authored-proposal', modelReasoningEffort: 'high' }, review: { model: 'authored-review', modelReasoningEffort: 'low' } },
    generationControls: { temperature: unsupported, generationSeed: unsupported, maxOutputTokens: unsupported },
    scheduling: { schedulingSeed: 0, seedPurpose: 'assignment_and_order_only', repetitions: 2, algorithm: 'declared-only',
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
async function harness(code?: string, afterResponse = '') {
  const fixture = createMatchedFixture(), config = configuration();
  const fixtureRoot = join(root, String(++counter)); await mkdir(fixtureRoot);
  const workingDirectory = join(fixtureRoot, 'repo'); await mkdir(workingDirectory);
  const codexPathOverride = join(fixtureRoot, 'script.cjs');
  const response = `let output;
if(prompt.includes('COMMON_INPUT=')) output=prompt.includes('initialLesson is a lossless')?${JSON.stringify(fixture.memoryProposal)}:${JSON.stringify(fixture.proposal)};
else {const input=JSON.parse(prompt.split('\\nINPUT=')[1]);output={judgments:input.targets.map(t=>({targetId:t.id,
prediction:({'gate-0':'violation','gate-1':'safe','target-c':'violation','target-d':'safe','target-e':'unresolved'})[t.id],
reason:t.id==='target-e'?'abstained':'judgment',rationale:'Authored response only',evidenceRefs:[t.evidence[0].id],missingEvidence:[]}))};}
send({type:'thread.started',thread_id:'authored-'+process.pid});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(output)}});
send({type:'turn.completed',usage:${JSON.stringify(usage)}});`;
  await writeFile(codexPathOverride, `#!${process.execPath}
const fs=require('node:fs'),send=x=>console.log(JSON.stringify(x));
const args=process.argv.slice(2),cwd=args[args.indexOf('--cd')+1];
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
fs.appendFileSync(cwd+'/audit.jsonl',JSON.stringify({args,prompt,env:Object.keys(process.env).sort(),schema:JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))})+'\\n');
${code ?? response}
${afterResponse}
});`, { mode: 0o700 });
  const options = { fixtureRoot, workingDirectory, codexPathOverride };
  const transport = createAuthoredCodexNativeMatchedTransport(options);
  return { fixture, config, transport, workingDirectory, options,
    run: () => runMatchedRevision({ mode: 'authored_fixture', ...fixture, native: { configuration: config, repetition: 1, transport } }) };
}
function expectRoster(report: Awaited<ReturnType<typeof runMatchedRevision>>, fixture: ReturnType<typeof createMatchedFixture>) {
  expect(report.arms.map(arm => arm.arm)).toEqual(fixture.packet.episode.settings.armOrder);
  for (const arm of report.arms) {
    expect(arm.calls.map(call => call.stage)).toEqual(arm.arm === 'F' ? ['gate', 'future'] : ['proposal', 'gate', 'future']);
    expect(arm.future.map(row => row.targetId)).toEqual(fixture.future.cases.map(c => c.input.id));
    expect(arm.gate.observations.map(row => row.targetId)).toEqual(fixture.packet.episode.gate.map(c => c.input.id));
  }
}

describe('authored-only native configuration through the existing matched orchestration and SDK bridge', () => {
  it('executes shared native settings through actual SDK arguments and validates all eleven honest no-model records', async () => {
    const f = await harness();
    f.config.limits.answerBytes.proposal = 2_000_000;
    // Legacy token/sampler declarations are packet provenance, not native limits.
    Object.assign(f.fixture.packet.episode.settings.limits, { persistentStateTokens: 1, revisionOutputTokens: 1,
      reviewOutputTokens: 1, maxInputTokensPerArm: 1, maxOutputTokensPerArm: 1, timeoutMsPerCall: 1 });
    f.fixture.packet.digest = digestOf(f.fixture.packet.episode);
    const report = await f.run(); expectRoster(report, f.fixture);
    expect(report).toMatchObject({ execution: 'completed', modelExecution: 'not_run', empiricalEpisodes: 0,
      nativeProfile: { operationalAdmission: 'not_evaluated', declaredPinsVerified: false, declaredScheduleDigestsVerified: false } });
    expect(report.arms.every(a => a.gate.passed && a.usage.modelCalls === 0)).toBe(true);
    const calls = report.arms.flatMap(arm => arm.calls), audit = (await readFile(join(f.workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    expect(calls).toHaveLength(11); expect(audit).toHaveLength(11);
    expect(new Set(calls.map(c => c.transportEvidence?.sessionId)).size).toBe(11);
    calls.forEach((call, i) => {
      const role = call.stage === 'proposal' ? 'proposal' : 'review', requested = f.config.roles[role], native = call.nativeRecord!;
      expect(call.status).toBe('completed'); expect(call).not.toHaveProperty('accountedInputTokens');
      expect(call.request).not.toHaveProperty('sampler'); expect(call.request).not.toHaveProperty('maxOutputTokens');
      expect(SdkNativeMatchedRequestSchema.parse(call.request)).toEqual(call.request);
      expect(native).toMatchObject({ status: 'authored_completed', executionKind: 'authored_sdk_no_model',
        requestedSettings: requested, appliedSettings: null, effectiveConfigurationEvidenceDigest: null,
        monetaryAdmission: { status: 'not_evaluated' }, enforcement: { status: 'authored_supervised' },
        observations: { sdkInvocations: 1, providerCalls: 0, rawUsage: usage, cost: { status: 'unknown', costMicros: null, currency: null } },
        isolationEvidence: { processGroupStopped: true, externalRuntimeEvidenceDigest: null, wholeRuntimeDestroyed: null, remoteGenerationStopped: null } });
      expect(native.observations.serializedRequestBytes).toBe(Buffer.byteLength(canonicalJson(call.request)));
      expect(native.observations.outputSchemaBytes).toBe(Buffer.byteLength(canonicalJson(call.request.outputSchema)));
      expect(native.observations.answerBytes).toBe(Buffer.byteLength(JSON.stringify(call.output)));
      expect(validateSdkNativeCallRecord(native, f.config)).toEqual(native);
      if (native.enforcement.status !== 'authored_supervised') throw new Error('Expected authored supervision');
      expect(native.enforcement.enforcementEvidenceDigest).toBe(digestOf({ observations: native.observations,
        processEvidence: call.transportEvidence!.processEvidence }));
      expect(audit[i].prompt).toBe(call.request.prompt);
      expect(audit[i].args).toEqual(expect.arrayContaining(['--model', requested.model, `model_reasoning_effort="${requested.modelReasoningEffort}"`, 'read-only', 'features.shell_tool=false']));
      expect(audit[i].args.some((a: string) => /temperature|seed|max_output_tokens|resume/.test(a))).toBe(false);
      expect(audit[i].schema).toEqual(z.toJSONSchema(role === 'proposal' ? ProposalSchema : ReviewSchema));
      if (role === 'proposal') expect(JSON.parse(call.request.prompt.split('COMMON_INPUT=')[1].split('\nEDIT_POLICY=')[0]).budget).toEqual(f.config);
    });
    const memory = report.arms.find(a => a.arm === 'M')!;
    expect(memory.calls[1].nativeRecord!.observations.renderedPersistentStateBytes).toBe(Buffer.byteLength(renderState(memory.proposal!.state!)));
    expect(memory.usage.costMicrosKnownLowerBound).toBeNull(); expect(memory.usage.usageComplete).toBe(false);
    const inflate: Array<(record: SdkNativeCallRecord) => void> = [
      r => { r.status = 'completed'; },
      r => { delete r.executionKind; },
      r => { r.observations.providerCalls = 1; },
      r => { r.observations.armProviderCalls = 1; },
      r => { r.appliedSettings = { ...r.requestedSettings }; },
      r => { r.effectiveConfigurationEvidenceDigest = digestOf('unverified'); },
      r => { r.isolationEvidence.externalRuntimeEvidenceDigest = digestOf('unverified'); },
      r => { r.isolationEvidence.wholeRuntimeDestroyed = true; },
      r => { r.isolationEvidence.remoteGenerationStopped = true; },
      r => { r.monetaryAdmission = { status: 'blocked', reason: 'not_authorized', detail: 'No real monetary admission' }; },
      r => { r.observations.cost = { status: 'estimate', costMicros: 0, currency: 'USD', assumptionsDigest: digestOf('unverified') }; },
      r => { r.enforcement = { status: 'reported_enforced', limitsDigest: digestOf(f.config.limits), enforcementEvidenceDigest: digestOf('unverified') }; },
    ];
    for (const mutate of inflate) {
      const record = structuredClone(calls[0].nativeRecord!); mutate(record);
      expect(() => validateSdkNativeCallRecord(record, f.config)).toThrow();
    }
  }, 20_000);

  it('retains partial usage and blocks each arm after the malformed SDK completion without losing targets', async () => {
    const f = await harness(`send({type:'thread.started',thread_id:'partial'});send({type:'turn.completed',usage:{input_tokens:7,output_tokens:5}});`);
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls[0].nativeRecord).toMatchObject({ status: 'failed', observations: { sdkInvocations: 1,
        rawUsage: { input_tokens: 7, output_tokens: 5, cached_input_tokens: null, cache_write_input_tokens: null, reasoning_output_tokens: null },
        cost: { status: 'unknown', costMicros: null, currency: null } } });
      expect(arm.calls.slice(1).every(c => !c.invoked && c.nativeRecord?.status === 'not_dispatched')).toBe(true);
      expect(arm.usage.transportCalls).toBe(1); expect(arm.future.every(row => row.prediction === 'unresolved')).toBe(true);
    }
  });

  it('preserves an omitted cache-write field as unknown even though the pinned SDK normalizes it to zero', async () => {
    const { cache_write_input_tokens: _missing, ...partial } = usage;
    const f = await harness(`send({type:'thread.started',thread_id:'normalized'});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify({judgments:[]})}});
send({type:'turn.completed',usage:${JSON.stringify(partial)}});`);
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls[0].nativeRecord!.observations.rawUsage).toEqual({ ...partial, cache_write_input_tokens: null });
      expect(arm.calls.slice(1).every(c => !c.invoked)).toBe(true);
    }
  });

  it('captures valid final JSONL usage without a trailing newline', async () => {
    const f = await harness(`send({type:'thread.started',thread_id:'last-line'});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify({judgments:[]})}});
process.stdout.write(JSON.stringify({type:'turn.completed',usage:${JSON.stringify(usage)}}));`);
    const report = await f.run(); expectRoster(report, f.fixture);
    expect(report.arms.flatMap(a => a.calls).every(c => c.invoked && digestOf(c.nativeRecord!.observations.rawUsage) === digestOf(usage))).toBe(true);
  }, 15_000);

  it.each(['serializedRequestBytes', 'outputSchemaBytes', 'renderedPersistentStateBytes'] as const)('retains all undispatched slots when %s is exhausted', async limit => {
    const f = await harness(); f.config.limits[limit] = 1;
    const report = await f.run(); expectRoster(report, f.fixture);
    expect(report.arms.flatMap(a => a.calls).every(c => !c.invoked && c.nativeRecord?.status === 'not_dispatched')).toBe(true);
    await expect(readFile(join(f.workingDirectory, 'audit.jsonl'))).rejects.toThrow();
  });

  it('retains every target when a valid future roster renders beyond the native request schema/byte ceiling', async () => {
    const f = await harness(), base = f.fixture.future.cases[0];
    f.fixture.future.cases = Array.from({ length: 70 }, (_, i) => {
      const source = `// authored target ${i}\n${'x'.repeat(30_000)}`;
      return { ...structuredClone(base), input: { ...structuredClone(base.input), id: `large-target-${i}`, prId: `large-pr-${i}`,
        lineageId: `large-lineage-${i}`, source, sourceDigest: bytesDigest(source), sourceSnapshotDigest: digestOf(['authored', i]),
        evidence: [{ id: `large-evidence-${i}`, content: 'e'.repeat(30_000) }] } };
    });
    f.fixture.future.digest = digestOf(f.fixture.future.cases);
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls.at(-1)).toMatchObject({ invoked: false, nativeRecord: { status: 'not_dispatched' } });
      expect(arm.future).toHaveLength(70);
    }
  }, 15_000);

  it('shares review-role and per-arm attempt caps across gate and future, retaining unscheduled answers as failures', async () => {
    const f = await harness(); f.config.limits.dispatchedAttemptsPerRole.review = 1;
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls.at(-1)).toMatchObject({ stage: 'future', invoked: false, status: 'budget_exhausted',
        nativeRecord: { status: 'not_dispatched', observations: { roleDispatchedAttempts: 1, armDispatchedAttempts: arm.arm === 'F' ? 1 : 2 } } });
    }
  }, 15_000);

  it('counts failed attempts against the arm cap without retries or missing later slots', async () => {
    const f = await harness(`send({type:'thread.started',thread_id:'invalid-schema'});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:'{"unexpected":true}'}});
send({type:'turn.completed',usage:${JSON.stringify(usage)}});`);
    f.config.limits.dispatchedAttemptsPerArm = 1;
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls[0]).toMatchObject({ invoked: true, status: 'failed', nativeRecord: { status: 'failed',
        observations: { armDispatchedAttempts: 1, rawUsage: usage } } });
      expect(arm.calls.slice(1).every(c => !c.invoked && c.status === 'budget_exhausted')).toBe(true);
      expect(arm.usage.transportCalls).toBe(1);
    }
  });

  it.each(['combinedStdoutStderrBytes', 'forwardedEventBytes'] as const)('retains %s overshoots with stop receipts and complete target rosters', async limit => {
    const f = await harness(`process.stderr.write('x'.repeat(65_536));`); f.config.limits[limit] = 4096;
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      const call = arm.calls[0], observed = call.nativeRecord!.observations;
      expect(call).toMatchObject({ invoked: true, status: 'failed', output: null, nativeRecord: { status: 'failed',
        isolationEvidence: { processGroupStopped: true } } });
      expect(observed.stdoutBytes! + observed.stderrBytes!).toBeGreaterThan(4096);
      expect(observed.forwardedEventBytes).toBeLessThanOrEqual(4096);
      expect(arm.calls.slice(1).every(c => !c.invoked)).toBe(true);
    }
  });

  it('stops an arm after stream overflow even when the prior completion reported fully known usage', async () => {
    const f = await harness(undefined, `setTimeout(()=>process.stderr.write('x'.repeat(65_536)), 50);`);
    f.config.limits.combinedStdoutStderrBytes = 4096;
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls[0]).toMatchObject({ status: 'failed', nativeRecord: { status: 'failed', observations: { rawUsage: usage } } });
      expect(arm.calls.slice(1).every(c => !c.invoked)).toBe(true);
    }
  });

  it('fences subsequent arms after cleanup removal fails while retaining measured usage and process receipts', async () => {
    const f = await harness(), remove = fs.rm, retained: string[] = [];
    const spy = vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes('flyrewheel-workspace-codex-')) {
        retained.push(String(path)); throw new Error('Authored cleanup failure');
      }
      return remove(path, options);
    });
    try {
      const report = await f.run(); expectRoster(report, f.fixture);
      const calls = report.arms.flatMap(a => a.calls);
      expect(calls.filter(c => c.invoked)).toHaveLength(1);
      expect(calls[0]).toMatchObject({ status: 'failed', error: 'Codex runtime cleanup failed: Authored cleanup failure',
        transportEvidence: { cleanup: 'unverified' }, nativeRecord: { status: 'failed',
          observations: { rawUsage: usage }, isolationEvidence: { processGroupStopped: true } } });
      expect(calls.slice(1).every(c => !c.invoked && c.nativeRecord?.status === 'not_dispatched')).toBe(true);
    } finally {
      spy.mockImplementation(remove);
      for (const path of retained) await remove(path, { recursive: true, force: true });
    }
  });

  it('also fences the legacy transport after cleanup removal fails despite a verified process stop', async () => {
    const f = await harness(), remove = fs.rm, retained: string[] = [];
    const transport = createAuthoredCodexMatchedTransport({ ...f.options,
      limits: { maxInputBytes: 200_000, maxOutputBytes: 100_000, maxArtifactBytes: 1,
        maxArtifacts: 0, timeoutMs: 3000, cleanupTimeoutMs: 1500 } });
    const prepared = validatePacket(f.fixture.packet, f.fixture.future).prepared;
    const request = reviewRequest('gate', initialMemory(prepared), f.fixture.packet.episode.gate.map(c => c.input),
      f.fixture.packet.episode.settings);
    const spy = vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes('flyrewheel-workspace-codex-')) {
        retained.push(String(path)); throw new Error('Authored cleanup failure');
      }
      return remove(path, options);
    });
    try {
      expect(await transport.execute(request, new AbortController().signal)).toMatchObject({
        status: 'failed', error: 'Codex runtime cleanup failed: Authored cleanup failure',
        usage: { inputTokens: 7, outputTokens: 5, cachedInputTokens: 2, costMicros: 0 },
        transportEvidence: { cleanup: 'unverified', rawUsage: usage, processEvidence: { processGroupStopped: true } },
      });
      // Restoring filesystem cleanup must not clear this transport's fence.
      spy.mockImplementation(remove);
      expect(await transport.execute(request, new AbortController().signal)).toMatchObject({
        status: 'failed', error: 'Earlier authored worker cleanup is unverified', usage: null,
        transportEvidence: { cleanup: 'unverified', rawUsage: null, processEvidence: null },
      });
      const audit = (await readFile(join(f.workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n');
      expect(audit).toHaveLength(1);
    } finally {
      spy.mockImplementation(remove);
      for (const path of retained) await remove(path, { recursive: true, force: true });
    }
  });

  it('admits M replacement at the same native active-state cap as H/U', async () => {
    const f = await harness(), prepared = validatePacket(f.fixture.packet, f.fixture.future).prepared;
    f.config.limits.renderedPersistentStateBytes = 500;
    expect(Buffer.byteLength(renderState(initialMemory(prepared)))).toBeLessThan(500);
    expect(Buffer.byteLength(renderState(f.fixture.memoryProposal.state!))).toBeLessThan(500);
    const report = await f.run(); expectRoster(report, f.fixture);
    const memory = report.arms.find(a => a.arm === 'M')!;
    expect(memory.disposition).toBe('changed');
    expect(memory.acceptedChange).toBe(true);
    expect(memory.calls[1].nativeRecord!.observations.renderedPersistentStateBytes)
      .toBe(Buffer.byteLength(renderState(f.fixture.memoryProposal.state!)));
    for (const stage of ['gate', 'future'] as const) {
      const call = memory.calls.find(c => c.stage === stage)!;
      expect(call.request).toEqual(report.arms.find(a => a.arm === 'U')!.calls.find(c => c.stage === stage)!.request);
      expect(call.nativeRecord!.observations.renderedPersistentStateBytes).toBe(Buffer.byteLength(renderState(f.fixture.memoryProposal.state!)));
      expect(call.request.prompt).not.toContain('initialLesson');
    }
    expect(report.arms.filter(a => a.arm === 'U' || a.arm === 'H').every(a => a.acceptedChange)).toBe(true);
  }, 15_000);

  it('retains oversized answers and refuses subsequent dispatch, without misreporting a successful native record', async () => {
    const f = await harness(); f.config.limits.answerBytes.review = 1; f.config.limits.answerBytes.proposal = 1;
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls[0]).toMatchObject({ status: 'invalid_output', output: null, nativeRecord: { status: 'failed' } });
      expect(arm.calls[0].nativeRecord!.observations.answerBytes).toBeGreaterThan(1);
      expect(arm.calls.slice(1).every(c => !c.invoked)).toBe(true);
    }
  });

  it('includes cancellation and cleanup in elapsed receipts, retains stop evidence, and never accepts late answers', async () => {
    const f = await harness('setInterval(()=>{},1000);'); f.config.limits.deadlineMsPerCall = 300;
    const report = await f.run(); expectRoster(report, f.fixture);
    for (const arm of report.arms) {
      expect(arm.calls[0]).toMatchObject({ status: 'timeout', output: null, nativeRecord: { status: 'cancelled',
        isolationEvidence: { processGroupStopped: true }, observations: { sdkInvocations: 1 } } });
      const o = arm.calls[0].nativeRecord!.observations;
      expect(o.setupMs! + o.executionMs! + o.cleanupMs!).toBeGreaterThanOrEqual(300);
      expect(arm.calls.slice(1).every(c => !c.invoked)).toBe(true);
    }
  }, 10_000);

  it('charges known supplied diagnosis elapsed time only to U/H/M, blocks unknown upstream elapsed, and fabricates no diagnosis call', async () => {
    const f = await harness(); f.fixture.packet.episode.diagnosis.provenance.elapsedMs = null;
    f.fixture.packet.digest = digestOf(f.fixture.packet.episode);
    const report = await f.run(); expectRoster(report, f.fixture);
    expect(report.arms.find(a => a.arm === 'F')!.calls.every(c => c.invoked)).toBe(true);
    expect(report.arms.filter(a => a.arm !== 'F').flatMap(a => a.calls).every(c => !c.invoked)).toBe(true);
    expect(report.arms.filter(a => a.arm !== 'F').flatMap(a => a.calls)
      .every(c => c.nativeRecord!.observations.armElapsedMsIncludingSharedDiagnosis === null)).toBe(true);
    expect(report.arms.flatMap(a => a.calls).some(c => c.nativeRecord?.role === 'diagnosis')).toBe(false);
  });

  it('charges supplied diagnosis elapsed time before U/H/M admission while F retains its own arm budget', async () => {
    const f = await harness();
    f.fixture.packet.episode.diagnosis.provenance.elapsedMs = f.config.limits.elapsedMsPerArm;
    f.fixture.packet.digest = digestOf(f.fixture.packet.episode);
    const report = await f.run(); expectRoster(report, f.fixture);
    expect(report.arms.find(a => a.arm === 'F')!.calls.every(c => c.invoked)).toBe(true);
    for (const arm of report.arms.filter(a => a.arm !== 'F')) {
      expect(arm.calls.every(c => !c.invoked)).toBe(true);
      expect(arm.calls[0].nativeRecord!.observations.armElapsedMsIncludingSharedDiagnosis).toBeGreaterThanOrEqual(f.config.limits.elapsedMsPerArm);
    }
  });

  it('does not let JSON claims, injected callbacks or native mode open real execution', async () => {
    const f = await harness(), execute = vi.fn();
    const fake = { ...f.transport, execute };
    expect(await runMatchedRevision({ mode: 'authored_fixture', ...f.fixture, native: { configuration: f.config, repetition: 1, transport: fake } }))
      .toMatchObject({ execution: 'not_run', reason: 'authored_native_sdk_transport_required' });
    expect(await runMatchedRevision({ mode: 'production', ...f.fixture, native: { configuration: f.config, repetition: 1, transport: f.transport } }))
      .toMatchObject({ execution: 'not_run', reason: 'production_adapter_unconfigured' });
    expect(execute).not.toHaveBeenCalled();
    expect(() => enforceMatchedCodexExecution({ kind: 'authored-sdk-native-no-model' }, 'isolated-runtime')).toThrow('authored executable boundary');
    expect(SdkNativeMatchedRequestSchema.safeParse({ profile: SDK_NATIVE_PROFILE_VERSION, stage: 'gate', model: 'm', prompt: 'x', outputSchema: {}, sampler: { seed: 0, temperature: 0 } }).success).toBe(false);
  });
});

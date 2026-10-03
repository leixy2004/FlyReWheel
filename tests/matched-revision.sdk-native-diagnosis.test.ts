import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, digestOf } from '../src/core/identity.js';
import { createAuthoredCodexNativeMatchedTransport } from '../src/adapters/matched-revision-codex.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import * as runner from '../experiments/matched-revision/runner.js';
import { validatePacket } from '../experiments/matched-revision/validation.js';
import { SDK_NATIVE_PROFILE_VERSION, type SdkNativeConfiguration } from '../experiments/matched-revision/sdk-native-contracts.js';
import { validateSdkNativeCallRecord } from '../experiments/matched-revision/sdk-native-validation.js';
import { nativeDiagnosisRequest, prepareAuthoredSdkNativeDiagnosisPacket, runAuthoredSdkNativeDiagnosis,
  SDK_NATIVE_AUTHORED_DIAGNOSIS } from '../experiments/matched-revision/sdk-native-diagnosis.js';
import { bindSdkNativeScheduleConfiguration, createSdkNativeSchedule } from '../experiments/matched-revision/sdk-native-schedule.js';
import { runSdkNativeStudy } from '../experiments/matched-revision/sdk-native-study.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { makeRepositoryContextAnchor, makeRepositoryContextEvidence } from '../src/repository-context.js';
import type { ContextReviewFixture } from '../src/core/semantic-review.js';
import { downstreamContext } from './helpers/context-downstream-fixture.js';
const usage = { input_tokens: 7, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 3 };
let root: string, counter = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-shared-diagnosis-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
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

async function harness(diagnosisCode?: string) {
  const fixture = createMatchedFixture(), config = configuration();
  config.limits.dispatchedAttemptsPerArm = 4;
  config.roles.diagnosis = { model: 'authored-diagnosis', modelReasoningEffort: 'medium' };
  const fixtureRoot = join(root, String(++counter)); await mkdir(fixtureRoot);
  const workingDirectory = join(fixtureRoot, 'repo'); await mkdir(workingDirectory);
  const codexPathOverride = join(fixtureRoot, 'script.cjs');
  const { diagnoses, originalContextStatus, revisionContextStatus } = fixture.packet.episode.diagnosis;
  const diagnosis = { diagnoses, originalContextStatus, revisionContextStatus };
  await writeFile(codexPathOverride, `#!${process.execPath}
const fs=require('node:fs'),send=x=>console.log(JSON.stringify(x));
const args=process.argv.slice(2),cwd=args[args.indexOf('--cd')+1];
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
fs.appendFileSync(cwd+'/audit.jsonl',JSON.stringify({args,prompt})+'\\n');
send({type:'thread.started',thread_id:'authored-'+process.pid});
let output;
if(prompt.includes('DIAGNOSIS_INPUT=')) { ${diagnosisCode ?? `output=${JSON.stringify(diagnosis)};`} }
else if(prompt.includes('COMMON_INPUT=')) {
const common=JSON.parse(prompt.split('COMMON_INPUT=')[1].split('\\nEDIT_POLICY=')[0]);
output=common.frozenDiagnosis.diagnoses.some(d=>d.category==='insufficient_evidence')
?{action:'abstain',state:null,replacement:null,rationale:'Authored abstention',evidenceRefs:common.permittedEvidenceRefs,missingEvidence:[],nextStep:'Await evidence'}
:prompt.includes('initialLesson is a lossless')?${JSON.stringify(fixture.memoryProposal)}:${JSON.stringify(fixture.proposal)};
} else {const input=JSON.parse(prompt.split('\\nINPUT=')[1]);output={judgments:input.targets.map(t=>({targetId:t.id,
prediction:({'gate-0':'violation','gate-1':'safe','target-c':'violation','target-d':'safe','target-e':'unresolved'})[t.id],
reason:t.id==='target-e'?'abstained':'judgment',rationale:'Authored response only',evidenceRefs:[t.evidence[0].id],missingEvidence:[]}))};}
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(output)}});
send({type:'turn.completed',usage:${JSON.stringify(usage)}});
});`, { mode: 0o700 });
  const transport = createAuthoredCodexNativeMatchedTransport({ fixtureRoot, workingDirectory, codexPathOverride });
  const packet = prepareAuthoredSdkNativeDiagnosisPacket(fixture.packet, fixture.future, 1);
  const execution = { configuration: config, repetition: 1, transport, diagnosis: SDK_NATIVE_AUTHORED_DIAGNOSIS };
  const prepared = validatePacket(packet, fixture.future, { renderedPersistentStateBytes: 1, model: 'authored', maxOutputBytes: 100_000, timeoutMs: 3000 }).prepared;
  return { fixture, config, packet, execution, prepared, workingDirectory,
    audit: async () => (await readFile(join(workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s)),
    stage: () => runAuthoredSdkNativeDiagnosis({ episode: packet.episode, prepared, execution, blockId: packet.episode.id }),
    run: () => runMatchedRevision({ mode: 'authored_fixture', packet, future: fixture.future, native: execution }) };
}

/** In-memory source-bound context fixture; no repository, database or model. */
function contextFixture(contextCount: number, missing: string[] = []) {
  const fixture = createMatchedFixture(), episode = structuredClone(fixture.packet.episode);
  const selected = episode.revision.feedback[0], original = selected.review.fixtures!;
  if (original.schemaVersion !== 1) throw new Error('Expected legacy fixture');
  const snapshot = episode.revision.snapshots[0];
  const context = downstreamContext(snapshot, 'contracts/selected.txt', 'x'.repeat(contextCount) + 'UNCITED_CONTEXT_SENTINEL');
  const evidence = Array.from({ length: contextCount }, (_, i) => makeRepositoryContextEvidence(context,
    makeRepositoryContextAnchor(context, 'contracts/selected.txt', i, i + 1), 'authored-selected-context'));
  const unused = makeRepositoryContextEvidence(context,
    makeRepositoryContextAnchor(context, 'contracts/selected.txt', contextCount, contextCount + 24), 'uncited-context');
  const fixtures: ContextReviewFixture = { ...original, schemaVersion: 3, repositoryContextDigests: [context.digest],
    evidence: [...original.evidence, ...evidence, unused], judgments: original.judgments.map(j => {
      const selectedTarget = j.targetId === selected.finding.targetId;
      const refs = [...j.evidenceRefs, ...(selectedTarget ? evidence.map(e => e.id) : [])];
      return { targetId: j.targetId, decision: j.decision, reasoning: j.reasoning, evidenceRefs: refs,
        missingContext: selectedTarget ? missing : [], anchorJudgments: j.findingAnchors.map(anchor => ({
          anchor, decision: j.decision, reasoning: j.reasoning, evidenceRefs: refs, missingContext: selectedTarget ? missing : [] })) };
    }) };
  const review = buildSemanticReview({ rule: episode.revision.baseRule, snapshot, fixtures, repositoryContexts: [context] });
  const finding = review.findings.find(f => f.anchor.path === selected.finding.anchor.path)!;
  const feedback = { ...selected.feedback, reviewId: review.id, findingId: finding.id };
  const request = { ...episode.revision.request.request, feedbackBindings: [{ id: feedback.id, digest: digestOf(feedback) }] };
  episode.revision.request = { request, digest: digestOf(request) };
  episode.revision.feedback = [{ feedback, finding, review }];
  episode.diagnosis.diagnoses = [{ ...episode.diagnosis.diagnoses[0],
    evidenceRefs: [`feedback:${feedback.id}`, ...evidence.map(e => `evidence:${e.id}`)] }];
  const packet = { episode, digest: digestOf(episode) };
  return { ...fixture, packet, context, evidence, unused };
}

describe('shared authored SDK diagnosis-only stage', () => {
  it('freezes a native-only unexecuted slot and excludes oracle diagnosis, gate and future labels from the diagnosis prompt', async () => {
    const f = await harness();
    expect(f.packet.episode.diagnosis.provenance).toMatchObject({ origin: 'authored_sdk_diagnosis_pending', upstreamCalls: 0,
      upstreamModel: null, costMicros: null, elapsedMs: null });
    expect(() => validatePacket(f.packet, f.fixture.future)).toThrow(/native-only/);
    const request = nativeDiagnosisRequest(f.packet.episode, f.prepared, f.execution);
    expect(request.stage).toBe('diagnosis');
    const input = JSON.parse(request.prompt.split('DIAGNOSIS_INPUT=')[1]);
    expect(Object.keys(input).sort()).toEqual(['episodeId', 'oldRule', 'sourceCases', 'originalReviewAndFeedback',
      'visibilityAndMissingness', 'retrievalEnvelope', 'permittedEvidenceRefs'].sort());
    for (const forbidden of ['frozenDiagnosis', 'publicRegressionObligations', 'target-c', 'legal_neighbor', 'EDIT_POLICY=',
      f.fixture.packet.episode.diagnosis.diagnoses[0].reasoning]) expect(request.prompt).not.toContain(forbidden);
    expect(request.prompt).toContain(f.fixture.packet.episode.revision.feedback[0].feedback.id);
    expect(() => createSdkNativeSchedule({ schedulingSeed: 1, repetitions: 1, conditions: ['inferred'],
      blocks: [{ packet: f.packet, future: f.fixture.future, repetition: 1 }] })).toThrow(/Diagnosis schedule mode/);
  });

  it('retains selected original missing-context facts and context coverage without exposing uncited package bytes', () => {
    const f = contextFixture(1, ['Original selected caller contract is missing']);
    const packet = prepareAuthoredSdkNativeDiagnosisPacket(f.packet, f.future, 1);
    const prepared = validatePacket(packet, f.future, { renderedPersistentStateBytes: 1,
      model: 'authored', maxOutputBytes: 100_000, timeoutMs: 3000 }).prepared;
    const request = nativeDiagnosisRequest(packet.episode, prepared, { configuration: configuration() });
    const selected = JSON.parse(request.prompt.split('DIAGNOSIS_INPUT=')[1]).originalReviewAndFeedback[0];
    expect(selected.selectedTargetJudgment.missingContext).toEqual(['Original selected caller contract is missing']);
    expect(selected.selectedAnchorJudgment.missingContext).toEqual(['Original selected caller contract is missing']);
    expect(selected.repositoryContextBinding).toEqual(prepared.repositoryContextBindings[0]);
    expect(selected.repositoryContexts[0].coverage).toEqual(f.context.context.coverage);
    expect(request.prompt).toContain(f.evidence[0].id);
    expect(request.prompt).not.toContain(f.unused.id); expect(request.prompt).not.toContain('UNCITED_CONTEXT_SENTINEL');
    expect(request.prompt).not.toContain('bytesBase64');
  });

  it('preserves a failed call and a valid administrative Unknown at the 300-reference boundary', async () => {
    const h = await harness('output={unexpected:true};'), f = contextFixture(299);
    const packet = prepareAuthoredSdkNativeDiagnosisPacket(f.packet, f.future, 1);
    const prepared = validatePacket(packet, f.future, { renderedPersistentStateBytes: 1,
      model: 'authored', maxOutputBytes: 100_000, timeoutMs: 3000 }).prepared;
    expect(packet.episode.diagnosis.diagnoses[0].evidenceRefs).toHaveLength(300);
    h.config.limits.serializedRequestBytes = 2_000_000;
    const result = await runAuthoredSdkNativeDiagnosis({ episode: packet.episode, prepared, execution: h.execution, blockId: packet.episode.id });
    expect(result).toMatchObject({ status: 'administrative_unknown', call: { invoked: true, status: 'failed' } });
    expect(result.sharedDiagnosis.diagnoses[0].evidenceRefs).toHaveLength(300);
    expect(await h.audit()).toHaveLength(1);
  });

  it('executes one independent diagnosis before proposals and shares byte-identical locked supervision and standalone allocation across U/H/M', async () => {
    const f = await harness(), report = await f.run();
    if (report.execution !== 'completed' || !report.diagnosisStage) throw new Error('Missing diagnosis report');
    const stage = report.diagnosisStage, audit = await f.audit();
    expect(audit).toHaveLength(12); expect(audit[0].prompt).toContain('DIAGNOSIS_INPUT=');
    expect(stage).toMatchObject({ executionKind: 'authored_sdk_no_model', modelExecution: 'not_run', empiricalEpisodes: 0,
      attemptsScheduled: 1, retries: 0, status: 'authored_output_locked', sharedDiagnosis: { condition: 'inferred',
        provenance: { origin: 'authored_sdk_diagnosis_no_model', upstreamCalls: 0, upstreamModel: null, costMicros: null } },
      call: { stage: 'diagnosis', nativeRecord: { arm: null, role: 'diagnosis', status: 'authored_completed',
        observations: { sdkInvocations: 1, providerCalls: 0, armDispatchedAttempts: null, armElapsedMsIncludingSharedDiagnosis: null,
          rawUsage: usage, cost: { status: 'unknown', costMicros: null, currency: null } } } } });
    expect(validateSdkNativeCallRecord(stage.call.nativeRecord!, f.config)).toEqual(stage.call.nativeRecord);
    const updating = report.arms.filter(a => a.arm !== 'F');
    const bytes = updating.map(a => canonicalJson(JSON.parse(a.calls[0].request.prompt.split('COMMON_INPUT=')[1].split('\nEDIT_POLICY=')[0]).frozenDiagnosis));
    expect(new Set(bytes)).toEqual(new Set([canonicalJson(stage.sharedDiagnosis)]));
    expect(new Set(updating.map(a => a.sharedDiagnosisDigest)).size).toBe(1);
    for (const arm of updating) {
      expect(arm.usage.standalone.totalCalls).toBe(4);
      expect(arm.usage.standalone).toMatchObject({ sharedDiagnosisAllocation: stage.allocation });
      expect(arm.calls.at(-1)!.nativeRecord!.observations.armDispatchedAttempts).toBe(4);
      expect(arm.calls[0].nativeRecord!.observations.armElapsedMsIncludingSharedDiagnosis).toBeGreaterThanOrEqual(stage.allocation.elapsedMs);
    }
    expect(report.arms.find(a => a.arm === 'F')!.usage.standalone).toMatchObject({ sharedDiagnosisAllocation: null });
    expect(await f.stage()).toBe(stage); expect(await f.audit()).toHaveLength(12);
    const altered = structuredClone(f.packet.episode); altered.visibilityAndMissingness += 'changed';
    expect(() => runAuthoredSdkNativeDiagnosis({ episode: altered, prepared: f.prepared, execution: f.execution, blockId: altered.id })).toThrow(/already locked/);
    const changed = structuredClone(f.config); changed.roles.diagnosis.model = 'changed-authored-model';
    expect(() => runAuthoredSdkNativeDiagnosis({ episode: f.packet.episode, prepared: f.prepared,
      execution: { ...f.execution, configuration: changed }, blockId: f.packet.episode.id })).toThrow(/already locked/);
  }, 20_000);

  it('locks a pre-dispatch byte failure without claiming a physical SDK call or retrying', async () => {
    const f = await harness(); f.config.limits.serializedRequestBytes = 1;
    const stage = await f.stage();
    expect(stage).toMatchObject({ status: 'administrative_unknown', allocation: { sdkInvocations: 0 },
      call: { invoked: false, status: 'budget_exhausted', nativeRecord: { status: 'not_dispatched' } } });
    expect(await f.stage()).toBe(stage);
    await expect(f.audit()).rejects.toThrow();
  });

  it.each(['unknown-citation', 'duplicate-feedback', 'missing-own-citation'])('locks administrative Unknown after %s without a diagnosis reroll', async failure => {
    const fixture = createMatchedFixture(), d = fixture.packet.episode.diagnosis;
    const diagnoses = structuredClone(d.diagnoses);
    if (failure === 'unknown-citation') diagnoses[0].evidenceRefs.push('future:hidden');
    if (failure === 'duplicate-feedback') diagnoses.push(structuredClone(diagnoses[0]));
    if (failure === 'missing-own-citation') diagnoses[0].evidenceRefs = [diagnoses[0].evidenceRefs[1]];
    const f = await harness(`output=${JSON.stringify({ diagnoses, originalContextStatus: d.originalContextStatus, revisionContextStatus: d.revisionContextStatus })};`);
    const stage = await f.stage();
    expect(stage.status).toBe('administrative_unknown'); expect(stage.failure).toBeTruthy();
    expect(stage.call.nativeRecord!.status).toBe('failed');
    expect(stage.sharedDiagnosis.diagnoses.every(d => d.category === 'insufficient_evidence' && d.missingEvidence.length)).toBe(true);
    expect(stage.sharedDiagnosis.originalContextStatus).toBe('unknown');
    expect(stage.sharedDiagnosis.provenance.rawFailure).toBe(stage.failure);
    expect(await f.stage()).toBe(stage); expect(await f.audit()).toHaveLength(1);
  });

  it('lets bounded failed diagnosis become a shared administrative Unknown without applying hard restrictions to U/M', async () => {
    const f = await harness('output={unexpected:true};'), report = await f.run();
    if (report.execution !== 'completed') throw new Error('Not run');
    expect(report.diagnosisStage!.status).toBe('administrative_unknown');
    expect(report.arms.filter(a => a.arm !== 'F').every(a => a.disposition === 'abstained')).toBe(true);
    expect(report.arms.every(a => a.future.length === 3)).toBe(true);
    expect((await f.audit()).filter(a => a.prompt.includes('DIAGNOSIS_INPUT='))).toHaveLength(1);
  }, 20_000);

  it('retains missing raw usage, blocks U/H/M, preserves F and every planned target', async () => {
    const f = await harness(`send({type:'turn.completed',usage:{input_tokens:7,output_tokens:5}});return;`), report = await f.run();
    if (report.execution !== 'completed') throw new Error('Not run');
    expect(report.diagnosisStage!.allocation).toMatchObject({ rawUsage: { cached_input_tokens: null }, cost: { status: 'unknown' } });
    expect(report.diagnosisStage!.allocation.blocker).toContain('unknown usage');
    expect(report.arms.filter(a => a.arm !== 'F').flatMap(a => a.calls).every(c => !c.invoked)).toBe(true);
    expect(report.arms.find(a => a.arm === 'F')!.calls.every(c => c.invoked)).toBe(true);
    expect(report.arms.every(a => a.future.length === 3)).toBe(true);
    expect(await f.audit()).toHaveLength(3);
  });

  it('retains diagnosis deadline and answer-limit failures with stop receipts and no retry', async () => {
    for (const timeout of [false, true]) {
      const f = await harness(timeout ? 'setInterval(()=>{},1000);return;' : undefined);
      if (timeout) f.config.limits.deadlineMsPerCall = 300; else f.config.limits.answerBytes.diagnosis = 1;
      const stage = await f.stage();
      expect(stage.status).toBe('administrative_unknown');
      expect(stage.call.status).toBe(timeout ? 'timeout' : 'invalid_output');
      expect(stage.call.nativeRecord!.isolationEvidence.processGroupStopped).toBe(true);
      expect(stage.allocation.blocker).toBeTruthy(); expect(await f.stage()).toBe(stage);
      expect(await f.audit()).toHaveLength(1);
    }
  }, 10_000);

  it('charges the single diagnosis dispatch against each standalone arm budget without charging F', async () => {
    const f = await harness(); f.config.limits.dispatchedAttemptsPerArm = 3;
    const report = await f.run(); if (report.execution !== 'completed') throw new Error('Not run');
    expect(report.arms.filter(a => a.arm !== 'F').every(a => a.calls[0].invoked && a.calls[1].invoked && !a.calls[2].invoked)).toBe(true);
    expect(report.arms.find(a => a.arm === 'F')!.calls.every(c => c.invoked)).toBe(true);
  }, 20_000);

  it('cannot relabel a produced diagnosis as a supplied packet or bypass production admission', async () => {
    const f = await harness(), stage = await f.stage();
    const packet = structuredClone(f.packet); packet.episode.diagnosis = stage.sharedDiagnosis;
    packet.episode.frozenAt = stage.sharedDiagnosis.lockedAt; packet.digest = digestOf(packet.episode);
    await expect(runMatchedRevision({ mode: 'authored_fixture', packet, future: f.fixture.future, native: f.execution })).rejects.toThrow(/produced by/);
    expect(await runMatchedRevision({ mode: 'production', packet: f.packet, future: f.fixture.future, native: f.execution }))
      .toMatchObject({ execution: 'not_run', modelExecution: 'not_run' });
    expect(await f.audit()).toHaveLength(1);
  });

  it('executes distinct scheduled diagnosis slots per repeat, retains missing blocks, and records diagnosis before arm calls', async () => {
    const f = await harness();
    const source = [1, 2, 3].map(repetition => ({ packet: prepareAuthoredSdkNativeDiagnosisPacket(f.fixture.packet, f.fixture.future, repetition),
      future: f.fixture.future, repetition }));
    const schedule = createSdkNativeSchedule({ schedulingSeed: 12, repetitions: 3, conditions: ['inferred'], blocks: source,
      diagnosis: 'authored-sdk-once-per-inferred-block' });
    const config = bindSdkNativeScheduleConfiguration(f.config, schedule);
    const blocks = schedule.blocks.slice(0, 2).map(b => ({ blockId: b.blockId, ...source.find(s => s.repetition === b.repetition)! }));
    const report = await runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration: config, blocks, transport: f.execution.transport });
    if (report.execution !== 'completed') throw new Error('Not run');
    expect(report.counts).toMatchObject({ plannedBlocks: 3, completedBlocks: 2, missingBlocks: 1, retries: 0 });
    const completed = report.blocks.filter(b => b.report);
    expect(new Set(completed.map(b => b.diagnosisSlot!.record!.digest)).size).toBe(2);
    expect(completed.every(b => b.actualCallOrder[0].stage === 'diagnosis' && b.actualCallOrder[0].arm === null)).toBe(true);
    expect(report.blocks.find(b => !b.report)!.diagnosisSlot).toEqual({ scheduled: 1, status: 'missing', record: null });
    expect((await f.audit()).filter(a => a.prompt.includes('DIAGNOSIS_INPUT='))).toHaveLength(2);
  }, 30_000);

  it('retains a locked diagnosis record if block reporting is interrupted, without rerunning it', async () => {
    const f = await harness();
    const source = [{ packet: f.packet, future: f.fixture.future, repetition: 1 }];
    const schedule = createSdkNativeSchedule({ schedulingSeed: 9, repetitions: 1, conditions: ['inferred'], blocks: source,
      diagnosis: 'authored-sdk-once-per-inferred-block' });
    const config = bindSdkNativeScheduleConfiguration(f.config, schedule), original = runner.runMatchedRevision;
    const spy = vi.spyOn(runner, 'runMatchedRevision').mockImplementationOnce(async input => {
      await original(input); throw new Error('Authored report interruption');
    });
    try {
      const report = await runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration: config,
        blocks: [{ ...source[0], blockId: schedule.blocks[0].blockId }], transport: f.execution.transport });
      if (report.execution !== 'completed') throw new Error('Not run');
      expect(report.blocks[0]).toMatchObject({ interrupted: true, status: 'failed', diagnosisSlot: { status: 'authored_output_locked' } });
      expect(report.blocks[0].actualCallOrder).toHaveLength(12);
    } finally { spy.mockRestore(); }
  }, 20_000);
});

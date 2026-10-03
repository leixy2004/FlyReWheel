import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digestOf } from '../../src/core/identity.js';
import { createMatchedFixture } from '../../experiments/matched-revision/fixture.js';
import { SDK_NATIVE_PROFILE_VERSION, type SdkNativeConfiguration } from '../../experiments/matched-revision/sdk-native-contracts.js';
import { prepareAuthoredSdkNativeDiagnosisPacket } from '../../experiments/matched-revision/sdk-native-diagnosis.js';
import { createSdkNativeSchedule, bindSdkNativeScheduleConfiguration } from '../../experiments/matched-revision/sdk-native-schedule.js';
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

export async function createRecoveryFixture(fixtureRoot: string, repetitions = 1) {
  await mkdir(fixtureRoot, { recursive: true });
  const fixture = createMatchedFixture(), config = configuration();
  config.limits.dispatchedAttemptsPerArm = 4;
  const workingDirectory = join(fixtureRoot, 'repo'); await mkdir(workingDirectory);
  const codexPathOverride = join(fixtureRoot, 'script.cjs'), diagnosisCode = undefined;
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

  const sources = Array.from({ length: repetitions }, (_, i) => ({ repetition: i + 1,
    packet: prepareAuthoredSdkNativeDiagnosisPacket(fixture.packet, fixture.future, i + 1), future: fixture.future }));
  const schedule = createSdkNativeSchedule({ schedulingSeed: 9, repetitions, conditions: ['inferred'],
    diagnosis: 'authored-sdk-once-per-inferred-block', blocks: sources });
  const configurationBound = bindSdkNativeScheduleConfiguration(config, schedule);
  const blocks = schedule.blocks.map(block => {
    const source = sources.find(s => s.repetition === block.repetition)!;
    return { blockId: block.blockId, packet: source.packet, future: source.future };
  });
  return { mode: 'authored_fixture' as const, schedule, configuration: configurationBound, blocks,
    transportOptions: { workingDirectory, fixtureRoot, codexPathOverride } };
}

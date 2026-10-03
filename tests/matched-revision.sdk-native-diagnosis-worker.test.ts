import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createAuthoredCodexMatchedTransport, createAuthoredCodexNativeMatchedTransport,
  runMatchedCodexRequest } from '../src/adapters/matched-revision-codex.js';
import { runCodexWorkspaceWorker } from '../src/adapters/codex-workspace-worker.js';
import { MatchedDiagnosisSchema, MatchedModelRequestSchema, ProposalSchema, SdkNativeMatchedRequestSchema,
  type MatchedModelRequest } from '../src/core/matched-revision-model.js';
import { runWorkspaceWorkerCommand } from '../src/workspace-worker-entrypoint.js';
import { MatchedDiagnosisWorkspaceWorkerResult, MatchedWorkspaceWorkerResult,
  WorkspaceWorkerInput } from '../src/workspace/worker-protocol.js';

const answer = {
  diagnoses: [{ feedbackId: 'feedback-one', category: 'context' as const, reasoning: 'Selected caller evidence is incomplete.',
    missingEvidence: ['Caller deadline'], evidenceRefs: ['selected:caller'], claim: 'proposal-not-established-fact' as const }],
  originalContextStatus: 'decisive_evidence_absent' as const, revisionContextStatus: 'still_missing' as const,
};
const usage = { input_tokens: 8, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 4, reasoning_output_tokens: 2 };
const limits = { maxInputBytes: 100_000, maxOutputBytes: 50_000, maxArtifactBytes: 4096, maxArtifacts: 0,
  timeoutMs: 2000, cleanupTimeoutMs: 1500 };
const request = SdkNativeMatchedRequestSchema.parse({ profile: 'paired-restriction-sdk-native-v1-draft', stage: 'diagnosis',
  model: 'authored-diagnosis', modelReasoningEffort: 'high', prompt: 'Authored selected-evidence diagnosis only.',
  outputSchema: z.toJSONSchema(MatchedDiagnosisSchema) });
let root: string, counter = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-native-diagnosis-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function response(value: unknown = answer) {
  return `send({type:'thread.started',thread_id:'authored-'+process.pid});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(value)})}});
send({type:'turn.completed',usage:${JSON.stringify(usage)}});`;
}
async function harness(code = response()) {
  const fixtureRoot = join(root, String(++counter)); await mkdir(fixtureRoot);
  const workingDirectory = join(fixtureRoot, 'repo'); await mkdir(workingDirectory);
  const codexPathOverride = join(fixtureRoot, 'authored.cjs');
  await writeFile(codexPathOverride, `#!${process.execPath}
const fs=require('node:fs'),send=x=>console.log(JSON.stringify(x)),args=process.argv.slice(2),cwd=args[args.indexOf('--cd')+1];
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
fs.writeFileSync(cwd+'/audit.json',JSON.stringify({args,prompt,env:Object.keys(process.env).sort(),schema:JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))}));
${code}
});`, { mode: 0o700 });
  const options = { fixtureRoot, workingDirectory, codexPathOverride };
  const input = WorkspaceWorkerInput.parse({ workingDirectory, model: request.model, modelReasoningEffort: 'high',
    prompt: request.prompt, outputContract: 'matched-diagnosis-v1', matchedExecution: { kind: 'authored-sdk-native-no-model' },
    toolPolicy: 'selected-evidence-no-tools-v1', historyPolicy: 'all-local-refs-v1', limits });
  return { ...options, input, transport: createAuthoredCodexNativeMatchedTransport(options),
    audit: () => readFile(join(workingDirectory, 'audit.json'), 'utf8').then(JSON.parse) };
}

describe('separate authored SDK-native diagnosis worker contract', () => {
  it('contains only diagnosis assessments and keeps frozen legacy request stages unchanged', () => {
    expect(MatchedDiagnosisSchema.parse(answer)).toEqual(answer);
    expect(MatchedModelRequestSchema.shape.stage.options).toEqual(['proposal', 'gate', 'future']);
    expect(SdkNativeMatchedRequestSchema.shape.stage.options).toEqual(['diagnosis', 'proposal', 'gate', 'future']);
    expect(SdkNativeMatchedRequestSchema.parse(request)).toEqual(request);
    expect(MatchedModelRequestSchema.safeParse({ ...request, profile: undefined,
      sampler: { temperature: 0, seed: 1 }, maxOutputTokens: 100 }).success).toBe(false);
    expect(SdkNativeMatchedRequestSchema.safeParse({ ...request, sampler: { temperature: 0, seed: 1 } }).success).toBe(false);
    expect(SdkNativeMatchedRequestSchema.safeParse({ ...request, maxOutputTokens: 100 }).success).toBe(false);
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, diagnoses: [] }).success).toBe(false);
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, diagnoses: Array(100).fill(answer.diagnoses[0]) }).success).toBe(true);
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, diagnoses: Array(101).fill(answer.diagnoses[0]) }).success).toBe(false);
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, originalContextStatus: 'sufficient' }).success).toBe(false);
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, revisionContextStatus: 'decisive_evidence_present' }).success).toBe(false);
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, diagnoses: [{ ...answer.diagnoses[0], claim: 'established-fact' }] }).success).toBe(false);
  });
  it.each(['provenance', 'condition', 'identity', 'state', 'proposal', 'action', 'arm', 'schemaVersion'])
  ('rejects model-writable %s fields', field => {
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, [field]: null }).success).toBe(false);
    expect(MatchedDiagnosisSchema.safeParse({ ...answer, diagnoses: [{ ...answer.diagnoses[0], [field]: null }] }).success).toBe(false);
  });
  it('requires the native execution identity and selected-evidence no-tools policy', async () => {
    const f = await harness();
    expect(WorkspaceWorkerInput.parse(f.input)).toEqual(f.input);
    for (const matchedExecution of [undefined, { kind: 'authored-script-controls-not-enforced' },
      { kind: 'enforce-frozen-controls', sampler: { temperature: 0, seed: 1 }, maxOutputTokens: 100 }]) {
      expect(WorkspaceWorkerInput.safeParse({ ...f.input, matchedExecution }).success).toBe(false);
    }
    expect(WorkspaceWorkerInput.safeParse({ ...f.input, toolPolicy: 'full-repo-shell-v1' }).success).toBe(false);
    expect(WorkspaceWorkerInput.safeParse({ ...f.input, outputContract: undefined }).success).toBe(false);
    await expect(access(join(f.workingDirectory, 'audit.json'))).rejects.toThrow();
  });
  it('dispatches the fixed diagnosis schema through the official SDK, with fresh supervised no-model sessions', async () => {
    const f = await harness(), signal = new AbortController().signal;
    const first = await f.transport.execute(request, limits, signal);
    const second = await f.transport.execute(request, limits, signal);
    expect(first).toMatchObject({ status: 'completed', output: answer, error: null, usage, rawUsage: usage,
      cleanupVerified: true, observations: { sdkInvocations: 1, answerBytes: Buffer.byteLength(JSON.stringify(answer)) },
      processEvidence: { processGroupStopped: true, reason: 'completed', modelReasoningEffort: 'high' } });
    expect(second.status).toBe('completed'); expect(first.sessionId).not.toBe(second.sessionId);
    const audit = await f.audit();
    expect(audit.schema).toEqual(z.toJSONSchema(MatchedDiagnosisSchema));
    expect(audit.prompt).toBe(request.prompt);
    expect(audit.args).toEqual(expect.arrayContaining(['--model', 'authored-diagnosis', 'model_reasoning_effort="high"',
      'read-only', 'features.shell_tool=false', 'features.unified_exec=false']));
    expect(audit.args.some((arg: string) => /temperature|seed|max_output_tokens|resume/.test(arg))).toBe(false);
    expect(audit.env).toEqual(['CODEX_HOME', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'HOME', 'LANG', 'LC_ALL', 'PATH']);
  });
  it('routes the worker entrypoint to the strict versioned diagnosis result', async () => {
    const f = await harness(), requestPath = join(f.fixtureRoot, 'request.json');
    await writeFile(requestPath, JSON.stringify(f.input));
    const result = JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], {
      kind: 'authored-test-no-isolation', fixtureRoot: f.fixtureRoot, workingDirectory: f.workingDirectory,
      requestPath, codexPathOverride: f.codexPathOverride,
      imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway',
        baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } },
    }));
    expect(MatchedDiagnosisWorkspaceWorkerResult.parse(result)).toMatchObject({ protocolVersion: 2,
      outputContract: 'matched-diagnosis-v1', value: answer, usage, boundary: 'authored-test-no-isolation',
      processEvidence: { processGroupStopped: true } });
    expect(MatchedWorkspaceWorkerResult.parse(result)).toEqual(result);
    expect(MatchedDiagnosisWorkspaceWorkerResult.safeParse({ ...result, outputContract: 'matched-proposal-v1' }).success).toBe(false);
    expect(MatchedDiagnosisWorkspaceWorkerResult.safeParse({ ...result, boundary: 'isolated-runtime' }).success).toBe(false);
    expect((await f.audit()).schema).toEqual(z.toJSONSchema(MatchedDiagnosisSchema));
  });
  it('rejects schema substitution, legacy dispatch and isolated runtime use before invocation', async () => {
    const f = await harness(), signal = new AbortController().signal;
    const invalid = await f.transport.execute({ ...request, outputSchema: z.toJSONSchema(ProposalSchema) }, limits, signal);
    expect(invalid).toMatchObject({ status: 'failed', error: 'Matched request must use the fixed stage output schema',
      observations: { sdkInvocations: 0 } });
    const { profile: _profile, ...base } = request;
    const legacy = { ...base, sampler: { temperature: 0, seed: 1 }, maxOutputTokens: 100 } as unknown as MatchedModelRequest;
    const transport = createAuthoredCodexMatchedTransport({ fixtureRoot: f.fixtureRoot, workingDirectory: f.workingDirectory,
      codexPathOverride: f.codexPathOverride, limits });
    expect(await transport.execute(legacy, signal)).toMatchObject({ status: 'failed', transportEvidence: { cleanup: 'not_started' } });
    await expect(runMatchedCodexRequest(legacy, { workingDirectory: f.workingDirectory, limits }, {
      codexPathOverride: f.codexPathOverride, boundary: { kind: 'authored-test-no-isolation', fixtureRoot: f.fixtureRoot },
    }, signal)).rejects.toThrow();
    const verify = vi.fn(async () => {});
    await expect(runCodexWorkspaceWorker(f.input, MatchedDiagnosisSchema, { codexPathOverride: f.codexPathOverride,
      boundary: { kind: 'isolated-runtime', verify } }, signal)).rejects.toThrow('authored executable boundary');
    expect(verify).not.toHaveBeenCalled();
    await expect(access(join(f.workingDirectory, 'audit.json'))).rejects.toThrow();
  });
  it('retains strict diagnosis-only validation and usage/cleanup evidence for malformed answers', async () => {
    const f = await harness(response({ ...answer, state: { kind: 'structured' } }));
    const result = await f.transport.execute(request, limits, new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', output: null, usage, rawUsage: usage,
      cleanupVerified: true, observations: { sdkInvocations: 1 }, processEvidence: { processGroupStopped: true } });
    expect(result.error).toContain('state');
  });
  it('enforces optional outer selected-evidence bindings inside the supervised worker', async () => {
    const f = await harness();
    const matchedEvidence = { stage: 'diagnosis' as const, feedback: [{ feedbackId: 'feedback-one',
      evidenceRefs: ['other-feedback-evidence'], requiredEvidenceRefs: [] }] };
    await expect(runCodexWorkspaceWorker({ ...f.input, matchedEvidence }, MatchedDiagnosisSchema, {
      codexPathOverride: f.codexPathOverride, boundary: { kind: 'authored-test-no-isolation', fixtureRoot: f.fixtureRoot },
    })).rejects.toMatchObject({ message: 'Matched result cites evidence outside its selected scope',
      usage, processEvidence: { processGroupStopped: true }, retainedRuntimePath: null });
  });
  it('rejects tools in diagnosis responses with cleanup still verified', async () => {
    const f = await harness(`send({type:'thread.started',thread_id:'authored-tools'});
send({type:'item.completed',item:{id:'tool',type:'command_execution',command:'authored',aggregated_output:'',exit_code:0,status:'completed'}});`);
    const result = await f.transport.execute(request, limits, new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', cleanupVerified: true,
      error: 'Selected-evidence worker cannot use tools or change files', processEvidence: { processGroupStopped: true } });
  });
  it('honors pre-dispatch cancellation without starting an authored process', async () => {
    const f = await harness(), controller = new AbortController(); controller.abort();
    const result = await f.transport.execute(request, limits, controller.signal);
    expect(result).toMatchObject({ status: 'failed', error: 'Codex worker cancelled before launch',
      observations: { sdkInvocations: 0 }, processEvidence: null });
    await expect(access(join(f.workingDirectory, 'audit.json'))).rejects.toThrow();
  });
  it('cancels a running diagnosis through the same independent supervisor', async () => {
    const f = await harness(`send({type:'thread.started',thread_id:'authored-hanging'});setInterval(()=>{},1000);`);
    const controller = new AbortController(), pending = f.transport.execute(request, limits, controller.signal);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try { await access(join(f.workingDirectory, 'audit.json')); break; } catch { await delay(10); }
    }
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', output: null, cleanupVerified: true,
      error: 'Codex workspace worker cancelled', observations: { sdkInvocations: 1 },
      processEvidence: { reason: 'cancelled', processGroupStopped: true } });
  });
});

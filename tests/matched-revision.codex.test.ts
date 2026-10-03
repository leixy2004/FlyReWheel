import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAuthoredCodexMatchedTransport, preflightMatchedCodexControls, runMatchedCodexRequest } from '../src/adapters/matched-revision-codex.js';
import { runCodexWorkspaceWorker } from '../src/adapters/codex-workspace-worker.js';
import { MatchedModelRequestSchema, ProposalSchema, ReviewSchema, type MatchedModelRequest } from '../src/core/matched-revision-model.js';
import { CODEX_MODEL_REASONING_EFFORTS, CodexModelReasoningEffortSchema } from '../src/core/codex-model-settings.js';
import { digestOf } from '../src/core/identity.js';
import { WorkspaceWorkerInput } from '../src/workspace/worker-protocol.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { proposalRequest, reviewRequest } from '../experiments/matched-revision/prompts.js';
import { commonRevisionBlock, initialStructured, validatePacket } from '../experiments/matched-revision/validation.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import { SettingsSchema } from '../experiments/matched-revision/contracts.js';

let root: string, counter = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-matched-sdk-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const usage = { input_tokens: 7, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 1 };
const complete = (output: unknown) => `send({type:'thread.started',thread_id:'authored-session'});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(output)})}});
send({type:'turn.completed',usage:${JSON.stringify(usage)}});`;
async function harness(code?: string) {
  const fixtureRoot = join(root, String(++counter)); await mkdir(fixtureRoot);
  const workingDirectory = join(fixtureRoot, 'repo'); await mkdir(workingDirectory);
  const codexPathOverride = join(fixtureRoot, 'script.cjs');
  const authored = createMatchedFixture();
  await writeFile(codexPathOverride, `#!${process.execPath}
const fs=require('node:fs'), send=x=>console.log(JSON.stringify(x));
const args=process.argv.slice(2), cwd=args[args.indexOf('--cd')+1];
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
fs.writeFileSync(cwd+'/audit.json',JSON.stringify({args,prompt,env:Object.keys(process.env).sort(),schema:JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))}));
${code ?? complete(authored.proposal)}
});`, { mode: 0o700 });
  const limits = { maxInputBytes: 200_000, maxOutputBytes: 100_000, maxArtifactBytes: 1, maxArtifacts: 0, timeoutMs: 2000, cleanupTimeoutMs: 1500 };
  const options = { workingDirectory, fixtureRoot, codexPathOverride, limits };
  const prepared = validatePacket(authored.packet, authored.future).prepared;
  const request = proposalRequest('U', commonRevisionBlock(authored.packet.episode, prepared), authored.packet.episode.settings);
  return { options, authored, request, prepared, transport: createAuthoredCodexMatchedTransport(options) };
}

describe('matched Codex bridge using only authored executables', () => {
  it('matches the installed SDK reasoning-effort type without inventing a default', () => {
    expectTypeOf<z.infer<typeof CodexModelReasoningEffortSchema>>().toEqualTypeOf<ModelReasoningEffort>();
    expect(CODEX_MODEL_REASONING_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
    const settings = SettingsSchema.parse(createMatchedFixture().packet.episode.settings);
    expect(settings).not.toHaveProperty('modelReasoningEffort');
  });
  it('reports all unsupported frozen controls and refuses before spawning or verifying a runtime', async () => {
    const f = await harness(), verify = vi.fn(async () => {});
    const preflight = preflightMatchedCodexControls({ sampler: f.request.sampler, maxOutputTokens: f.request.maxOutputTokens });
    expect(preflight).toMatchObject({ supported: false, unsupportedControls: ['sampler.temperature', 'sampler.seed', 'maxOutputTokens'],
      capabilities: { version: '0.159.2', tokenUsage: 'reported-postflight', modelTokenizer: 'unavailable' } });
    await expect(runMatchedCodexRequest(f.request, f.options, { codexPathOverride: f.options.codexPathOverride,
      boundary: { kind: 'isolated-runtime', verify } })).rejects.toThrow(/unsupported before dispatch/);
    await expect(runMatchedCodexRequest({ ...f.request, modelReasoningEffort: 'high' }, f.options,
      { codexPathOverride: f.options.codexPathOverride, boundary: { kind: 'isolated-runtime', verify } })).rejects.toThrow(/unsupported before dispatch/);
    expect(verify).not.toHaveBeenCalled();
    await expect(access(join(f.options.workingDirectory, 'audit.json'))).rejects.toThrow();
  });
  it('requires an explicit execution kind and refuses the authored exception under an isolated boundary', async () => {
    const f = await harness();
    const input = { workingDirectory: f.options.workingDirectory, model: f.request.model, prompt: f.request.prompt,
      outputContract: 'matched-proposal-v1' as const, toolPolicy: 'selected-evidence-no-tools-v1' as const,
      historyPolicy: 'all-local-refs-v1' as const, limits: f.options.limits };
    expect(WorkspaceWorkerInput.safeParse(input).success).toBe(false);
    const verify = vi.fn(async () => {});
    await expect(runCodexWorkspaceWorker({ ...input, matchedExecution: { kind: 'authored-script-controls-not-enforced' } }, ProposalSchema,
      { codexPathOverride: f.options.codexPathOverride, boundary: { kind: 'isolated-runtime', verify } })).rejects.toThrow(/authored executable boundary/);
    expect(verify).not.toHaveBeenCalled();
    expect(WorkspaceWorkerInput.safeParse({ ...input, outputContract: 'rule-revision-v3',
      matchedExecution: { kind: 'authored-script-controls-not-enforced' } }).success).toBe(false);
  });
  it('uses the fixed neutral proposal schema, unchanged prompt, no tools and a fresh supervised SDK thread', async () => {
    const f = await harness();
    const result = await f.transport.execute(f.request, new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', output: f.authored.proposal,
      usage: { inputTokens: 7, outputTokens: 5, cachedInputTokens: 2, costMicros: 0 },
      transportEvidence: { controls: 'not-enforced-authored-script', modelCalls: 0, rawUsage: usage,
        cleanup: 'verified', processEvidence: { processGroupStopped: true } } });
    const audit = JSON.parse(await readFile(join(f.options.workingDirectory, 'audit.json'), 'utf8'));
    expect(audit.prompt).toBe(f.request.prompt); expect(audit.schema).toEqual(z.toJSONSchema(ProposalSchema));
    expect(audit.args).toEqual(expect.arrayContaining(['read-only', 'features.shell_tool=false', 'features.unified_exec=false', 'web_search="disabled"', 'approval_policy="never"']));
    expect(audit.args.some((arg: string) => /temperature|seed|max_output_tokens|resume/.test(arg))).toBe(false);
    expect(audit.args.some((arg: string) => arg.startsWith('model_reasoning_effort='))).toBe(false);
    expect(MatchedModelRequestSchema.parse(f.request)).not.toHaveProperty('modelReasoningEffort');
    expect(result.transportEvidence.processEvidence).not.toHaveProperty('modelReasoningEffort');
    expect(audit.env).toEqual(['CODEX_HOME', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'HOME', 'LANG', 'LC_ALL', 'PATH']);
  });
  it.each(CODEX_MODEL_REASONING_EFFORTS)('forwards explicit %s through the official SDK and retains it in process evidence', async modelReasoningEffort => {
    const f = await harness();
    const result = await f.transport.execute({ ...f.request, modelReasoningEffort }, new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', transportEvidence: { modelCalls: 0,
      processEvidence: { modelReasoningEffort, processGroupStopped: true } } });
    const audit = JSON.parse(await readFile(join(f.options.workingDirectory, 'audit.json'), 'utf8'));
    const expected = `model_reasoning_effort="${modelReasoningEffort}"`;
    expect(audit.args.filter((arg: string) => arg.startsWith('model_reasoning_effort='))).toEqual([expected]);
    expect(audit.args[audit.args.indexOf(expected) - 1]).toBe('--config');
    expect(audit.prompt).toBe(f.request.prompt);
    expect(audit.schema).toEqual(z.toJSONSchema(ProposalSchema));
    expect(audit.args.some((arg: string) => /temperature|seed|max_output_tokens|resume/.test(arg))).toBe(false);
  });
  it.each([null, '', 'none', 'HIGH', 'high ', 1, { value: 'high' }, 'high"\nmodel_provider="other'])('rejects invalid reasoning effort %# before any launch', async modelReasoningEffort => {
    const f = await harness(), invalid = { ...f.request, modelReasoningEffort };
    expect(MatchedModelRequestSchema.safeParse(invalid).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...f.authored.packet.episode.settings, modelReasoningEffort }).success).toBe(false);
    const result = await f.transport.execute(invalid as MatchedModelRequest, new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', transportEvidence: { cleanup: 'not_started', processEvidence: null } });
    await expect(access(join(f.options.workingDirectory, 'audit.json'))).rejects.toThrow();
  });
  it('retains the explicit forwarded effort when the authored executable fails', async () => {
    const f = await harness('console.log("invalid-json");');
    expect(await f.transport.execute({ ...f.request, modelReasoningEffort: 'low' }, new AbortController().signal))
      .toMatchObject({ status: 'failed', usage: null, transportEvidence: { cleanup: 'verified',
        processEvidence: { modelReasoningEffort: 'low', processGroupStopped: true } } });
  });
  it('rejects arbitrary schemas before launch', async () => {
    const f = await harness();
    const result = await f.transport.execute({ ...f.request, outputSchema: { type: 'object' } }, new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', usage: null, transportEvidence: { cleanup: 'not_started' } });
    expect(result.error).toContain('fixed stage output schema');
    await expect(access(join(f.options.workingDirectory, 'audit.json'))).rejects.toThrow();
  });
  it.each(['gate', 'future'] as const)('maps %s to the exact shared review schema without adding answers or diagnosis', async stage => {
    const f = await harness(complete({ judgments: [] }));
    const request = reviewRequest(stage, initialStructured(f.prepared), [], f.authored.packet.episode.settings);
    expect((await f.transport.execute(request, new AbortController().signal)).status).toBe('completed');
    const audit = JSON.parse(await readFile(join(f.options.workingDirectory, 'audit.json'), 'utf8'));
    expect(audit.prompt).toBe(request.prompt); expect(audit.schema).toEqual(z.toJSONSchema(ReviewSchema));
    expect(audit.prompt).not.toContain('FROZEN_DIAGNOSIS');
  });
  it.each([
    ['malformed-jsonl', `console.log('not JSON');`, null],
    ['missing-usage', `send({type:'thread.started',thread_id:'authored-session'});send({type:'item.completed',item:{id:'a',type:'agent_message',text:'{}'}});`, null],
    ['malformed-usage', `send({type:'thread.started',thread_id:'authored-session'});send({type:'turn.completed',usage:{input_tokens:7,output_tokens:5}});`, null],
    ['invalid-schema', complete({ invented: true }), usage],
    ['prohibited-tool', `send({type:'item.completed',item:{id:'cmd',type:'command_execution',command:'authored',aggregated_output:'',status:'completed'}});`, null],
  ] as const)('retains %s failure and distinguishes unknown usage from zero', async (_name, code, measured) => {
    const f = await harness(code), result = await f.transport.execute(f.request, new AbortController().signal);
    expect(result.status).toBe('failed'); expect(result.output).toBeNull();
    expect(result.transportEvidence).toMatchObject({ rawUsage: measured, cleanup: 'verified', processEvidence: { processGroupStopped: true } });
    expect(result.usage).toEqual(measured ? { inputTokens: 7, outputTokens: 5, cachedInputTokens: 2, costMicros: 0 } : null);
  });
  it('cancels with a verified stop receipt and never invents usage', async () => {
    const f = await harness('setInterval(()=>{},1000);'), controller = new AbortController();
    const pending = f.transport.execute(f.request, controller.signal);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (await access(join(f.options.workingDirectory, 'audit.json')).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    expect(await pending).toMatchObject({ status: 'failed', usage: null,
      transportEvidence: { cleanup: 'verified', processEvidence: { reason: 'cancelled', processGroupStopped: true } } });
  });
  it('keeps unknown worker usage in the matched ledger and blocks subsequent dispatch for that arm', async () => {
    const f = await harness(`send({type:'thread.started',thread_id:'incomplete'});`);
    f.authored.packet.episode.settings.limits.timeoutMsPerCall = 3000;
    f.authored.packet.digest = digestOf(f.authored.packet.episode);
    const report = await runMatchedRevision({ mode: 'authored_fixture', ...f.authored, transport: f.transport });
    expect(report.arms).toHaveLength(4);
    for (const arm of report.arms) {
      expect(arm.usage.transportCalls).toBe(1); expect(arm.usage.modelCalls).toBe(0); expect(arm.usage.usageComplete).toBe(false);
      expect(arm.calls[0]).toMatchObject({ status: 'failed', usage: null, transportEvidence: { cleanup: 'verified' } });
      expect(arm.calls.slice(1).every(call => !call.invoked && call.status === 'budget_exhausted')).toBe(true);
      expect(arm.future).toHaveLength(f.authored.future.cases.length);
    }
  });
  it('retains a verified SDK stop receipt after the matched runner deadline without accepting late output', async () => {
    const f = await harness('setInterval(()=>{},1000);');
    f.authored.packet.episode.settings.modelReasoningEffort = 'low';
    f.authored.packet.episode.settings.limits.timeoutMsPerCall = 300;
    f.authored.packet.digest = digestOf(f.authored.packet.episode);
    const report = await runMatchedRevision({ mode: 'authored_fixture', ...f.authored, transport: f.transport });
    for (const arm of report.arms) {
      expect(arm.calls[0]).toMatchObject({ status: 'timeout', output: null, usage: null,
        transportEvidence: { cleanup: 'verified', processEvidence: { reason: 'cancelled', processGroupStopped: true, modelReasoningEffort: 'low' } } });
      expect(arm.calls.slice(1).every(call => !call.invoked)).toBe(true);
      expect(arm.usage.usageComplete).toBe(false);
    }
  });
  it('runs the full authored matched loop through SDK processes with equal scripted U/H/M/F results', async () => {
    const authored = createMatchedFixture();
    const code = `let output;
if(prompt.includes('COMMON_INPUT=')) output=prompt.includes('initialLesson is a lossless')?${JSON.stringify(authored.memoryProposal)}:${JSON.stringify(authored.proposal)};
else {const input=JSON.parse(prompt.split('\\nINPUT=')[1]);output={judgments:input.targets.map(t=>({targetId:t.id,
prediction:({'gate-0':'violation','gate-1':'safe','target-c':'violation','target-d':'safe','target-e':'unresolved'})[t.id],
reason:t.id==='target-e'?'abstained':'judgment',rationale:'Identical authored response, no inference',evidenceRefs:[t.evidence[0].id],missingEvidence:[]}))};}
send({type:'thread.started',thread_id:'authored-'+process.pid});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(output)}});
send({type:'turn.completed',usage:${JSON.stringify(usage)}});`;
    const f = await harness(code);
    f.authored.packet.episode.settings.modelReasoningEffort = 'medium';
    f.authored.packet.episode.settings.limits.timeoutMsPerCall = 3000;
    f.authored.packet.digest = digestOf(f.authored.packet.episode);
    const report = await runMatchedRevision({ mode: 'authored_fixture', ...f.authored, transport: f.transport });
    if (report.execution !== 'completed') throw new Error('Expected authored mechanics completion');
    expect(report).toMatchObject({ modelExecution: 'not_run', empiricalEpisodes: 0, independentHumanAnnotations: 0,
      transport: { capabilities: { temperature: 'unsupported', seed: 'unsupported', maxOutputTokens: 'unsupported' } } });
    expect(report.arms.every(arm => arm.gate.passed && arm.usage.modelCalls === 0 && arm.future.length === 3)).toBe(true);
    expect(new Set(report.arms.map(arm => JSON.stringify(arm.metrics))).size).toBe(1);
    expect(new Set(report.arms.flatMap(arm => arm.calls.map(call => call.transportEvidence?.sessionId))).size).toBe(11);
    expect(report.arms.every(arm => arm.calls.every(call => call.transportEvidence?.cleanup === 'verified'))).toBe(true);
    expect(report.arms.every(arm => arm.calls.every(call => call.request.modelReasoningEffort === 'medium'
      && call.transportEvidence?.processEvidence?.modelReasoningEffort === 'medium'))).toBe(true);
    expect(await runMatchedRevision({ mode: 'production', ...f.authored, transport: f.transport })).toMatchObject({ execution: 'not_run', reason: 'production_adapter_unconfigured' });
  }, 15_000);
});

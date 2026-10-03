// Run: node --import tsx scripts/verify-codex-effective-config.mjs
// Offline only: the official SDK invokes an authored executable, never Codex CLI.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildSdkNativeMatchedWorkspaceRequest } from '../src/matched-workspace.ts';
import { ProposalSchema } from '../src/core/matched-revision-model.ts';
import { CODEX_MODEL_REASONING_EFFORTS } from '../src/core/codex-model-settings.ts';
import { buildWorkspaceWorkerInput, WorkspaceWorkerInput } from '../src/workspace/worker-protocol.ts';
import { runCodexWorkspaceWorker } from '../src/adapters/codex-workspace-worker.ts';
import { SDK_NATIVE_MATCHED_PROFILE } from '../src/workspace/matched-codex-policy.ts';

const sdkRoot = new URL('../node_modules/@openai/codex-sdk/', import.meta.url);
const sdkPackage = JSON.parse(await readFile(new URL('package.json', sdkRoot), 'utf8'));
assert.equal(sdkPackage.version, '0.159.2');
const declarations = await readFile(new URL('dist/index.d.ts', sdkRoot), 'utf8');
const threadOptions = declarations.match(/type ThreadOptions = \{([\s\S]*?)\n\};/)[1];
assert.match(threadOptions, /model\?: string/);
assert.match(threadOptions, /modelReasoningEffort\?: ModelReasoningEffort/);
assert.doesNotMatch(threadOptions, /temperature|seed|maxOutputTokens|maxCalls/);
const root = await mkdtemp(join(tmpdir(), 'flyrewheel-effective-config-'));
const repo = join(root, 'repo'), executable = join(root, 'authored-cli.cjs');
const limits = { maxInputBytes: 100000, maxOutputBytes: 32768, maxArtifactBytes: 1,
  maxArtifacts: 0, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
const answer = { action: 'abstain', state: null, replacement: null, rationale: 'Authored fixture only',
  evidenceRefs: [], missingEvidence: [], nextStep: null };
const usage = { input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 2, reasoning_output_tokens: 0 };
let authoredInvocations = 0, deniedOperationalRequests = 0;
try {
  await mkdir(repo);
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(join(root, 'args.json'))},JSON.stringify(args));
process.stdin.resume();process.stdin.on('end',()=>{
for(const event of ${JSON.stringify([{ type: 'thread.started', thread_id: 'authored-config' },
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: JSON.stringify(answer) } },
    { type: 'turn.completed', usage }])}) console.log(JSON.stringify(event));});\n`, { mode: 0o700 });
  for (const effort of [undefined, ...CODEX_MODEL_REASONING_EFFORTS]) {
    const raw = { stage: 'proposal', profile: SDK_NATIVE_MATCHED_PROFILE, model: 'authored-explicit-model',
      ...(effort === undefined ? {} : { modelReasoningEffort: effort }), prompt: 'Authored selected evidence only.',
      outputSchema: z.toJSONSchema(ProposalSchema) };
    const request = buildSdkNativeMatchedWorkspaceRequest(raw, {
      workspace: { repoPath: repo, runId: 'offline-config', attemptId: 'one' },
      expectedSha: 'a'.repeat(40), historyPolicy: 'all-local-refs-v1',
    }, { stage: 'proposal', evidenceRefs: [], requiredEvidenceRefs: [] }, limits);
    const wire = WorkspaceWorkerInput.parse(JSON.parse(JSON.stringify(buildWorkspaceWorkerInput(request, repo))));
    assert.equal(wire.model, raw.model);
    assert.equal(wire.modelReasoningEffort, effort);
    assert.deepEqual(wire.limits, limits);
    assert.equal(Object.hasOwn(wire, 'modelReasoningEffort'), effort !== undefined);
    // Operational requests must still fail before any SDK/runtime work.
    await assert.rejects(runCodexWorkspaceWorker(wire, ProposalSchema, {
      codexPathOverride: executable, boundary: { kind: 'isolated-runtime', verify: async () => {
        throw new Error('Unexpected runtime verification');
      } },
    }), /deployment-bound gateway admission and an authorized monetary arrangement/);
    deniedOperationalRequests++;
    // Separate authored copy, explicitly not an operational admission bypass.
    const authored = WorkspaceWorkerInput.parse({ ...wire, matchedExecution: { kind: 'authored-sdk-native-no-model' } });
    const result = await runCodexWorkspaceWorker(authored, ProposalSchema, {
      codexPathOverride: executable, boundary: { kind: 'authored-test-no-isolation', fixtureRoot: root },
      observe: event => { if (event.kind === 'sdk_invocation') authoredInvocations++; },
    });
    const args = JSON.parse(await readFile(join(root, 'args.json'), 'utf8'));
    assert.equal(args[args.indexOf('--model') + 1], raw.model);
    assert.deepEqual(args.filter(x => x.startsWith('model_reasoning_effort=')),
      effort === undefined ? [] : [`model_reasoning_effort="${effort}"`]);
    for (const control of ['features.shell_tool=false', 'features.unified_exec=false', 'web_search="disabled"'])
      assert.ok(args.includes(control), control);
    assert.ok(args.includes('read-only'));
    assert.ok(!args.some(x => /temperature|seed|max_output_tokens|resume/.test(x)));
    assert.equal(result.processEvidence.modelReasoningEffort, effort);
    assert.equal(result.processEvidence.processGroupStopped, true);
    assert.ok(result.processEvidence.forwardedBytes <= limits.maxOutputBytes);
    assert.deepEqual(result.value, answer);
    for (const unsupported of [{ providerCallsPerArm: 1 }, { maxCostMicros: 100 }, { modelReasoningEffort: 'none' }])
      assert.equal(WorkspaceWorkerInput.safeParse({ ...wire, ...unsupported }).success, false);
  }
  assert.equal(authoredInvocations, CODEX_MODEL_REASONING_EFFORTS.length + 1);
  console.log(JSON.stringify({ check: 'codex-effective-config', evidence: 'authored-offline-sdk-executable',
    sdkVersion: sdkPackage.version, sdkDeclarationSha256: createHash('sha256').update(declarations).digest('hex'),
    authoredInvocations, deniedOperationalRequests, reasoningSettings: [null, ...CODEX_MODEL_REASONING_EFFORTS],
    byteLimitsRoundTrip: true, providerCallCeiling: 'not_in_worker_protocol', monetaryCeiling: 'not_in_worker_protocol',
    realModelCalls: 0, gatewayCalls: 0, liveRuntimeVerification: 'not_run' }));
} finally {
  await rm(root, { recursive: true, force: true });
}

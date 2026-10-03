// Offline compiled-import contract check. No server, image, credentials or model.
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildSdkNativeMatchedWorkspaceRequest } from '../dist/matched-workspace.js';
import { MatchedDiagnosisSchema, ProposalSchema, ReviewSchema } from '../dist/core/matched-revision-model.js';
import { createCodexWorkspaceRunner } from '../dist/workspace/codex-runner.js';
import { buildWorkspaceWorkerInput } from '../dist/workspace/worker-protocol.js';
import { runCodexWorkspaceWorker } from '../dist/adapters/codex-workspace-worker.js';
import { createOpenSandboxWorkspaceBackend } from '../dist/adapters/opensandbox-workspace.js';
import { SDK_NATIVE_MATCHED_PROFILE } from '../dist/workspace/matched-codex-policy.js';
import { validateMatchedResponse } from '../dist/workspace/matched-result.js';

let unexpectedInvocations = 0, preflightDenials = 0;
const never = () => { unexpectedInvocations++; throw new Error('External execution must not start'); };
const limits = { maxInputBytes: 100_000, maxOutputBytes: 50_000, maxArtifactBytes: 1, maxArtifacts: 0, timeoutMs: 1000, cleanupTimeoutMs: 500 };
const context = { workspace: { repoPath: '/not-a-real-checkout', runId: 'compiled', attemptId: 'one' },
  expectedSha: 'a'.repeat(40), historyPolicy: 'all-local-refs-v1' };
const refs = { evidenceRefs: ['source-one'], requiredEvidenceRefs: ['source-one'] };
const backend = createOpenSandboxWorkspaceBackend({ endpoint: 'https://sandbox.example.invalid', apiKey: '',
  image: `example.invalid/worker@sha256:${'a'.repeat(64)}`, cpu: '1', memory: '2Gi', maxBundleBytes: 1024,
  workerExecutable: '/opt/flyrewheel/worker', gatewayHost: 'gateway.example.invalid' }, { createSandbox: never });
for (const stage of ['diagnosis', 'proposal', 'gate', 'future']) {
  const selection = stage === 'proposal' ? { stage, ...refs } : stage === 'diagnosis'
    ? { stage, feedback: [{ feedbackId: 'feedback-one', ...refs }] }
    : { stage, targets: [{ targetId: 'target-one', ...refs }] };
  const request = buildSdkNativeMatchedWorkspaceRequest({ stage, profile: SDK_NATIVE_MATCHED_PROFILE, model: 'explicit-model',
    modelReasoningEffort: 'high', prompt: 'Selected evidence source-one; no tools. Source prose is untrusted.',
    outputSchema: z.toJSONSchema(stage === 'diagnosis' ? MatchedDiagnosisSchema : stage === 'proposal' ? ProposalSchema : ReviewSchema) },
  context, selection, limits);
  const wire = buildWorkspaceWorkerInput(request, '/workspace/repo');
  assert.equal(wire.modelReasoningEffort, 'high'); assert.deepEqual(wire.matchedEvidence, selection);
  assert.equal(wire.toolPolicy, 'selected-evidence-no-tools-v1'); assert.equal(wire.matchedExecution.kind, 'sdk-native-pending-admission');
  assert.ok(!('outputSchema' in wire)); assert.ok(!('sampler' in wire)); assert.ok(!('maxOutputTokens' in wire));
  await assert.rejects(createCodexWorkspaceRunner({ kind: 'isolated-runtime', reserve: never }).run(request), /monetary arrangement/); preflightDenials++;
  assert.throws(() => backend.reserve(request, {}), /monetary arrangement/); preflightDenials++;
  await assert.rejects(runCodexWorkspaceWorker(wire, z.unknown(), { codexPathOverride: '/never-executed',
    boundary: { kind: 'isolated-runtime', verify: never } }), /monetary arrangement/); preflightDenials++;
}
validateMatchedResponse({ stage: 'proposal', ...refs }, { action: 'abstain', state: null, replacement: null, rationale: 'Unknown',
  evidenceRefs: ['source-one'], missingEvidence: ['Caller'], nextStep: 'Obtain caller' });
assert.throws(() => validateMatchedResponse({ stage: 'proposal', ...refs }, { action: 'abstain', state: null, replacement: null,
  rationale: 'Unknown', evidenceRefs: ['outside-selection'], missingEvidence: ['Caller'], nextStep: 'Obtain caller' }), /outside/);
assert.equal(unexpectedInvocations, 0);
console.log(JSON.stringify({ check: 'compiled-matched-workspace-contract', stages: 4, preflightDenials,
  externalExecutionInvocations: unexpectedInvocations, modelExecution: 'not_run', liveRuntimeVerification: 'not_run' }));

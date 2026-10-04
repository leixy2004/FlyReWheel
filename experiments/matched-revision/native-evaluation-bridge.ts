import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { digestOf } from '../../src/core/identity.js';
import { EvaluationWorkspaceBindingSchema } from '../../src/workspace/history-policy.js';
import { EvaluationVisibilityManifestSchema } from '../../src/workspace/evaluation-checkout.js';
import { PreparedEvaluationWorkspaceResolverConfigSchema, createPreparedEvaluationWorkspaceResolver } from '../../src/prepared-evaluation-workspace-resolver.js';
import { readEvaluationJson, writeEvaluationJson } from '../../src/paired-evaluation.js';
import { openPGliteDatabase } from '../../src/storage/database.js';
import { MatchedStudyStore } from '../../src/storage/matched-studies.js';
import { createAuthoredCodexNativeMatchedTransport } from '../../src/adapters/matched-revision-codex.js';
import { createRecoveryFixture } from './evaluation-bridge-fixture.js';
export { createEvaluationBridgeFixture } from './evaluation-bridge-fixture.js';
import { SdkNativeConfigurationSchema } from './sdk-native-contracts.js';
import { runSdkNativeStudy, type SdkNativeStudyInput } from './sdk-native-study.js';
import { validateSdkNativeSchedule } from './sdk-native-schedule.js';

const Registry = PreparedEvaluationWorkspaceResolverConfigSchema;
const Context = z.object({ side: z.enum(['before', 'after']), sha: z.string(),
  manifest: EvaluationVisibilityManifestSchema, binding: EvaluationWorkspaceBindingSchema }).passthrough();
const W0Sources = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  contexts: z.array(Context).length(6), provenance: z.object({
    kind: z.literal('w0-evaluation-preparation-provenance'),
    formalInputs: z.object({ dataset: z.literal('not-materialized-no-rule-families'),
      annotations: z.literal('not-materialized-no-human-authors-or-labels'),
      runs: z.literal('not-materialized-no-model-or-review-arms'),
      feedback: z.literal('not-materialized-no-developer-feedback') }).strict(),
    independentHumanLabels: z.literal(0), modelCalls: z.literal(0),
    items: z.array(z.object({ number: z.number().int(), contexts: z.array(z.object({
      side: z.enum(['before', 'after']), binding: EvaluationWorkspaceBindingSchema,
    }).passthrough()) }).passthrough()).length(3),
  }).passthrough() }).strict();
export const NativeEvaluationBridgeManifestSchema = z.discriminatedUnion('kind', [
  z.object({ schemaVersion: z.literal(1), purpose: z.literal('offline-study'),
    kind: z.literal('authored-eligible'), registry: Registry,
    study: z.object({ schedule: z.unknown(), configuration: SdkNativeConfigurationSchema,
      blocks: z.array(z.object({ blockId: z.string(), packet: z.unknown(), future: z.unknown() }).strict()).min(1).max(8) }).strict(),
  }).strict(),
  z.object({ schemaVersion: z.literal(1), purpose: z.literal('offline-study'),
    kind: z.literal('real-w0-blocked'), sources: W0Sources, registry: Registry.optional(),
  }).strict(),
]);
export type NativeEvaluationBridgeManifest = z.infer<typeof NativeEvaluationBridgeManifestSchema>;

function validateW0(sources: z.infer<typeof W0Sources>) {
  const expected = sources.provenance.items.flatMap(item => item.contexts.map(context => ({ ...context, number: item.number })));
  if (expected.length !== 6 || new Set(expected.map(c => c.binding.exportId)).size !== 6) throw new Error('W0 provenance must retain six distinct contexts');
  for (const context of sources.contexts) {
    const row = expected.find(e => e.binding.exportId === context.binding.exportId);
    if (!row || row.side !== context.side || digestOf(row.binding) !== digestOf(context.binding)
      || context.sha !== context.binding.checkoutSha || context.manifest.checkoutSha !== context.sha
      || context.manifest.repositoryId !== context.binding.repositoryId
      || digestOf(context.manifest.allowedHeads) !== digestOf(context.binding.allowedHeads)
      || digestOf(context.manifest) !== context.binding.requestDigest) throw new Error('W0 context/provenance binding mismatch');
  }
  if (new Set(sources.contexts.map(c => c.binding.exportId)).size !== 6) throw new Error('Duplicate W0 context');
}

/** Pin an artifact once and compare bytes through canonical identity on reopen. */
async function pin(path: string, value: unknown) {
  try { await writeEvaluationJson(path, value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (digestOf(await readEvaluationJson(path, 32_000_000)) !== digestOf(value)) throw new Error('Checkpoint input/result identity changed; use a new explicit checkpoint');
  }
}

/** One authored/blocked chain. Every executable run and reopen verifies the exact registry.
 * Transport code is builtin authored source, never selected by a JSON path or callback.
 */
export async function runNativeEvaluationBridge(raw: unknown, checkpointPath: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const manifest = NativeEvaluationBridgeManifestSchema.parse(raw);
  if (manifest.kind === 'real-w0-blocked') validateW0(manifest.sources);
  const bindings = manifest.kind === 'real-w0-blocked'
    ? manifest.sources.contexts.map(c => c.binding) : manifest.registry.entries.map(e => e.evaluation);
  if (!bindings.length || new Set(bindings.map(b => b.exportId)).size !== bindings.length) throw new Error('Bridge requires distinct complete export bindings');
  const evaluation = { purpose: 'offline-study' as const, semantics: 'verified-source-provenance-only' as const, bindings };
  const registry = manifest.registry;
  if (registry && digestOf(registry.entries.map(entry => digestOf(entry.evaluation)).sort())
    !== digestOf(bindings.map(binding => digestOf(binding)).sort())) throw new Error('Bridge registry must match every frozen source binding');
  const resolver = registry ? createPreparedEvaluationWorkspaceResolver(registry) : null;
  const verifyEvaluation = async () => {
    signal.throwIfAborted();
    if (!resolver || !registry) throw new Error('Prepared evaluation registry is required for native dispatch');
    for (const entry of registry.entries) {
      const resolved = await resolver(entry.selection, signal);
      if (!('evaluation' in resolved) || digestOf(resolved.evaluation) !== digestOf(entry.evaluation)) throw new Error('Resolved evaluation binding changed');
    }
    signal.throwIfAborted();
  };
  // Reverify even a previously finished checkpoint before reading its result.
  if (registry) await verifyEvaluation();
  signal.throwIfAborted();
  await mkdir(checkpointPath, { recursive: true, mode: 0o700 });
  await pin(join(checkpointPath, 'manifest.json'), manifest);
  const manifestDigest = digestOf(manifest);
  if (manifest.kind === 'real-w0-blocked') {
    const body = { schemaVersion: 1, kind: 'native-evaluation-blocked', purpose: manifest.purpose,
      execution: 'blocked', executable: false, modelExecution: 'not_run', providerModelCalls: 0,
      independentHumanLabels: 0, manifestDigest, evaluation,
      workspaceVerification: registry ? 'verified-current-prepared-exports' : 'not_run-no-local-registry',
      sourceVerification: 'frozen-contexts-match-provenance-ledger',
      blockers: ['semantic_rule_families_not_materialized', 'independent_human_annotations_absent',
        'developer_feedback_absent', 'frozen_revision_packet_and_future_cases_absent'],
      nativeStudy: null, resources: 'not_allocated', checkpoint: 'immutable-blocked-record' };
    const result = { ...body, digest: digestOf(body) };
    await pin(join(checkpointPath, 'result.json'), result);
    return result;
  }
  const schedule = validateSdkNativeSchedule(manifest.study.schedule, manifest.study.configuration);
  // Local authored SDK fixture only. The supplied manifest cannot choose an executable.
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'flyrewheel-native-bridge-'));
  try {
    const fixture = await createRecoveryFixture(runtimeRoot);
    const db = await openPGliteDatabase(join(checkpointPath, 'db'));
    try {
      const store = await MatchedStudyStore.initialize(db);
      const study = await runSdkNativeStudy({ mode: 'authored_fixture', schedule,
        configuration: manifest.study.configuration, blocks: manifest.study.blocks as SdkNativeStudyInput[],
        evaluation, verifyEvaluation, store,
        transport: createAuthoredCodexNativeMatchedTransport(fixture.transportOptions) });
      const body = { schemaVersion: 1, kind: 'native-evaluation-authored-result', purpose: manifest.purpose,
        manifestDigest, evaluation, modelExecution: 'not_run', providerModelCalls: 0,
        independentHumanLabels: 0, sourceExecution: 'selected-evidence-authored-script-only', study };
      const result = { ...body, digest: digestOf(body) };
      if (study.execution === 'completed') await pin(join(checkpointPath, 'result.json'), result);
      return result;
    } finally { await db.close(); }
  } finally { await rm(runtimeRoot, { recursive: true, force: true }); }
}

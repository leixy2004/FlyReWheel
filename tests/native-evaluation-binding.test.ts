import { MATCHED_EXECUTION_POLICY_DIGEST } from '../experiments/matched-revision/prompts.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeEvaluationContextSchema, type NativeEvaluationContext } from '../src/core/matched-revision-model.js';
import { digestOf } from '../src/core/identity.js';
import { createAuthoredCodexNativeMatchedTransport } from '../src/adapters/matched-revision-codex.js';
import { openPGliteDatabase } from '../src/storage/database.js';
import { MatchedStudyStore, matchedStudyDigest } from '../src/storage/matched-studies.js';
import { runSdkNativeStudy, sdkNativeStudyDigest } from '../experiments/matched-revision/sdk-native-study.js';
import { createRecoveryFixture } from './helpers/matched-study-recovery-fixture.js';
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (clean.length) await clean.pop()!(); });
const context: NativeEvaluationContext = { purpose: 'offline-study', semantics: 'verified-source-provenance-only', bindings: [{
  schemaVersion: 1, exportId: 'authored-export', repositoryId: 'authored/repo', checkoutSha: 'a'.repeat(40), allowedHeads: ['a'.repeat(40)],
  requestDigest: 'b'.repeat(64), recordDigest: 'c'.repeat(64), inventory: { count: 1, expandedBytes: 1, digest: 'd'.repeat(64) },
}] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-evaluation-')); clean.push(() => rm(root, { recursive: true, force: true }));
  const input = await createRecoveryFixture(join(root, 'fixture'), 1);
  const transport = createAuthoredCodexNativeMatchedTransport(input.transportOptions);
  return { input, transport };
}
it('requires explicit verification before claim and pins execution policy independently of optional evaluation context', async () => {
  const { input, transport } = await fixture();
  expect(sdkNativeStudyDigest(input.schedule, input.configuration)).toBe(digestOf(['authored-matched-study-recovery', input.schedule.digest, digestOf(input.configuration), MATCHED_EXECUTION_POLICY_DIGEST]));
  expect(sdkNativeStudyDigest(input.schedule, input.configuration, context)).not.toBe(sdkNativeStudyDigest(input.schedule, input.configuration));
  await expect(runSdkNativeStudy({ ...input, transport, evaluation: context })).rejects.toThrow(/verification hook/);
  await expect(runSdkNativeStudy({ ...input, transport, evaluation: context, verifyEvaluation: async () => { throw new Error('stale export'); } })).rejects.toThrow('stale export');
  expect(() => NativeEvaluationContextSchema.parse({ ...context, purpose: 'production' })).toThrow();
});
it('binds every native request and persisted report, revalidates finished reopen, and rejects altered checkpoint context', async () => {
  const { input, transport } = await fixture();
  const db = await openPGliteDatabase(); clean.push(() => db.close());
  const store = await MatchedStudyStore.initialize(db); let verifications = 0;
  const options = { ...input, transport, store, evaluation: context, verifyEvaluation: async () => { verifications++; } };
  const report = await runSdkNativeStudy(options);
  if (report.execution !== 'completed') throw new Error('Expected authored completion');
  expect(report.evaluation).toEqual(context); expect(report.modelExecution).toBe('not_run');
  const studyDigest = sdkNativeStudyDigest(input.schedule, input.configuration, context);
  const inspected = (await store.inspect(studyDigest))!;
  expect(matchedStudyDigest(inspected.manifest)).toBe(studyDigest);
  const calls = inspected.events.filter(e => e.key.startsWith('call-result:')).map(e => (e.payload as any).call);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) { expect(call.request.evaluation).toEqual(context); expect(call.requestDigest).toBe(digestOf(call.request)); }
  expect(verifications).toBe(1 + calls.length);
  expect(await runSdkNativeStudy(options)).toEqual(report); expect(verifications).toBe(2 + calls.length);
  await expect(runSdkNativeStudy({ ...options, verifyEvaluation: async () => { throw new Error('export removed'); } })).rejects.toThrow('export removed');
  // New context creates a separate immutable study. A receipt from the first is not admissible there.
  const changed = structuredClone(context); changed.bindings[0].exportId = 'other';
  const manifest = { ...inspected.manifest, input: { ...(inspected.manifest.input as object), evaluation: changed } };
  const claimed = await store.claim(manifest, 30_000); if (claimed.state !== 'claimed') throw new Error('claim');
  await expect(store.finish(claimed.claim, report)).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
  const call = calls[0], blockId = call.nativeRecord.blockId;
  await store.append(claimed.claim, blockId, 'block-start', { startedAt: new Date().toISOString() });
  await expect(store.append(claimed.claim, blockId, `call-result:${call.nativeRecord.callId}`, { arm: call.nativeRecord.arm, call })).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
}, 30_000);

it('a failed per-call verification blocks the authored SDK before dispatch', async () => {
  const { input, transport } = await fixture(); let checks = 0;
  const report = await runSdkNativeStudy({ ...input, transport, evaluation: context,
    verifyEvaluation: async () => { if (++checks > 1) throw new Error('source changed before call'); } });
  if (report.execution !== 'completed') throw new Error('Expected retained failed roster');
  expect(checks).toBeGreaterThan(1);
  expect(report.counts.completedBlocks).toBe(0);
  expect(report.blocks.every(block => block.actualCallOrder.length === 0)).toBe(true);
});

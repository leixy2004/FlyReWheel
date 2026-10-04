import { afterAll, beforeAll, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvaluationBridgeFixture } from '../experiments/matched-revision/evaluation-bridge-fixture.js';
import { runNativeEvaluationBridge } from '../experiments/matched-revision/native-evaluation-bridge.js';
import { canonicalJson, digestOf } from '../src/core/identity.js';

const exec = promisify(execFile), project = fileURLToPath(new URL('..', import.meta.url));
let root: string, checkpoint: string, fixture: Awaited<ReturnType<typeof createEvaluationBridgeFixture>>;
let manifest: ReturnType<typeof manifestOf>, first: Awaited<ReturnType<typeof runNativeEvaluationBridge>>, resultBytes: string;
const signal = () => new AbortController().signal;
function manifestOf(f: Awaited<ReturnType<typeof createEvaluationBridgeFixture>>) {
  return { schemaVersion: 1, purpose: 'offline-study', kind: 'authored-eligible', registry: f.registry,
    study: { schedule: f.studyInput.schedule, configuration: f.studyInput.configuration, blocks: f.studyInput.blocks } };
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-evaluation-bridge-test-')); checkpoint = join(root, 'checkpoint');
  fixture = await createEvaluationBridgeFixture(join(root, 'fixture'));
  manifest = manifestOf(fixture);
  first = await runNativeEvaluationBridge(manifest, checkpoint, signal());
  resultBytes = await readFile(join(checkpoint, 'result.json'), 'utf8');
}, 120_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test('binds every authored diagnosis/proposal/gate/future call and reopens byte-identically in a new process without SDK dispatch', async () => {
  if (!('study' in first) || first.study.execution !== 'completed') throw new Error('Expected completed authored study');
  expect(first).toMatchObject({ modelExecution: 'not_run', providerModelCalls: 0, independentHumanLabels: 0,
    sourceExecution: 'selected-evidence-authored-script-only' });
  expect(first.study.configurationDigest).toBe(digestOf(manifest.study.configuration));
  const block = first.study.blocks[0];
  if (!block.report || !block.diagnosisSlot?.record) throw new Error('Expected authored calls');
  const calls = [block.diagnosisSlot.record.call, ...block.report.arms.flatMap(arm => arm.calls)];
  expect(calls).toHaveLength(12);
  expect(new Set(calls.map(call => call.stage))).toEqual(new Set(['diagnosis', 'proposal', 'gate', 'future']));
  for (const call of calls) {
    expect(call.request).toMatchObject({ evaluation: first.evaluation });
    expect(call.requestDigest).toBe(digestOf(call.request));
    expect(call.nativeRecord?.configurationDigest).toBe(digestOf(manifest.study.configuration));
    if (!call.nativeRecord) throw new Error('Expected native record');
    expect(call.nativeRecord.requestedSettings).toEqual(manifest.study.configuration.roles[call.nativeRecord.role]);
  }
  expect(JSON.parse(await readFile(join(checkpoint, 'manifest.json'), 'utf8')).study.configuration)
    .toEqual(fixture.studyInput.configuration);
  const input = join(root, 'manifest-input.json'); await writeFile(input, JSON.stringify(manifest));
  // Fail and count any attempted authored executable launch, while allowing verification Git subprocesses.
  const code = `
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    import {readFile} from 'node:fs/promises';
    let authoredLaunches=0; const spawn=cp.spawn;
    cp.spawn=function(command,...args){if(String(command).endsWith('script.cjs')){authoredLaunches++;throw new Error('REPLAY_MUST_NOT_DISPATCH');}return spawn.call(this,command,...args);};
    syncBuiltinESMExports();
    const {runNativeEvaluationBridge}=await import('./src/native-evaluation-bridge.ts');
    const raw=JSON.parse(await readFile(process.argv[1],'utf8'));
    const report=await runNativeEvaluationBridge(raw,process.argv[2],new AbortController().signal);
    console.log(JSON.stringify({report,authoredLaunches}));
  `;
  const child = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, input, checkpoint],
    { cwd: project, timeout: 60_000, maxBuffer: 16_000_000 });
  const reopened = JSON.parse(child.stdout);
  expect(reopened.authoredLaunches).toBe(0); expect(reopened.report).toEqual(first);
  expect(await readFile(join(checkpoint, 'result.json'), 'utf8')).toBe(resultBytes);
  const cliCode = `import {Command} from 'commander';
    import {registerEvaluationWorkspaceCommands} from './src/cli-evaluation-workspace.ts';
    const cli=new Command('evaluation');registerEvaluationWorkspaceCommands(cli);
    await cli.parseAsync(['native','run','--manifest',process.argv[1],'--checkpoint',process.argv[2]],{from:'user'});`;
  const cliChild = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', cliCode, input, checkpoint],
    { cwd: project, timeout: 60_000, maxBuffer: 16_000_000 });
  expect(cliChild.stdout).toBe(`${JSON.stringify(JSON.parse(canonicalJson(first)), null, 2)}\n`);
}, 90_000);

test('rejects wrong purpose, changed binding, tampered checkpoint identity and dirt even for a finished study', async () => {
  await expect(runNativeEvaluationBridge({ ...manifest, purpose: 'production' }, checkpoint, signal())).rejects.toThrow();
  const changed = structuredClone(manifest); changed.registry.entries[0].evaluation.recordDigest = 'f'.repeat(64);
  await expect(runNativeEvaluationBridge(changed, checkpoint, signal())).rejects.toThrow();
  const pinnedPath = join(checkpoint, 'manifest.json'), original = await readFile(pinnedPath, 'utf8');
  const tampered = JSON.parse(original); tampered.registry.entries[0].manifestDigest = 'f'.repeat(64);
  // Even syntactically valid substituted checkpoint input must not be silently accepted.
  await writeFile(pinnedPath, JSON.stringify(tampered));
  try { await expect(runNativeEvaluationBridge(manifest, checkpoint, signal())).rejects.toThrow(/identity changed/); }
  finally { await writeFile(pinnedPath, original); }
  const substitutedResult = JSON.parse(resultBytes); substitutedResult.providerModelCalls = 1;
  const { digest: _digest, ...substitutedBody } = substitutedResult;
  await writeFile(join(checkpoint, 'result.json'), JSON.stringify({ ...substitutedBody, digest: digestOf(substitutedBody) }));
  try { await expect(runNativeEvaluationBridge(manifest, checkpoint, signal())).rejects.toThrow(/identity changed/); }
  finally { await writeFile(join(checkpoint, 'result.json'), resultBytes); }
  const worktree = join(fixture.registry.entries[0].workspace.repoPath, '.sandcastle', 'worktrees', 'attempt-authored-bridge--one');
  await writeFile(join(worktree, 'dirty.txt'), 'authored untracked dirt');
  try { await expect(runNativeEvaluationBridge(manifest, checkpoint, signal())).rejects.toThrow(/not ready|clean/); }
  finally { await rm(join(worktree, 'dirty.txt')); }
  expect(await readFile(join(checkpoint, 'result.json'), 'utf8')).toBe(resultBytes);
}, 30_000);

test('records explicit blockers for six synthetic W0-shaped contexts without constructing a native study', async () => {
  // Synthetic shape coverage only, not validation of any actual W0 artifact.
  const contexts = Array.from({ length: 6 }, (_, i) => {
    const visibility = { schemaVersion: 1 as const, repositoryId: 'synthetic/w0-shape', classification: 'development-fixture' as const,
      allowedHeads: ['a'.repeat(40)], checkoutSha: 'a'.repeat(40),
      visibility: { basis: 'caller-declared-exact-heads' as const, declaredAsOf: null, evidenceDigests: [] } };
    const binding = { ...fixture.registry.entries[0].evaluation, exportId: `synthetic-${i}`, repositoryId: visibility.repositoryId,
      checkoutSha: visibility.checkoutSha, allowedHeads: visibility.allowedHeads, requestDigest: digestOf(visibility) };
    return { side: i % 2 ? 'after' as const : 'before' as const, sha: binding.checkoutSha, manifest: visibility, binding };
  });
  const raw = { schemaVersion: 1, purpose: 'offline-study', kind: 'real-w0-blocked', sources: {
    sourceCommit: 'a'.repeat(40), contexts, provenance: { kind: 'w0-evaluation-preparation-provenance',
      formalInputs: { dataset: 'not-materialized-no-rule-families', annotations: 'not-materialized-no-human-authors-or-labels',
        runs: 'not-materialized-no-model-or-review-arms', feedback: 'not-materialized-no-developer-feedback' },
      independentHumanLabels: 0, modelCalls: 0, items: [0, 1, 2].map(i => ({ number: i + 1, contexts: contexts.slice(i * 2, i * 2 + 2) })) } } };
  const result = await runNativeEvaluationBridge(raw, join(root, 'synthetic-blocked'), signal());
  expect(result).toMatchObject({ execution: 'blocked', executable: false, providerModelCalls: 0, nativeStudy: null,
    resources: 'not_allocated', workspaceVerification: 'not_run-no-local-registry',
    blockers: ['semantic_rule_families_not_materialized', 'independent_human_annotations_absent',
      'developer_feedback_absent', 'frozen_revision_packet_and_future_cases_absent'] });
  const firstBinding = contexts[0].binding;
  const duplicatedRegistry = { schemaVersion: 1, purpose: 'offline-study', entries: contexts.map((_, index) => ({
    ...fixture.registry.entries[0], evaluation: firstBinding,
    selection: { ...fixture.selection, jobDigest: digestOf(index), repository: firstBinding.repositoryId,
      expectedSha: firstBinding.checkoutSha, evaluationExportId: firstBinding.exportId },
  })) };
  await expect(runNativeEvaluationBridge({ ...raw, registry: duplicatedRegistry }, join(root, 'duplicate-registry'), signal()))
    .rejects.toThrow('must match every frozen source binding');
});

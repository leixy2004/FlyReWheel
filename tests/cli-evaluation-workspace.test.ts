import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerEvaluationWorkspaceCommands } from '../src/cli-evaluation-workspace.js';
import { exportEvaluationCheckout, type EvaluationVisibilityManifest } from '../src/workspace/evaluation-checkout.js';
import { prepareEvaluationWorkspace } from '../src/workspace/evaluation-workspace.js';
import { workspaceGit } from '../src/workspace/process.js';
import { digestOf } from '../src/core/identity.js';
import { SdkNativeMatchedRequestSchema } from '../src/core/matched-revision-model.js';

// Isolated command composition and authored local Git only; no runtime or study dispatch.
let root: string, fixture: Awaited<ReturnType<typeof prepareFixture>>;
const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NETWORK_FORBIDDEN'); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
test('native envelopes reject unsupported evaluation provenance instead of dropping it', () => {
  for (const stage of ['diagnosis', 'proposal', 'gate', 'future']) {
    const request = { profile: 'paired-restriction-sdk-native-v1-draft', stage,
      model: 'authored-no-model', modelReasoningEffort: 'high', prompt: 'Authored contract probe', outputSchema: {} };
    expect(SdkNativeMatchedRequestSchema.parse(request)).toEqual(request);
    for (const field of ['evaluation', 'evaluationExportId', 'historyPolicy', 'purpose', 'limits']) {
      expect(SdkNativeMatchedRequestSchema.safeParse({ ...request, [field]: 'unsupported' }).success).toBe(false);
    }
  }
});
async function prepareFixture() {
  const source = join(root, 'source'), storePath = join(root, 'store'); await mkdir(source);
  await git(source, 'init', '--quiet', '--template=', '--initial-branch=main');
  await writeFile(join(source, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(source, 'value.txt'), 'Authored offline fixture\n');
  await git(source, 'add', '.');
  await git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Authored fixture');
  const sha = await git(source, 'rev-parse', 'HEAD');
  const manifest: EvaluationVisibilityManifest = { schemaVersion: 1, repositoryId: 'authored/cli', classification: 'development-fixture',
    allowedHeads: [sha], checkoutSha: sha, visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: null, evidenceDigests: [] } };
  await exportEvaluationCheckout({ repoPath: source, storePath, manifest });
  const workspace = { repoPath: join(root, 'derived'), runId: 'offline-cli', attemptId: 'one' };
  const prepared = await prepareEvaluationWorkspace({ ...workspace, exportId: 'authored-cli-export', storePath, manifest });
  const selection = { workspaceId: 'authored-workspace', jobDigest: 'a'.repeat(64), repository: manifest.repositoryId,
    kind: 'pr-mining', baseSha: sha, headSha: sha, expectedSha: sha, evaluationExportId: 'authored-cli-export' };
  const registry = { schemaVersion: 1, purpose: 'offline-study', entries: [{ selection, workspace,
    manifestDigest: digestOf(prepared.record), evaluation: prepared.evaluation }] };
  const registryPath = join(root, 'registry.json'), selectionPath = join(root, 'selection.json');
  await writeFile(registryPath, JSON.stringify(registry)); await writeFile(selectionPath, JSON.stringify(selection));
  return { workspace, prepared, selection, registry, registryPath, selectionPath };
}
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'evaluation-resolver-cli-')); fixture = await prepareFixture(); }, 30_000);
afterAll(async () => { expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }); });
async function cli(...args: string[]) {
  const command = new Command('evaluation').exitOverride();
  registerEvaluationWorkspaceCommands(command);
  await command.parseAsync(['workspace', 'resolve', ...args], { from: 'user' });
}
const baseArgs = () => ['--registry', fixture.registryPath, '--selection', fixture.selectionPath];
async function absent(path: string) { await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' }); }

test('writes full selection and evaluation binding deterministically through two fresh command instances', async () => {
  const a = join(root, 'report-a.json'), b = join(root, 'report-b.json');
  await cli(...baseArgs(), '--out', a); await cli(...baseArgs(), '--out', b);
  const bytes = await readFile(a, 'utf8'); expect(await readFile(b, 'utf8')).toBe(bytes);
  expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 1, kind: 'prepared-evaluation-workspace-inspection', purpose: 'offline-study',
    registryDigest: digestOf(fixture.registry), selectionDigest: digestOf(fixture.selection), selection: fixture.selection,
    resolution: { workspace: fixture.workspace, evaluation: fixture.prepared.evaluation }, modelExecution: 'not_run',
    runtimeExecution: 'not_run', nativeStudyExecution: 'not_run',
    limits: { inputRegistryBytes: 2_000_000, inputSelectionBytes: 16_384, timeoutMs: 30000 } });
}, 30_000);

test('rejects changed registry binding before producing a report', async () => {
  const registry = structuredClone(fixture.registry); registry.entries[0].evaluation.recordDigest = 'b'.repeat(64);
  const path = join(root, 'changed-registry.json'), out = join(root, 'rejected-binding.json');
  await writeFile(path, JSON.stringify(registry));
  await expect(cli('--registry', path, '--selection', fixture.selectionPath, '--out', out)).rejects.toThrow();
  await absent(out);
});

test('rejects extra stage and resource properties without silently dropping them', async () => {
  for (const [index, extra] of [{ stage: 'execute' }, { resource: { cpu: '8' } }, { purpose: 'production' }].entries()) {
    const path = join(root, `extra-selection-${index}.json`), out = join(root, `extra-report-${index}.json`);
    await writeFile(path, JSON.stringify({ ...fixture.selection, ...extra }));
    await expect(cli('--registry', fixture.registryPath, '--selection', path, '--out', out)).rejects.toThrow();
    await absent(out);
  }
});

test('rejects zero, oversized, fractional and nonnumeric acceptance deadlines before file reads', async () => {
  for (const timeout of ['0', '300001', '1.5', 'NaN']) {
    await expect(cli('--registry', '/nonexistent-registry', '--selection', '/nonexistent-selection', '--timeout-ms', timeout))
      .rejects.toMatchObject({ name: 'ZodError' });
  }
});

test('refuses to overwrite an existing output file, preserving its exact bytes', async () => {
  const out = join(root, 'existing.json'), content = 'EXISTING_IMMUTABLE_REPORT\n'; await writeFile(out, content);
  await expect(cli(...baseArgs(), '--out', out)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(out, 'utf8')).toBe(content);
}, 30_000);

test('enforces separate registry and selection byte limits before output', async () => {
  const registry = join(root, 'oversize-registry.json'), selection = join(root, 'oversize-selection.json');
  await writeFile(registry, ' '.repeat(2_000_001)); await writeFile(selection, ' '.repeat(16_385));
  const out = join(root, 'oversize-output.json');
  await expect(cli('--registry', registry, '--selection', fixture.selectionPath, '--out', out)).rejects.toThrow('exceeds 2000000 bytes');
  await expect(cli('--registry', fixture.registryPath, '--selection', selection, '--out', out)).rejects.toThrow('exceeds 16384 bytes');
  await absent(out);
});

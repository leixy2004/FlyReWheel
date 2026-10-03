import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { exportEvaluationCheckout, inspectEvaluationCheckout } from '../dist/workspace/evaluation-checkout.js';
import { prepareEvaluationWorkspace } from '../dist/workspace/evaluation-workspace.js';
import { cleanupWorkspace } from '../dist/workspace/index.js';
import { createCodexWorkspaceRunner } from '../dist/workspace/codex-runner.js';
import { verifyRuntimeCheckout } from '../dist/workspace/runtime-checkout.js';
import { transferSandcastleWorkspace } from '../dist/workspace/sandcastle-transfer.js';

// DEVELOPMENT FIXTURE ONLY. Uses compiled adapters and the public Sandcastle
// bundle transfer, but an authored local runtime/result, no live sandbox/model.
const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'evaluation-workspace-smoke-'));
let fetchBoundaryCalls = 0;
globalThis.fetch = async () => { fetchBoundaryCalls++; throw new Error('No external fetch permitted in this development fixture'); };
const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Development fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Development fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
const git = async (cwd, ...args) => (await exec('/usr/bin/git', args, { cwd, env })).stdout.trim();
async function snapshot(path) {
  const files = {};
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), stat = await lstat(file); assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await visit(file);
      else files[relative(path, file)] = { mode: stat.mode, sha256: createHash('sha256').update(await readFile(file)).digest('hex') };
    }
  }
  await visit(path); return files;
}
try {
  const source = join(root, 'source'), storePath = join(root, 'store'); await mkdir(source);
  await git(source, 'init', '--quiet', '--template=', '--initial-branch=main');
  await mkdir(join(source, 'src')); await mkdir(join(source, 'tests'));
  await writeFile(join(source, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(source, 'src/value.ts'), 'export const value = "unknown";\n');
  await writeFile(join(source, 'tests/value.test.ts'), '// Committed test file retained without execution\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Allowed authored fixture');
  const allowed = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'checkout', '-qb', 'future-answer');
  await writeFile(join(source, 'src/value.ts'), 'export const value = "FUTURE_ANSWER";\n');
  await writeFile(join(source, 'answer.txt'), 'FUTURE_ANSWER\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Future answer with backdated date');
  const future = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'tag', '-am', 'Future annotated answer', 'future-answer');
  const tag = await git(source, 'rev-parse', 'refs/tags/future-answer');
  const danglingFile = join(root, 'dangling.txt'); await writeFile(danglingFile, 'DANGLING_FUTURE_ANSWER\n');
  const dangling = await git(source, 'hash-object', '-w', danglingFile); await git(source, 'repack', '-ad');
  const sourceRefs = await git(source, 'show-ref');
  const manifest = { schemaVersion: 1, repositoryId: 'development-fixture/evaluation-workspace', classification: 'development-fixture',
    allowedHeads: [allowed], checkoutSha: allowed, visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: '2001-01-01T00:00:00Z', evidenceDigests: [] } };
  const baseline = await exportEvaluationCheckout({ repoPath: source, storePath, manifest });
  const originalBaseline = await snapshot(baseline.exportPath);
  const workspace = { repoPath: join(root, 'derived'), runId: 'evaluation-smoke', attemptId: 'one' };
  const prepared = await prepareEvaluationWorkspace({ ...workspace, exportId: 'authored-export', storePath, manifest });
  const unchanged = async () => {
    assert.deepEqual(await inspectEvaluationCheckout({ storePath, manifest }), baseline);
    assert.deepEqual(await snapshot(baseline.exportPath), originalBaseline);
  };
  await unchanged();
  const request = { workspace, expectedSha: allowed, model: 'authored-model', toolPolicy: 'full-repo-shell-v1',
    historyPolicy: 'exact-allowed-head-closure-v1', evaluation: prepared.evaluation, prompt: 'Authored fixture only',
    limits: { maxInputBytes: 32_768, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 30_000, cleanupTimeoutMs: 2000 } };
  const calls = [], runtime = join(root, 'runtime'), bundle = join(root, 'transferred.bundle');
  let transferredBytes = 0, runtimeVerified = false;
  const backend = { kind: 'authored-test-no-isolation', reserve(input, record) {
    calls.push('reserve');
    return {
      async prepare(signal) {
        calls.push('prepare'); const chunks = [];
        await transferSandcastleWorkspace(record, {
          async exec(command) { return { stdout: command === 'mktemp -d -t sandcastle-XXXXXX' ? '/tmp/sandcastle-SMOKE\n'
            : command === 'git rev-parse HEAD' ? allowed + '\n' : '', stderr: '', exitCode: 0 }; },
          async upload(path, bytes) { assert.equal(path, '/tmp/sandcastle-SMOKE/repo.bundle');
            for await (const chunk of bytes) { chunks.push(Buffer.from(chunk)); transferredBytes += chunk.length; } },
        }, { maxBundleBytes: 1_000_000, signal });
        await writeFile(bundle, Buffer.concat(chunks));
        await git(root, 'clone', '--no-local', bundle, runtime); await git(runtime, 'checkout', record.branch);
        assert.equal(await git(runtime, 'rev-parse', '--path-format=absolute', '--git-common-dir'), join(runtime, '.git'));
        await assert.rejects(access(join(runtime, '.git/objects/info/alternates')));
        for (const oid of [future, tag, dangling]) await assert.rejects(git(runtime, 'cat-file', '-e', oid));
        assert.equal(await readFile(join(runtime, 'src/value.ts'), 'utf8'), 'export const value = "unknown";\n');
        assert.match(await readFile(join(runtime, 'tests/value.test.ts'), 'utf8'), /Committed test file/);
        const observation = await verifyRuntimeCheckout(runtime, allowed, record.branch, input.historyPolicy, root, input.evaluation);
        assert.equal(observation.clean && observation.identityValid, true); runtimeVerified = true;
        return observation;
      },
      async execute() { calls.push('execute'); assert.equal(runtimeVerified, true); return { authored: true, modelExecution: 'not_run', targetCodeExecution: 'not_run' }; },
      async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
      async collect() { calls.push('collect'); return []; },
      async destroy() { calls.push('destroy'); await rm(runtime, { recursive: true, force: true }); return { destroyed: true, verified: true }; },
    };
  } };
  const result = await createCodexWorkspaceRunner(backend).run(request);
  assert.equal(result.execution, 'succeeded', JSON.stringify(result.errors)); assert.equal(result.cleanup, 'verified');
  assert.deepEqual(calls, ['reserve', 'prepare', 'execute', 'stop', 'collect', 'destroy']);
  assert.deepEqual(result.output, { authored: true, modelExecution: 'not_run', targetCodeExecution: 'not_run' });
  await assert.rejects(access(result.leasePath)); await unchanged();
  assert.equal((await cleanupWorkspace(workspace)).record.status, 'closed-clean'); await unchanged();
  assert.equal(await git(source, 'show-ref'), sourceRefs); assert.equal(fetchBoundaryCalls, 0);
  console.log(JSON.stringify({ schemaVersion: 1, classification: 'development-fixture', mode: 'compiled-evaluation-workspace-real-sandcastle-bundle-smoke',
    policy: request.historyPolicy, exportId: prepared.evaluation.exportId, requestDigest: result.requestDigest,
    baselineRequestDigest: baseline.requestDigest, baselineRecordDigest: baseline.recordDigest, inventory: baseline.record.inventory,
    transfer: 'real-public-sandcastle-bundle', transferredBytes, runtime: 'authored-standalone-clone-no-shared-object-storage',
    forbiddenFutureObjectLookups: 'all-rejected', fullCommittedSourceAndTestTree: 'verified-without-execution',
    baselineMetadataAcrossPrepareExecutionCleanup: 'byte-identical', sourceRefs: 'unchanged',
    execution: result.execution, cleanup: result.cleanup, lifecycle: result.lifecycle, fetchBoundaryCalls,
    modelExecution: 'not_run', targetCodeExecution: 'not_run', liveBackend: 'not_run', historicalPublicAvailability: 'unproven', timestampsEstablishVisibility: false,
    limitations: ['Authored development fixture, not an empirical evaluation or historical availability proof.',
      'No live OpenSandbox cluster or model was used; local lifecycle receipts are authored fixture evidence.',
      'Object/ref isolation is not a runtime/filesystem sandbox; real evaluation runtimes must not have source/store access.'] }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }

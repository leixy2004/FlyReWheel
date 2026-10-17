import { createCodexWorkspaceRunner } from '../dist/workspace/codex-runner.js';
// Real local Git/compiled CLI operations on an authored fixture, no model or sandbox.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { acquireWorkspaceExecutionLease } from '../dist/workspace/index.js';
import { workspaceGit } from '../dist/workspace/process.js';
const repoPath = await mkdtemp(join(tmpdir(), 'flyrewheel-cancel-'));
const git = async (...args) => (await workspaceGit(repoPath, ...args)).trim();
await git('init', '--initial-branch=main');
await git('config', 'user.name', 'Authored Fixture');
await git('config', 'user.email', 'fixture@example.invalid');
await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n');
await writeFile(join(repoPath, 'value.txt'), 'authored local fixture\n');
await git('add', '.'); await git('commit', '-m', 'authored fixture');
const sha = await git('rev-parse', 'HEAD');
const identity = { repoPath, runId: 'cancel-smoke', attemptId: 'one' };
const calls = [];
function cli(operation, extra = [], failure = false) {
  const args = ['dist/cli.js', 'workspace', operation, '--repo', repoPath, '--run', identity.runId, '--attempt', identity.attemptId, ...extra];
  try {
    const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    calls.push({ operation, exitCode: 0 }); assert.equal(failure, false); return result;
  } catch (error) {
    if (!failure || error.status !== 1) throw error;
    calls.push({ operation, exitCode: error.status, error: String(error.stderr) });
    return String(error.stderr);
  }
}
const results = [];
for (const verified of [true, false]) {
  identity.attemptId = verified ? 'verified' : 'unverified';
  cli('prepare', ['--base', sha]);
  const stages = [];
  const runtime = {
    async prepare() { return { expectedSha: sha, headSha: sha, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
    async execute() {
      cli('cancel', ['--reason', 'cross-process authored cancellation']);
      assert.match(cli('cleanup', [], true), /lease is active/);
      return new Promise(() => {});
    },
    async stop() { stages.push('stop'); return { stopped: true, verified }; },
    async collect() { stages.push('collect'); return []; },
    async destroy() { stages.push('destroy'); return { destroyed: true, verified: true }; },
  };
  const result = await createCodexWorkspaceRunner({ kind: 'authored-test-no-isolation', reserve: () => runtime }).run({
    workspace: { ...identity }, expectedSha: sha, model: 'authored-no-model', prompt: 'authored fixture',
    toolPolicy: 'full-repo-shell-v1', historyPolicy: 'all-local-refs-v1',
    limits: { maxInputBytes: 32768, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxArtifacts: 1, timeoutMs: 10000, cleanupTimeoutMs: 1000 },
  });
  assert.equal(result.execution, 'cancelled');
  assert.equal(result.output, null);
  assert.equal(result.cleanup, verified ? 'verified' : 'retained-for-recovery');
  assert.deepEqual(stages, verified ? ['stop', 'collect', 'destroy'] : ['stop']);
  const state = cli('inspect');
  assert.equal(state.executionLeaseActive, !verified);
  if (verified) assert.equal(cli('cleanup').record.status, 'closed-clean');
  else assert.match(cli('cleanup', [], true), /lease is active/);
  await assert.rejects(acquireWorkspaceExecutionLease(identity, sha), /cancelled/);
  results.push({ verifiedStop: verified, execution: result.execution, cleanup: result.cleanup, stages, lifecycle: result.lifecycle });
}
const report = { status: 'passed', source: 'authored temporary Git fixture and injected backend', modelCalls: 0,
  productionIsolationTested: false, results, calls };
await writeFile(join(repoPath, 'runner-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

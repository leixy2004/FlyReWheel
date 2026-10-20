import { createCodexWorkspaceRunner } from '../dist/workspace/codex-runner.js';
// Real local Git/compiled CLI operations on an authored fixture, no model or sandbox.
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { acquireWorkspaceExecutionLease } from '../dist/workspace/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedProcessBytes, workspaceGit } from '../dist/workspace/process.js';
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
  const ready = join(repoPath, '.sandcastle', `real-process-${identity.attemptId}.json`);
  let completion, ownedPids;
  const stopped = async pid => {
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z'; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  };
  const runtime = {
    async prepare() { return { expectedSha: sha, headSha: sha, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
    async execute(signal) {
      const grandchild = `require('node:fs').writeFileSync(process.argv[1],JSON.stringify([Number(process.argv[2]),process.pid])); setInterval(()=>{},1000);`;
      const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1],String(process.pid)],{stdio:'inherit'}); setInterval(()=>{},1000);`;
      completion = boundedProcessBytes(process.execPath, ['-e', child, ready], repoPath, 4096, true, 10000, undefined, signal)
        .then(value => ({ value }), error => ({ error }));
      for (let i = 0; i < 200 && !await access(ready).then(() => true, () => false); i++) await delay(10);
      ownedPids = JSON.parse(await readFile(ready, 'utf8'));
      assert.equal(ownedPids.length, 2);
      assert.equal(await stopped(ownedPids[0]), false);
      assert.equal(await stopped(ownedPids[1]), false);
      cli('cancel', ['--reason', 'real owned child cancellation']);
      assert.match(cli('cleanup', [], true), /lease is active/);
      const outcome = await completion;
      if (outcome.error) throw outcome.error;
      return outcome.value;
    },
    async stop() {
      stages.push('stop');
      const outcome = await completion;
      assert.match(String(outcome.error), /cancelled/);
      for (let i = 0; i < 100 && !(await Promise.all(ownedPids.map(stopped))).every(Boolean); i++) await delay(10);
      assert.ok((await Promise.all(ownedPids.map(stopped))).every(Boolean));
      // false is an injected refusal of a stop receipt after actual termination.
      return { stopped: true, verified };
    },
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
  results.push({ verifiedStop: verified, actualOwnedProcessesTerminated: true, injectedStopReceiptRefusal: !verified, execution: result.execution, cleanup: result.cleanup, stages, lifecycle: result.lifecycle });
}
const report = { status: 'passed', source: 'real owned Linux child and same-group descendant; authored adapter, no production sandbox', modelCalls: 0,
  productionIsolationTested: false, adapterPrepareCollectDestroy: 'authored callbacks, not production evidence', results, calls };
await writeFile(join(repoPath, 'real-process-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

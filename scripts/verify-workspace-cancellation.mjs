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
cli('prepare', ['--base', sha]);
const lease = await acquireWorkspaceExecutionLease(identity, sha);
const cancelled = cli('cancel', ['--reason', 'authored local cancellation']);
assert.equal(cancelled.executionLeaseActive, true);
assert.equal(cancelled.runtimeStop, 'not-verified');
assert.deepEqual(cli('cancel', ['--reason', 'repeat']), cancelled);
assert.match(cli('cleanup', [], true), /lease is active/);
await lease.release();
await assert.rejects(acquireWorkspaceExecutionLease(identity, sha), /cancelled/);
const observed = cli('inspect');
assert.equal(observed.executionLeaseActive, false);
assert.deepEqual(observed.cancellation, cancelled.cancellation);
assert.equal(cli('cleanup').record.status, 'closed-clean');
assert.deepEqual(cli('inspect').cancellation, cancelled.cancellation);
assert.equal(await git('rev-parse', 'HEAD'), sha);
const report = { status: 'passed', source: 'authored temporary Git fixture', modelCalls: 0, productionIsolationTested: false, calls,
  checks: ['durable cross-process cancellation', 'idempotent request', 'active lease prevents cleanup', 'cancelled attempt rejects new lease', 'clean removal retains cancellation and main HEAD'] };
await writeFile(join(repoPath, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

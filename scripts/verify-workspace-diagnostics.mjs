// Real local Git/compiled CLI operations on an authored fixture, no model or sandbox.
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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
const prepared = cli('prepare', ['--base', sha]);
const manifestBefore = await readFile(prepared.manifestPath, 'utf8');
const historyPath = join(prepared.manifestPath, '..', 'history.jsonl');
const historyBefore = await readFile(historyPath, 'utf8');
assert.equal(cli('diagnose').lease.state, 'absent');
// A separate process really exits holding a lease. It starts no runtime/model.
const moduleUrl = pathToFileURL(resolve('dist/workspace/index.js')).href;
const child = `const {acquireWorkspaceExecutionLease}=await import(process.argv[1]); const lease=await acquireWorkspaceExecutionLease(JSON.parse(process.argv[2]), process.argv[3]); console.log(JSON.stringify({leasePath:lease.leasePath}));`;
const { leasePath } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child, moduleUrl, JSON.stringify(identity), sha], { encoding: 'utf8' }));
const ownerPath = join(leasePath, 'owner.json');
const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
owner.createdAt = '2000-01-01T00:00:00.000Z';
const ownerBytes = JSON.stringify(owner); await writeFile(ownerPath, ownerBytes);
cli('cancel', ['--reason', 'diagnose residual lease']);
const report = cli('diagnose');
assert.equal(report.lease.state, 'present');
assert.equal(report.cancellation.state, 'requested');
assert.equal(report.recovery.automaticRelease, false);
assert.equal(report.recovery.runtimeStop, 'not-verified');
assert.ok(!JSON.stringify(report).includes(owner.token));
assert.equal(await readFile(ownerPath, 'utf8'), ownerBytes);
assert.match(cli('cleanup', [], true), /lease is active/);
const checks = ['separate owner process exited without releasing lease', 'old owner does not authorize release', 'owner token omitted', 'cancellation does not certify stop'];
for (const bytes of ['{bad', 'x'.repeat(4097)]) {
  await writeFile(ownerPath, bytes);
  assert.equal(cli('diagnose').lease.state, 'unverifiable');
  assert.equal(await readFile(ownerPath, 'utf8'), bytes);
}
await rm(ownerPath);
assert.equal(cli('diagnose').lease.state, 'unverifiable');
const target = join(repoPath, 'test-owner-target'); await writeFile(target, ownerBytes);
await symlink(target, ownerPath);
assert.equal(cli('diagnose').lease.state, 'unverifiable');
assert.equal(await readFile(target, 'utf8'), ownerBytes);
await rm(ownerPath); await writeFile(ownerPath, ownerBytes);
const cancellationPath = join(leasePath, '..', 'cancellation.json');
await writeFile(cancellationPath, '{bad');
assert.equal(cli('diagnose').cancellation.state, 'unverifiable');
const operationLock = join(repoPath, '.sandcastle', 'flyrewheel-operation.lock'); await mkdir(operationLock);
assert.ok(cli('diagnose').cleanup.blockedReasons.includes('repository-operation-lock-present'));
await rm(operationLock, { recursive: true });
await writeFile(join(prepared.record.worktreePath, 'untracked.txt'), 'preserve');
assert.ok(cli('diagnose').cleanup.blockedReasons.includes('worktree-content-must-be-preserved'));
assert.equal(await readFile(prepared.manifestPath, 'utf8'), manifestBefore);
assert.equal(await readFile(historyPath, 'utf8'), historyBefore);
checks.push('missing malformed oversized linked owner retained', 'damaged cancellation reported', 'operation lock and untracked bytes reported', 'manifest and history unchanged');
identity.attemptId = 'missing';
cli('diagnose', [], true);
const evidence = { status: 'passed', input: 'authored local Git fixture', modelCalls: 0, productionStopVerified: false, checks, calls };
await writeFile(join(repoPath, 'diagnostic-verification.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));

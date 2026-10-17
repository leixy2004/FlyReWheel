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
  const args = ['dist/cli.js', 'workspace', operation, '--repo', repoPath, ...(operation === 'list' ? [] : ['--run', identity.runId, '--attempt', identity.attemptId]), ...extra];
  try {
    const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    calls.push({ operation, exitCode: 0 }); assert.equal(failure, false); return result;
  } catch (error) {
    if (!failure || error.status !== 1) throw error;
    calls.push({ operation, exitCode: error.status, error: String(error.stderr) });
    return String(error.stderr);
  }
}
assert.deepEqual(cli('list').summary, { total: 0, diagnosed: 0, unavailable: 0 });
const prepared = cli('prepare', ['--base', sha]);
const moduleUrl = pathToFileURL(resolve('dist/workspace/index.js')).href;
const child = `const {acquireWorkspaceExecutionLease}=await import(process.argv[1]); const lease=await acquireWorkspaceExecutionLease(JSON.parse(process.argv[2]), process.argv[3]); console.log(JSON.stringify({leasePath:lease.leasePath}));`;
const { leasePath } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child, moduleUrl, JSON.stringify(identity), sha], { encoding: 'utf8' }));
cli('cancel', ['--reason', 'inventory authored fixture']);
const manifestBefore = await readFile(prepared.manifestPath, 'utf8');
const historyPath = join(prepared.manifestPath, '..', 'history.jsonl');
const historyBefore = await readFile(historyPath, 'utf8');
const ownerPath = join(leasePath, 'owner.json');
const ownerBefore = await readFile(ownerPath, 'utf8');
identity.attemptId = 'closed';
cli('prepare', ['--base', sha]); cli('cleanup');
const attempts = join(prepared.manifestPath, '..', '..');
await mkdir(join(attempts, 'attempt-cancel-smoke--bad'));
const badPath = join(attempts, 'attempt-cancel-smoke--bad', 'manifest.json');
await writeFile(badPath, '{malformed');
await mkdir(join(attempts, 'attempt-cancel-smoke--missing'));
await writeFile(join(attempts, 'unknown-file'), 'invalid entry');
await symlink(join(prepared.manifestPath, '..'), join(attempts, 'attempt-cancel-smoke--linked'));
const inventory = cli('list');
assert.deepEqual(inventory.summary, { total: 6, diagnosed: 2, unavailable: 4 });
const active = inventory.entries.find(entry => entry.identity?.attemptId === 'one').diagnosis;
assert.equal(active.lease.state, 'present');
assert.equal(active.cancellation.state, 'requested');
assert.ok(active.cleanup.blockedReasons.includes('execution-lease-present'));
assert.equal(inventory.entries.find(entry => entry.identity?.attemptId === 'closed').diagnosis.manifestState, 'closed-clean');
assert.ok(!JSON.stringify(inventory).includes(JSON.parse(ownerBefore).token));
assert.equal(await readFile(ownerPath, 'utf8'), ownerBefore);
assert.equal(await readFile(prepared.manifestPath, 'utf8'), manifestBefore);
assert.equal(await readFile(historyPath, 'utf8'), historyBefore);
assert.equal(await readFile(badPath, 'utf8'), '{malformed');
identity.attemptId = 'one';
assert.match(cli('cleanup', [], true), /lease is active/);
const report = { status: 'passed', input: 'authored temporary Git repository', modelCalls: 0, productionIsolationTested: false,
 checks: ['empty inventory', 'separate process exited holding lease', 'cross-process cancellation and cleanup blockers', 'closed attempts retained', 'all four damaged entries reported', 'ownership token omitted', 'manifest history and lease unchanged', 'cleanup still refuses active lease'], calls };
await writeFile(join(repoPath, 'inventory-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

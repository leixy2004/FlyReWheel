import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(), 'flyrewheel-process-evidence-'));
const calls = [];
function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'workspace', 'process-evidence', ...args], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, expected, result.stderr);
  calls.push({ operation: args[0], exitCode: result.status });
  return result.stdout ? JSON.parse(result.stdout) : null;
}
const path = join(root, 'normal');
const first = cli(['probe', '--directory', path]);
assert.equal(first.childStopVerified, true);
assert.equal(first.leaseReleaseAuthorized, false);
const filesBefore = await Promise.all(['identity.json', 'exit.json'].map(name => readFile(join(path, name), 'utf8')));
const restarted = cli(['inspect', '--directory', path, '--identity-digest', first.identityDigest]);
assert.deepEqual(restarted, first);
assert.deepEqual(await Promise.all(['identity.json', 'exit.json'].map(name => readFile(join(path, name), 'utf8'))), filesBefore);
cli(['inspect', '--directory', path, '--identity-digest', '0'.repeat(64)], 1);
cli(['probe', '--directory', path], 1);
await rm(join(path, 'exit.json'));
assert.equal(cli(['inspect', '--directory', path, '--identity-digest', first.identityDigest], 2).childStopVerified, false);
await writeFile(join(path, 'exit.json'), '{bad');
cli(['inspect', '--directory', path, '--identity-digest', first.identityDigest], 1);
// A separately created owner exits abruptly without calling stop(). The fixed
// child is designed to exit on IPC disconnection; no persisted PID is signalled.
const crashedPath = join(root, 'owner-exit');
const source = `const {startLocalProcessProbe}=await import(process.argv[1]); const p=await startLocalProcessProbe(process.argv[2]); process.stdout.write(JSON.stringify(p.receipt),()=>process.exit(23));`;
const owner = spawnSync(process.execPath, ['--input-type=module', '-e', source, pathToFileURL(resolve('dist/local-process-evidence.js')).href, crashedPath], { encoding: 'utf8', timeout: 10000 });
assert.ifError(owner.error); assert.equal(owner.status, 23, owner.stderr);
const receipt = JSON.parse(owner.stdout);
let crashed;
for (let i = 0; i < 20; i++) {
  crashed = cli(['inspect', '--directory', crashedPath, '--identity-digest', receipt.digest], 2);
  if (crashed.processState !== 'present') break;
  await delay(50);
}
assert.notEqual(crashed.processState, 'present');
assert.equal(crashed.childStopVerified, false);
assert.equal(crashed.reason, 'creator-exit-evidence-missing');
assert.equal(crashed.automaticRecovery, false);
assert.equal(crashed.leaseReleaseAuthorized, false);
const report = { status: 'passed', scope: 'real fixed owned Node child; no runtime adoption, lease release or production authority', modelCalls: 0,
  checks: ['creator-close evidence verifies after CLI restart', 'inspection leaves evidence unchanged', 'identity mismatch rejected', 'existing directory refused', 'absent/corrupt exit evidence refused', 'owner process exits 23 without stop; child exits on IPC disconnect', 'crash-side child absence does not substitute for creator evidence'], calls };
await writeFile(join(root, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

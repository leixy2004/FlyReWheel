import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRecoveryFixture } from '../tests/helpers/matched-study-recovery-fixture.js';
import { createAuthoredCodexNativeMatchedTransport } from '../src/adapters/matched-revision-codex.js';
import { runSdkNativeStudy } from '../experiments/matched-revision/sdk-native-study.js';
import { openPostgresDatabase } from '../src/storage/database.js';
import { MatchedStudyStore } from '../src/storage/matched-studies.js';

// Runs the installed SDK with an authored executable, never a provider/model.
// The database must be the isolated disposable instance used by verify-postgres.
const [phase, socket, directory] = process.argv.slice(2);
assert(['verify', 'crash-child', 'resume-child'].includes(phase));
assert(socket?.startsWith('/')); assert(directory?.startsWith('/'));
const uri = `postgresql://postgres@/flyrewheel_verify?host=${encodeURIComponent(socket)}`;
const script = fileURLToPath(import.meta.url);
if (phase === 'verify') {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-pg-study-'));
  const input = await createRecoveryFixture(join(root, 'fixture'), 2);
  await writeFile(join(root, 'input.json'), JSON.stringify(input));
  const run = async (mode: string) => {
    const child = fork(script, [mode, socket, root], { execArgv: ['--import', 'tsx'], env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    try {
      return await Promise.race([once(child, 'exit'), delay(90000, null, { ref: false }).then(() => { throw new Error('Study subprocess timed out'); })]);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  };
  const [exitCode, signal] = await run('crash-child');
  assert.equal(exitCode, null); assert.equal(signal, 'SIGKILL');
  const audit = async () => (await readFile(join(input.transportOptions.workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n');
  assert.equal((await audit()).length, 12);
  const checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  const db = await openPostgresDatabase(uri);
  try {
    const store = await MatchedStudyStore.openExisting(db);
    const deadline = Date.now() + 45000;
    while (!(await store.inspect(checkpoint.studyDigest))?.leaseExpired) {
      assert(Date.now() < deadline, 'Real database lease did not expire');
      await delay(250);
    }
  } finally { await db.close(); }
  assert.deepEqual(await run('resume-child'), [0, null]);
  const first = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
  assert.equal(first.execution, 'completed'); assert.equal(first.counts.completedBlocks, 2); assert.equal(first.counts.retries, 0);
  assert.deepEqual(first.blocks[0], checkpoint.block);
  assert.equal((await audit()).length, 24);
  assert.deepEqual(await run('resume-child'), [0, null]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'report.json'), 'utf8')), first);
  assert.equal((await audit()).length, 24);
  const evidence = { backend: 'real PostgreSQL server', sdk: 'installed official SDK with authored executable', modelExecution: 'not_run',
    driverCrashSignal: signal, completedBlocksBeforeCrash: 1, authoredCallsBeforeCrash: 12, expiredByDatabaseClock: true,
    completedBlocksAfterRecovery: 2, authoredCallsAfterRecovery: 24, retainedBlockByteEquivalent: true,
    freshProcessReopenIdentical: true, additionalCallsOnReopen: 0, retries: first.counts.retries, reportDigest: first.digest };
  await writeFile(directory, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} else {
  const input = JSON.parse(await readFile(join(directory, 'input.json'), 'utf8'));
  const db = await openPostgresDatabase(uri);
  try {
    const store = await MatchedStudyStore.openExisting(db);
    if (phase === 'crash-child') {
      const append = store.append.bind(store);
      store.append = async (...args: Parameters<typeof append>) => {
        await append(...args);
        if (args[2] === 'block-result') {
          await writeFile(join(directory, 'checkpoint.json'), JSON.stringify({ studyDigest: args[0].studyDigest, block: args[3] }));
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        }
      };
    }
    const result = await runSdkNativeStudy({ ...input, transport: createAuthoredCodexNativeMatchedTransport(input.transportOptions), store });
    await writeFile(join(directory, 'report.json'), JSON.stringify(result));
  } finally { await db.close(); process.disconnect?.(); }
}

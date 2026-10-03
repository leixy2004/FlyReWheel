import { openPGliteDatabase } from '../../src/storage/database.js';
import { MatchedStudyStore } from '../../src/storage/matched-studies.js';
import { inspectSdkNativeStudy } from './sdk-native-status.js';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeEvaluationJson } from '../../src/paired-evaluation.js';
import { createMatchedFixture } from './fixture.js';
import { runMatchedRevision } from './runner.js';

const [mode, directory, ...extra] = process.argv.slice(2);
if (mode === '--study-status' && directory && extra.length === 2 && extra[0] === '--db') {
  // Require an existing local directory; no implicit new database or ambient URL.
  if (!(await stat(extra[1])).isDirectory() || !(await stat(join(extra[1], 'PG_VERSION'))).isFile()) throw new Error('Study status requires an existing PGlite directory');
  const db = await openPGliteDatabase(extra[1]);
  try {
    const status = await inspectSdkNativeStudy(await MatchedStudyStore.openExisting(db), directory);
    console.log(JSON.stringify(status ?? { state: 'not_found', studyDigest: directory }, null, 2));
    if (!status) process.exitCode = 1;
  } finally { await db.close(); }
} else if (mode !== '--fixture' || !directory || extra.length) {
  console.error('Usage: npm run experiment:matched -- --fixture <new-output-directory>\nStatus: npm run experiment:matched -- --study-status <study-digest> --db <existing-pglite-directory>\nLive production execution is not configured.');
  process.exitCode = 2;
} else {
  const { packet, future, transport } = createMatchedFixture();
  const report = await runMatchedRevision({ mode: 'authored_fixture', packet, future, transport });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const [name, value] of Object.entries({ packet, future, report })) await writeEvaluationJson(join(directory, `${name}.json`), value);
  console.log(JSON.stringify({ execution: report.execution, modelExecution: report.modelExecution,
    mode: 'authored-fixture-mechanics-only', directory, files: ['packet.json', 'future.json', 'report.json'],
    arms: report.arms.map(a => ({ arm: a.arm, disposition: a.disposition, acceptedChange: a.acceptedChange,
      gatePassed: a.gate.passed, scheduledTargets: a.metrics.scheduledTargets })) }, null, 2));
}

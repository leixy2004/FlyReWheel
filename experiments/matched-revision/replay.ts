import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeEvaluationJson } from '../../src/paired-evaluation.js';
import { createMatchedFixture } from './fixture.js';
import { runMatchedRevision } from './runner.js';

const [mode, directory, ...extra] = process.argv.slice(2);
if (mode !== '--fixture' || !directory || extra.length) {
  console.error('Usage: npm run experiment:matched -- --fixture <new-output-directory>\nLive production execution is not configured.');
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

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeEvaluationJson } from '../../src/paired-evaluation.js';
import { createMatchedFixture } from './fixture.js';
import { freezeAuthoredEvaluationContract, runContractedEvaluation } from './evaluation-contract.js';
const [mode, directory, ...extra] = process.argv.slice(2);
if (mode !== '--authored-smoke' || !directory || extra.length) {
  throw new Error('Usage: node --import tsx experiments/matched-revision/contract-replay.ts --authored-smoke <new-output-directory>');
}
const { packet, future, transport } = createMatchedFixture();
const contract = freezeAuthoredEvaluationContract(packet, future, {
  basis: 'authored-declarations-not-historical-proof', revisionCutoff: '2026-10-02T00:00:00Z',
  futureWindowStart: '2026-10-03T00:00:00Z' });
const report = await runContractedEvaluation({ mode: 'authored_fixture', contract, packet, future, transport });
await mkdir(directory, { recursive: false, mode: 0o700 });
for (const [name, value] of Object.entries({ contract, packet, future, report })) {
  await writeEvaluationJson(join(directory, `${name}.json`), value);
}
console.log(JSON.stringify({ execution: report.execution, modelExecution: report.modelExecution,
  arms: report.arms.map(a => a.arm), contractDigest: contract.digest,
  interpretation: 'authored smoke only; no superiority or historical visibility established', directory }, null, 2));

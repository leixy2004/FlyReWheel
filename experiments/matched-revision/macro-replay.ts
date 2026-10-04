import { join } from 'node:path';
import { readEvaluationJson, writeEvaluationJson } from '../../src/paired-evaluation.js';
import { aggregateMatchedResults, type PlannedResult } from './macro-report.js';
const [flag, directory, outFlag, out, ...extra] = process.argv.slice(2);
if (flag !== '--from-contract-smoke' || !directory || outFlag !== '--out' || !out || extra.length) {
  throw new Error('Usage: node --import tsx experiments/matched-revision/macro-replay.ts --from-contract-smoke <directory> --out <new-file>');
}
const packet = await readEvaluationJson(join(directory, 'packet.json'), 16_000_000);
const future = await readEvaluationJson(join(directory, 'future.json'), 16_000_000);
const wrapped = await readEvaluationJson(join(directory, 'report.json'), 32_000_000) as { report?: unknown };
if (!wrapped.report) throw new Error('Expected existing completed contract smoke with nested runner report');
const result = aggregateMatchedResults([{ packet, future, repetition: 1, report: wrapped.report } as PlannedResult]);
await writeEvaluationJson(out, result);
console.log(JSON.stringify({ output: out, digest: result.digest, inference: result.inference,
  plannedUnits: result.plannedUnits, strata: result.strata.length,
  intervals: result.strata.map(s => s.uncertainty.state) }, null, 2));

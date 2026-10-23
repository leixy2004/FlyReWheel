import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readEvaluationJson, writeEvaluationJson } from '../../src/paired-evaluation.js';
import { aggregateMatchedResults, type PlannedResult } from './macro-report.js';
import { aggregateNativeStudy, type NativeMacroInput } from './native-macro-report.js';
const [flag, input, outFlag, out, ...extra] = process.argv.slice(2);
if (flag === '--native-authored-smoke' && input && !outFlag) {
  const directory = resolve(input); await mkdir(directory);
  const { createNativeMacroFixture } = await import('./native-macro-fixture.js');
  const fixture = await createNativeMacroFixture(directory);
  await writeEvaluationJson(join(directory, 'input.json'), fixture);
  const report = aggregateNativeStudy(fixture);
  await writeEvaluationJson(join(directory, 'report.json'), report);
  console.log(JSON.stringify({ directory, digest: report.digest, plannedBlocks: report.macro.plannedUnits,
    missingReports: report.macro.missingReports, modelCalls: 0, intervals: report.macro.strata.map(s => s.uncertainty.state) }, null, 2));
} else {
  if (!['--from-contract-smoke', '--native-study'].includes(flag) || !input || outFlag !== '--out' || !out || extra.length) {
    throw new Error('Usage: macro-replay.ts --native-study <input.json> --out <new-file> | --native-authored-smoke <new-directory> | --from-contract-smoke <directory> --out <new-file>');
  }
  if (flag === '--native-study') {
    const result = aggregateNativeStudy(await readEvaluationJson(input, 64_000_000) as NativeMacroInput);
    await writeEvaluationJson(out, result);
    console.log(JSON.stringify({ output: out, digest: result.digest, inference: result.inference,
      plannedUnits: result.macro.plannedUnits, intervals: result.macro.strata.map(s => s.uncertainty.state) }, null, 2));
  } else {
    const packet = await readEvaluationJson(join(input, 'packet.json'), 16_000_000);
    const future = await readEvaluationJson(join(input, 'future.json'), 16_000_000);
    const wrapped = await readEvaluationJson(join(input, 'report.json'), 32_000_000) as { report?: unknown };
    if (!wrapped.report) throw new Error('Expected existing completed contract smoke with nested runner report');
    const result = aggregateMatchedResults([{ packet, future, repetition: 1, report: wrapped.report } as PlannedResult]);
    await writeEvaluationJson(out, result);
    console.log(JSON.stringify({ output: out, digest: result.digest, inference: result.inference,
      plannedUnits: result.plannedUnits, strata: result.strata.length,
      intervals: result.strata.map(s => s.uncertainty.state) }, null, 2));
  }
}

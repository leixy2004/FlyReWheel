import { parseArgs } from 'node:util';
import { readEvaluationJson } from '../../src/paired-evaluation.js';
import { exportAnnotation, importAnnotation, exportAdjudication, importAdjudication, inspectAnnotation } from './workflow.js';
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  plan: { type: 'string' }, assignment: { type: 'string' }, out: { type: 'string' },
  workspace: { type: 'string' }, submission: { type: 'string' } } });
const [command, ...extra] = positionals;
if (extra.length) throw new Error('Unexpected command arguments');
let result: unknown;
if (command === 'export' && values.plan && values.assignment && values.out) {
  result = await exportAnnotation(await readEvaluationJson(values.plan, 16_000_000),
    await readEvaluationJson(values.assignment, 100_000), values.out);
} else if (command === 'init-authored' && values.out) {
  const { createAnnotationFixture } = await import('./fixture.js');
  const { plan, assignment } = createAnnotationFixture(); result = await exportAnnotation(plan, assignment, values.out);
} else if (command === 'import' && values.workspace && values.submission) {
  result = await importAnnotation(values.workspace, values.submission);
} else if (command === 'adjudication-export' && values.workspace) {
  result = await exportAdjudication(values.workspace);
} else if (command === 'adjudicate' && values.workspace && values.submission) {
  result = await importAdjudication(values.workspace, values.submission);
} else if (command === 'status' && values.workspace) {
  result = await inspectAnnotation(values.workspace);
} else throw new Error('Use export --plan --assignment --out | init-authored --out | import --workspace --submission | adjudication-export --workspace | adjudicate --workspace --submission | status --workspace');
console.log(JSON.stringify(result, null, 2));

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readEvaluationJson, writeEvaluationJson } from '../../src/paired-evaluation.js';
import { digestOf } from '../../src/core/identity.js';
import { createGuardedFamilyFixture } from './guarded-family-fixture.js';
import { inspectGuardedLabelRoute } from './guarded-family.js';
import { exportAnnotation } from './workflow.js';
import { MEMBERS, validateFrozenPackage } from '../../scripts/prepare-w0-mining.js';
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  out: { type: 'string' }, plan: { type: 'string' }, spec: { type: 'string' },
  annotations: { type: 'string' }, targets: { type: 'string' } } });
if (positionals.length !== 1 || !values.out) throw new Error('Supply one command and a new --out path');
let result: unknown;
if (positionals[0] === 'retained-admission') {
  const rows = [];
  const retainedAuditFiles = ['evaluation-preparation/PAPER-DATA-AUDIT.md',
    'evaluation-preparation/provenance-ledger.json', 'behavior-validation/container-results.json'];
  const auditEvidence = await Promise.all(retainedAuditFiles.map(async path => {
    const bytes = await readFile(new URL(`../temporal-pilot/w0-first-three/${path}`, import.meta.url));
    return { path: `experiments/temporal-pilot/w0-first-three/${path}`, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  for (const member of MEMBERS) {
    const url = new URL(`../temporal-pilot/w0-first-three/proxy-attempt-1/package-${member.number}.json`, import.meta.url);
    const bytes = await readFile(url), pkg = validateFrozenPackage(bytes, member);
    rows.push({ number: member.number, sha256: createHash('sha256').update(bytes).digest('hex'),
      snapshotDigest: digestOf(pkg.evidence.evidence.snapshot), admission: 'blocked',
      missing: ['source-supported substantive rule/constraint', 'actual independently verified feedback', 'independent future opportunities'] });
  }
  const body = { schemaVersion: 1, kind: 'retained-httpx-family-admission', examinedScope: 'three exposed W0 development packages only',
    conclusions: ['3035 is a mkdocs-material pin change; no docs behavior result establishes a defect',
      '3031 is a Ruff pin change; both bounded tool checks pass, not a semantic repair label',
      '3036 changes setup-python references; static syntax/ref checks do not establish external action behavior'],
    rows, auditEvidence, conclusionBasis: 'Retained source changes and recorded offline audit/tool evidence; no fresh behavior run',
    admittedEmpiricalFamilies: 0, interpretation: 'Insufficient retained evidence; not proof no useful family exists in HTTPX',
    h2EpisodeAdmission: 'blocked', currentDiscussionIsHistoricalFeedback: false,
    authoredFamilyDisposition: 'Separate preexisting guarded-operation fixture only; not mined from HTTPX',
    modelCalls: 0, humanLabels: 0, newAcquisitions: 0 };
  result = { ...body, digest: digestOf(body) }; await writeEvaluationJson(values.out, result);
} else if (positionals[0] === 'init-authored') {
  const f = createGuardedFamilyFixture(); result = await exportAnnotation(f.plan, f.assignment, values.out);
  await writeEvaluationJson(join(values.out, 'facilitator', 'family-spec.json'), f.spec);
  await writeEvaluationJson(join(values.out, 'facilitator', 'family-plan.json'), f.plan);
  await writeEvaluationJson(join(values.out, 'facilitator', 'matched-target-inputs.json'), f.targets);
} else if (positionals[0] === 'route' && values.plan && values.spec && values.annotations && values.targets) {
  const [spec, plan, annotations, targets] = await Promise.all([values.spec, values.plan, values.annotations, values.targets]
    .map(path => readEvaluationJson(path, 16_000_000)));
  result = inspectGuardedLabelRoute(spec, plan, annotations, targets); await writeEvaluationJson(values.out, result);
} else throw new Error('Use retained-admission --out <new-file> | init-authored --out <new-private-directory> | route --spec --plan --annotations --targets --out');
console.log(JSON.stringify(result, null, 2));

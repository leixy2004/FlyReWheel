import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const paths = {
  frame: 'experiments/temporal-pilot/httpx-2024-frame.json',
  admission: 'experiments/annotation/verification/httpx-family-admission.json',
  protocol: 'experiments/temporal-pilot/w0-inspection-plan/PROTOCOL.md',
  manifest: 'experiments/temporal-pilot/w0-inspection-plan/manifest.json',
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pinned = {
  frame: '07c1ded10a03002eed7b3f25d75c33e161876d72f71371b4cbfc1652022f477b',
  admission: 'fbf7d2c4316b018c2da5c75d27cf0de244b28a42cd801a308592d4cfa188de24',
};
export function generate(inputs) {
  for (const [name, digest] of Object.entries(pinned)) {
    if (hash(inputs[name]) !== digest) throw new Error(`Pinned ${name} bytes changed`);
  }
  const frame = JSON.parse(inputs.frame);
  const admission = JSON.parse(inputs.admission);
  const selected = frame.pullRequests.filter(pr => pr.window === 'W0')
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
  if (selected.length !== 38 || new Set(selected.map(pr => pr.number)).size !== 38)
    throw new Error('W0 denominator must contain 38 unique PRs');
  if (selected.slice(0, 3).map(pr => pr.number).join(',') !== '3035,3031,3036')
    throw new Error('Prior exposure prefix changed');
  const rows = selected.map((pr, i) => {
    const previous = admission.rows.find(row => row.number === pr.number);
    return {
      order: i + 1, ...pr,
      priorAdmission: previous ?? null,
      planningDisposition: previous ? 'previously_blocked_insufficient_evidence' : 'pending_source_inspection',
      sourceExposure: previous ? 'previously_exposed_development' : 'not_inspected_in_this_planning_task_other_exposure_unverified',
      screening: {
        candidateId: `encode/httpx#${pr.number}`,
        sourceRefs: [`${paths.frame}#PR${pr.number}`, ...(previous ? [paths.admission] : [])],
        screeningOrder: i + 1,
        status: previous ? 'unresolved' : 'pending',
        reasons: previous ? [admission.conclusions[i]] : [],
        developmentExposure: previous ? 'Previously exposed; current admission blocked' : 'Metadata only in this task; collaborator exposure requires audit',
        naturalOrConstructed: 'generated_rule_temporal',
        annotationMinutes: 0,
        missingEvidence: previous ? previous.missing : ['pinned source package and identity/license receipts', 'substantive source-bound rule/contract and complete semantic context'],
      },
      newSourceRequests: 0, independentHumanLabels: 0,
      constructionAttempt: null,
    };
  });
  return {
    schemaVersion: 1, kind: 'prospective-w0-development-inspection-plan',
    baseCommit: 'e410339414f42292f14f938d877a58308e997c25',
    freezeEvent: 'Git commit containing this manifest and protocol, verified on remote before further source inspection',
    formalPreregistration: false, acquisitionAuthorized: false,
    inputDigests: Object.fromEntries(['frame', 'admission', 'protocol'].map(k => [paths[k], hash(inputs[k])])),
    orderRule: 'mergedAt ascending, numeric PR number ascending tie-break',
    window: frame.selection.windows.find(w => w.id === 'W0'),
    counts: { frame: 70, W0: 38, priorBlocked: 3, remaining: 35 },
    proposedBudget: { pendingPRsOnly: true, requestsPerPR: 30, totalRequests: 1050,
      responseBytes: 2 * 1024 ** 2, perPRBytes: 20 * 1024 ** 2,
      totalReceivedDecodedBytes: 350 * 1024 ** 2, totalRetainedBytes: 350 * 1024 ** 2, timeoutSeconds: 60, retries: 0 },
    rows,
  };
}
export function localInputs() {
  return Object.fromEntries(['frame', 'admission', 'protocol'].map(k => [k, readFileSync(resolve(root, paths[k]))]));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Only --check is supported');
  const output = JSON.stringify(generate(localInputs()), null, 2) + '\n';
  const target = resolve(root, paths.manifest);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== output) throw new Error('Manifest differs from deterministic plan');
    console.log('W0 manifest verified: 38 total, 3 prior blocked, 35 pending; no network/source access');
  } else writeFileSync(target, output);
}

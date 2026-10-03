import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { captureGithubPrEvidence, GithubCaptureLimitError } from '../src/github-pr.js';
import { GithubReadError } from '../src/github-pr-diagnostics.js';
import { GithubPrEvidencePackageSchema } from '../src/github-pr-evidence.js';
import { validateW0SourcePackage, W0SourcePackageSchema } from './validate-w0-source-package.js';
import { z } from 'zod';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const planHash = '9b024e81a3886794d4b50fb44767cd53a10a794ffbaf881e4305c6cfd648898a';
type Plan = { repository: string; frameSha256: string; selected: { number: number; mergedAt: string; mergeCommit: string; window: string }[] };
type Captured = z.infer<typeof W0SourcePackageSchema>;
type Item = { number: number; status: 'captured' | 'failed' | 'unattempted'; failure?: string;
  evidenceDigest?: string; snapshotDigest?: string; requests?: number; diagnostic?: GithubReadError['diagnostic']; classification?: GithubReadError['classification'] };

/** Frozen-plan adapter only. The injected capture seam supports offline tests, never credential substitution. */
export async function runW0Capture(rawPlan: unknown, capture: typeof captureGithubPrEvidence = captureGithubPrEvidence,
  options: { priorRequests?: number } = {}) {
  const { priorRequests } = z.object({ priorRequests: z.number().int().min(0).max(49).default(0) }).strict().parse(options);
  const availableGetRequests = 50 - priorRequests;
  if (hash(JSON.stringify(rawPlan)) !== planHash) throw new Error('FROZEN_PLAN_MISMATCH');
  const plan = rawPlan as Plan;
  const startedAt = new Date().toISOString();
  const budget = { requestsRemaining: availableGetRequests, deadline: Date.now() + 300_000 };
  const items: Item[] = plan.selected.map(row => ({ number: row.number, status: 'unattempted' }));
  const packages: Captured[] = [];
  let acceptedEvidenceBytes = 0;
  for (const [index, row] of plan.selected.entries()) {
    const item = items[index];
    if (budget.requestsRemaining <= 0 || Date.now() >= budget.deadline) break;
    const before = budget.requestsRemaining;
    try {
      const result = await capture({ repository: plan.repository, number: row.number,
        maxRequests: Math.min(50, budget.requestsRemaining), includeSourceProvenance: true,
        expectedMerge: { mergedAt: row.mergedAt, mergeCommit: row.mergeCommit } }, { budget });
      if (Date.now() >= budget.deadline) throw new GithubCaptureLimitError('deadline', 'DEADLINE');
      const { sourceProvenance, ...evidence } = result;
      if (!sourceProvenance) throw new Error('SOURCE_PROVENANCE_MISSING');
      GithubPrEvidencePackageSchema.parse(evidence);
      if (evidence.receipt.requests !== before - budget.requestsRemaining) throw new Error('REQUEST_ACCOUNTING_MISMATCH');
      const pull = evidence.evidence.pull;
      if (pull.number !== row.number || pull.repository !== plan.repository || pull.mergedAt !== row.mergedAt ||
        pull.mergeCommit !== row.mergeCommit || !pull.merged) throw new Error('FROZEN_PR_IDENTITY_MISMATCH');
      const sourcePackage = W0SourcePackageSchema.parse({ schemaVersion: 1, kind: 'w0-source-package',
        provenance: 'live-api-observation', planSha256: planHash, evidence,
        acquisition: { maxGetRequests: 50, requests: evidence.receipt.requests,
          observations: evidence.receipt.observations.map(({ endpoint, observedAt, dataDigest }) => ({ endpoint, observedAt, dataDigest })) },
        ...sourceProvenance });
      validateW0SourcePackage(sourcePackage);
      const bytes = Buffer.byteLength(JSON.stringify(sourcePackage));
      if (acceptedEvidenceBytes + bytes > 12_000_000) throw new Error('EVIDENCE_BYTE_BUDGET');
      acceptedEvidenceBytes += bytes;
      packages.push(sourcePackage);
      Object.assign(item, { status: 'captured', evidenceDigest: result.digest,
        snapshotDigest: result.evidence.snapshotDigest, requests: before - budget.requestsRemaining });
    } catch (error) {
      item.status = 'failed';
      item.requests = before - budget.requestsRemaining;
      item.failure = error instanceof GithubCaptureLimitError ? error.reason : error instanceof GithubReadError ? 'GITHUB_READ_FAILED' :
        error instanceof Error && ['FROZEN_PR_IDENTITY_MISMATCH', 'EVIDENCE_BYTE_BUDGET', 'SOURCE_PROVENANCE_MISSING', 'REQUEST_ACCOUNTING_MISMATCH'].includes(error.message) ? error.message : 'CAPTURE_FAILED';
      if (error instanceof GithubReadError) {
        item.classification = error.classification;
        if (error.diagnostic) item.diagnostic = error.diagnostic;
      }
      break;
    }
  }
  return { summary: { schemaVersion: 1, kind: 'w0_first_three_capture_run', repository: plan.repository,
    planSha256: planHash, frameSha256: plan.frameSha256, startedAt, completedAt: new Date().toISOString(),
    status: items.every(item => item.status === 'captured') ? 'captured_quarantined' : 'stopped', items,
    requests: availableGetRequests - budget.requestsRemaining, priorRequests, availableGetRequests,
    totalRequestsUsed: priorRequests + availableGetRequests - budget.requestsRemaining,
    maxGetRequests: 50, maxTotalTimeMs: 300_000, acceptedEvidenceBytes,
    license: packages.length ? 'pinned_bytes_verified_for_accepted_packages' : 'unknown',
    licenseAcquisition: 'required_for_accepted_packages', redistribution: 'not_authorized', packageUse: 'quarantine_only_not_rule_input', historicalW0Feedback: false,
    historicalDiscussionCutoff: 'unknown', discussionUse: 'quarantine_only_not_rule_input', mining: 'not_run',
    treeIdentities: 'required_for_accepted_packages', sourceScope: 'changed_paths_only_not_complete_repository', modelCalls: 0,
    authentication: 'none', retries: 0 }, packages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pushedCommit = process.argv[3];
    if (process.argv.length !== 4 || process.argv[2] !== '--execute-after-plan-push' || !/^[a-f0-9]{40}$/.test(pushedCommit ?? ''))
      throw new Error('REQUIRE_EXECUTE_AFTER_PLAN_PUSH_SHA');
    const root = new URL('../', import.meta.url);
    const selectionPath = 'experiments/temporal-pilot/w0-first-three/selection.json';
    const planBytes = await readFile(new URL(selectionPath, root));
    const plan = JSON.parse(planBytes.toString('utf8')) as Plan;
    const frameBytes = await readFile(new URL('experiments/temporal-pilot/httpx-2024-frame.json', root));
    const frame = JSON.parse(frameBytes.toString('utf8'));
    const earliest = frame.pullRequests.filter((row: { window: string }) => row.window === 'W0')
      .sort((a: { mergedAt: string; number: number }, b: { mergedAt: string; number: number }) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number).slice(0, 3);
    if (hash(frameBytes) !== plan.frameSha256 || JSON.stringify(earliest) !== JSON.stringify(plan.selected) ||
      hash(JSON.stringify(plan)) !== planHash) throw new Error('FROZEN_FRAME_SELECTION_MISMATCH');
    // Local remote-tracking state records the last push/fetch, not current server visibility.
    // No credential fallback or network check is performed by this gate.
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, timeout: 5000,
      maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git(['merge-base', '--is-ancestor', pushedCommit, 'refs/remotes/origin/codex/issue-3-w0-evidence']);
      if (!git(['show', `${pushedCommit}:${selectionPath}`]).equals(planBytes)) throw new Error('PLAN_BYTES_MISMATCH');
    } catch { throw new Error('PLAN_PUSH_NOT_VERIFIED_NETWORK_CAPTURE_DISABLED'); }
    const directory = new URL('experiments/temporal-pilot/w0-first-three/capture-run/', root);
    await mkdir(directory); // Refuse overwriting an earlier run.
    const { summary, packages } = await runW0Capture(plan);
    const quarantine = await mkdtemp(join(tmpdir(), 'flyrewheel-w0-quarantine-'));
    for (const entry of packages) await writeFile(join(quarantine, `${entry.evidence.evidence.pull.number}.json`), JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
    await writeFile(new URL('run.json', directory), JSON.stringify({ ...summary, planPushCommit: pushedCommit,
      pushVerification: 'local_remote_tracking_last_push_or_fetch_not_live_server', quarantine }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: summary.status, captured: packages.length, quarantine }));
    if (summary.status !== 'captured_quarantined') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'W0_CAPTURE_FAILED');
    process.exitCode = 1;
  }
}

import { z } from 'zod';
import { captureGithubPrEvidence, GithubCaptureLimitError, type GithubCaptureBudget } from './github-pr.js';
import { GithubReadError } from './github-pr-diagnostics.js';
import { matchesHistoryFilter } from './github-pr-history.js';
import type { HistoryItem } from './github-pr-history-state.js';
import type { QualEvoStore } from './storage/store.js';

export const HistoryCaptureOptionsSchema = z.object({
  maxPulls: z.number().int().min(1).max(5).default(2),
  maxRequests: z.number().int().min(1).max(200).default(50),
  maxRequestsPerPull: z.number().int().min(1).max(50).default(50),
  timeoutMs: z.number().int().min(1).max(300_000).default(120_000),
  retryFailed: z.boolean().default(false), recoverInterrupted: z.boolean().default(false),
}).strict();

/** Explicit local, serial ingestion. No background worker, queue, model calls, auth, or publication.
 * Only receipts returned by capture in this process appear in freshCaptures. Saved/imported state
 * is always integrity-only; a crash after evidence import may leave an idempotent unlinked record.
 */
export async function captureGithubPrHistoryBatch(store: QualEvoStore, digest: string,
  raw: z.input<typeof HistoryCaptureOptionsSchema> = {}, testing: { fetch?: typeof globalThis.fetch } = {}) {
  const options = HistoryCaptureOptionsSchema.parse(raw);
  let batch = await store.getGithubPrHistoryBatch(digest);
  const interrupted = new Set<number>();
  if (batch.items.some(item => item.status === 'capturing') && !options.recoverInterrupted) throw new Error('History batch has an interrupted or active capture; stop the other operator before explicitly using --recover-interrupted');
  for (const item of batch.items.filter(value => value.status === 'capturing')) {
    interrupted.add(item.number);
    batch = await store.updateGithubPrHistoryItem(digest, batch.revision, { ...item, status: 'failed', failure: 'interrupted' });
  }
  const budget: GithubCaptureBudget = { requestsRemaining: options.maxRequests, deadline: Date.now() + options.timeoutMs };
  const freshCaptures: { number: number; evidenceDigest: string; snapshotDigest: string; receipt: Awaited<ReturnType<typeof captureGithubPrEvidence>>['receipt'] }[] = [];
  let attempted = 0, evidenceBytes = 0;
  let stopReason: 'finished-selection' | 'pull-limit' | 'request-budget' | 'deadline' | 'rate-limited' | 'forbidden-or-rate-limited' | 'evidence-budget' = 'finished-selection';
  for (const number of batch.items.filter(item => item.status === 'pending' || (item.status === 'failed' && (options.retryFailed || interrupted.has(item.number)))).map(item => item.number)) {
    if (attempted >= options.maxPulls) { stopReason = 'pull-limit'; break; }
    if (budget.requestsRemaining <= 0) { stopReason = 'request-budget'; break; }
    if (Date.now() >= budget.deadline) { stopReason = 'deadline'; break; }
    const previous = batch.items.find(item => item.number === number)!;
    const active: HistoryItem = { ...previous, status: 'capturing', attempts: previous.attempts + 1, lastAttemptAt: new Date().toISOString(), failure: null, failureDiagnostic: undefined };
    batch = await store.updateGithubPrHistoryItem(digest, batch.revision, active);
    attempted++;
    let failure: HistoryItem['failure'] = 'capture-failed';
    let captured;
    try {
      captured = await captureGithubPrEvidence({ repository: batch.plan.filter.repository, number,
        maxRequests: Math.min(options.maxRequestsPerPull, budget.requestsRemaining) }, { ...testing, budget });
      if (!matchesHistoryFilter(captured.evidence.pull, batch.plan.filter)) { failure = 'out-of-filter'; throw new Error('Capture no longer matches the discovery filter'); }
      const bytes = Buffer.byteLength(JSON.stringify(captured.evidence));
      if (evidenceBytes + bytes > 12_000_000) { failure = 'evidence-budget'; stopReason = 'evidence-budget'; throw new Error('Batch accepted-evidence byte budget exceeded'); }
      evidenceBytes += bytes;
    } catch (error) {
      const failureDiagnostic = error instanceof GithubReadError ? error.diagnostic : undefined;
      const status = failureDiagnostic?.status;
      if (error instanceof GithubCaptureLimitError) failure = error.reason;
      if (status === 403) { failure = 'forbidden-or-rate-limited'; stopReason = 'forbidden-or-rate-limited'; }
      else if (status === 429) { failure = 'rate-limited'; stopReason = 'rate-limited'; }
      else if (Date.now() >= budget.deadline) { failure = 'deadline'; stopReason = 'deadline'; }
      else if (budget.requestsRemaining <= 0) { failure = 'request-budget'; stopReason = 'request-budget'; }
      batch = await store.updateGithubPrHistoryItem(digest, batch.revision, { ...active, status: 'failed', failure, failureDiagnostic });
      if (stopReason !== 'finished-selection') break;
      continue;
    }
    // Storage/CAS failures deliberately leave capturing. A later explicit recovery may retry;
    // never mark a provider failure for a local database failure or hide concurrent modification.
    const stored = await store.importGithubPrEvidence(captured.evidence);
    batch = await store.updateGithubPrHistoryItem(digest, batch.revision, { ...active, status: 'captured', failure: null,
      evidenceDigest: stored.digest, snapshotDigest: stored.evidence.snapshotDigest });
    freshCaptures.push({ number, evidenceDigest: stored.digest, snapshotDigest: stored.evidence.snapshotDigest, receipt: captured.receipt });
  }
  return { batch, run: { attempted, requests: options.maxRequests - budget.requestsRemaining, stopReason, acceptedEvidenceBytes: evidenceBytes,
    bounds: options, freshCaptures }, receipt: { kind: 'package-integrity-only' as const } };
}

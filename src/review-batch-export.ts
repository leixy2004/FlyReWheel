import { reviewBatchStatus } from './review-batch.js';
import type { QualEvoStore } from './storage/store.js';

/** A descriptive readback, not a new evaluation or a batch execution receipt. */
export async function exportReviewBatch(store: QualEvoStore, digest: string) {
  const status = await reviewBatchStatus(store, digest), rows = [];
  for (const [index, item] of status.items.entries()) {
    const result = item.result;
    const findings = { violation: 0, safe: 0, unknown: 0, not_verified: 0 };
    const review = result?.status === 'completed' && result.outcome?.kind === 'semantic-review'
      ? await store.getSemanticReview(result.outcome.id) : null;
    if (review) for (const finding of review.findings) findings[finding.status]++;
    rows.push({ index: index + 1, jobDigest: item.jobDigest, ruleDigest: item.job.kind === 'semantic-review' ? item.job.ruleDigest : null,
      snapshotDigest: item.job.kind === 'semantic-review' ? item.job.snapshotDigest : null,
      workspaceId: item.job.workspaceId, attempt: item.job.attempt, attempts: item.attempts,
      state: item.state, outcomeStatus: result?.status ?? null, reason: result?.reason ?? null,
      modelExecution: result?.modelExecution ?? (item.state === 'running' ? 'unknown' : 'not_run'),
      cleanup: result?.cleanup ?? (item.state === 'running' ? null : 'not_started'),
      reviewId: review?.id ?? null, findings: review ? findings : null,
      recoveryAction: item.recovery.action, nextAction: item.recovery.nextAction });
  }
  return { schemaVersion: 1, kind: 'review-batch-report', batchDigest: digest, batchId: status.batch.input.id,
    state: status.state, counts: status.counts, rows,
    retrySelection: { retryJobDigests: status.items.filter(item => item.state === 'retryable').map(item => item.jobDigest) },
    retrySelectionMeaning: 'suggested-existing-failures-requires-explicit-operator-selection-no-retry-performed',
    findingCountsMeaning: 'stored-review-declarations-not-ground-truth-or-repair-metrics',
    consistency: 'per-item-readback-not-a-cross-job-transactional-snapshot',
    execution: 'not_started_by_export', notification: 'not_performed', certification: 'none' };
}
export type ReviewBatchReport = Awaited<ReturnType<typeof exportReviewBatch>>;
function cell(value: string | number | null) {
  let text = value === null ? '' : String(value);
  // Quoting handles CSV syntax; a leading apostrophe separately neutralizes
  // spreadsheet formulas if a future exported field accepts free-form content.
  if (/^[\s]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function reviewBatchCsv(report: ReviewBatchReport) {
  const headers = ['batch_digest', 'batch_id', 'item', 'job_digest', 'rule_digest', 'snapshot_digest', 'workspace_id',
    'attempt', 'attempts', 'state', 'outcome_status', 'reason', 'model_execution', 'cleanup', 'review_id',
    'findings_violation', 'findings_safe', 'findings_unknown', 'findings_not_verified', 'recovery_action', 'next_action', 'certification'];
  const rows = report.rows.map(row => [report.batchDigest, report.batchId, row.index, row.jobDigest, row.ruleDigest, row.snapshotDigest,
    row.workspaceId, row.attempt, row.attempts, row.state, row.outcomeStatus, row.reason, row.modelExecution, row.cleanup, row.reviewId,
    row.findings?.violation ?? null, row.findings?.safe ?? null, row.findings?.unknown ?? null, row.findings?.not_verified ?? null,
    row.recoveryAction, row.nextAction, report.certification]);
  return [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

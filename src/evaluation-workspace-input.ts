import { captureChangeSnapshot, type StoredChangeSnapshot } from './change-snapshot.js';
import type { EvaluationWorkspaceBinding } from './workspace/history-policy.js';

/** A binding limits reachable local Git objects only. It does not certify the
 * historical availability, semantic truth, or training provenance of prompt data. */
export function evaluationGenerationContext(evaluation: EvaluationWorkspaceBinding | undefined,
  repositoryId: string, checkoutSha: string) {
  if (evaluation === undefined) return { historyPolicy: 'all-local-refs-v1' as const };
  if (evaluation.repositoryId !== repositoryId || evaluation.checkoutSha !== checkoutSha
    || !evaluation.allowedHeads.includes(checkoutSha)) {
    throw new Error('Evaluation workspace repository/checkout binding does not match the frozen package');
  }
  return { historyPolicy: 'exact-allowed-head-closure-v1' as const, evaluation };
}

/** For evaluation, selected bytes must be reproducible from the derived store.
 * This also rejects unavailable baseTip/mergeBase objects before runtime access. */
export async function recaptureEvaluationSnapshot(snapshot: StoredChangeSnapshot, repositoryPath: string): Promise<void> {
  const frozen = snapshot.snapshot;
  const recaptured = await captureChangeSnapshot({ repositoryPath, repositoryId: frozen.repository.id,
    baseTip: frozen.baseTip, head: frozen.head, limits: frozen.limits,
    ...(frozen.prMetadata ? { prMetadata: frozen.prMetadata } : {}) });
  if (recaptured.digest !== snapshot.digest) throw new Error('Evaluation snapshot does not match exact local Git recapture');
}

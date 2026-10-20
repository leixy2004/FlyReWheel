import { validateGithubPrEvidence, type StoredGithubPrEvidence } from './github-pr-evidence.js';
import { PrMiningRequestInputSchema, type PrMiningRequestInput } from './core/pr-mining.js';
import { derivePrMiningRequest } from './pr-mining.js';
import type { QualEvoStore } from './storage/store.js';
import { z } from 'zod';
import { DigestSchema } from './core/model.js';

const EvidenceSelection = z.union([
  z.object({ evidenceDigest: DigestSchema }).strict(),
  z.object({ batch: DigestSchema, number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
export async function selectMiningEvidence(store: QualEvoStore, input: unknown) {
  const selection = EvidenceSelection.parse(input);
  if ('evidenceDigest' in selection) return store.getGithubPrEvidence(selection.evidenceDigest);
  const batch = await store.getGithubPrHistoryBatch(selection.batch);
  const item = batch.items.find(item => item.number === selection.number);
  if (!item || item.status !== 'captured' || !item.evidenceDigest) throw new Error('Select a captured PR from the exact history batch');
  return store.getGithubPrEvidence(item.evidenceDigest);
}

/** A read-only inventory. Discussion text is untrusted evidence, never instructions or feedback. */
export function miningChoices(stored: StoredGithubPrEvidence) {
  const checked = validateGithubPrEvidence(stored.evidence);
  if (checked.digest !== stored.digest) throw new Error('Mining evidence identity mismatch');
  const { snapshot, pull, discussions } = checked.evidence;
  return { evidenceDigest: checked.digest, snapshotDigest: checked.evidence.snapshotDigest,
    sources: snapshot.changes.flatMap((change, changeIndex) => (['before', 'after'] as const).map(side => {
      const entry = change[side];
      return { changeIndex, side, status: change.status, ...entry, selectable: entry.state === 'captured',
        // Bytes remain in the evidence package, not the selection inventory.
        ...('bytesBase64' in entry ? { bytesBase64: undefined } : {}) };
    })),
    statements: [ { selection: { kind: 'pull' as const }, record: pull },
      ...discussions.issueComments.map(record => ({ selection: { kind: 'issue-comment' as const, id: record.id }, record })),
      ...discussions.reviews.map(record => ({ selection: { kind: 'review' as const, id: record.id }, record })),
      ...discussions.reviewComments.map(record => ({ selection: { kind: 'review-comment' as const, id: record.id }, record })) ],
    trust: { evidence: 'package-integrity-only', statements: 'untrusted-not-ground-truth-or-feedback' },
    preparation: 'not_performed', synthesis: 'not_run' };
}

export function preparePrMiningRequest(stored: StoredGithubPrEvidence,
  options: Omit<PrMiningRequestInput, 'evidenceDigest' | 'sources'> & { sources?: PrMiningRequestInput['sources']; allCaptured?: boolean }) {
  const choices = miningChoices(stored);
  const { allCaptured, sources, ...authored } = options;
  if (allCaptured !== undefined && allCaptured !== true) throw new Error('All captured sides requires an explicit true selection');
  if (allCaptured && sources !== undefined) throw new Error('Choose explicit sources or all captured sides, not both');
  const selected = allCaptured ? choices.sources.flatMap(entry => entry.state === 'captured' ? [{ side: entry.side, path: entry.path }] : []) : sources;
  const input = PrMiningRequestInputSchema.parse({ ...authored, evidenceDigest: choices.evidenceDigest, sources: selected });
  // Reuse the authoritative constructor: exact paths, discussion IDs, budgets,
  // case identities and before/after commit bindings. Nothing is persisted here.
  derivePrMiningRequest(input, stored);
  return input;
}

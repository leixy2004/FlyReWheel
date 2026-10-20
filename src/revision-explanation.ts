import { z } from 'zod';
import type { QualEvoStore } from './storage/store.js';
import { DigestSchema, IdSchema } from './core/model.js';
import { LocalSemanticSelectionInputSchema } from './core/semantic-governance.js';
import { digestOf } from './core/identity.js';

export const RevisionExplanationInputSchema = LocalSemanticSelectionInputSchema.extend({
  comparisonDigest: DigestSchema, feedbackId: IdSchema.optional(),
}).strict();
export type RuleFieldChange = { path: string; operation: 'add' | 'remove' | 'replace'; before?: unknown; after?: unknown };
/** Literal JSON field differences, not inferred semantic improvements. Arrays stay whole. */
export function ruleFieldChanges(before: unknown, after: unknown, path = ''): RuleFieldChange[] {
  if (digestOf(before) === digestOf(after)) return [];
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
    const child = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (!Object.hasOwn(before, key)) return [{ path: child, operation: 'add', after: after[key] } satisfies RuleFieldChange];
    if (!Object.hasOwn(after, key)) return [{ path: child, operation: 'remove', before: before[key] } satisfies RuleFieldChange];
    return ruleFieldChanges(before[key], after[key], child);
  });
  return [{ path, operation: 'replace', before, after }];
}

/** Compose existing validated records. No generation, comparison, decision or selection mutation. */
export async function explainRevision(store: QualEvoStore, raw: z.input<typeof RevisionExplanationInputSchema>) {
  const input = RevisionExplanationInputSchema.parse(raw);
  const stored = await store.getRevisionComparison(input.comparisonDigest), comparison = stored.comparison;
  const request = await store.getRevisionRequest(comparison.input.requestDigest);
  if (input.feedbackId !== undefined && !request.request.feedbackIds.includes(input.feedbackId))
    throw new Error('Selected feedback is not part of this comparison\'s frozen revision request');
  const base = await store.getRuleVersion(comparison.baseRuleDigest);
  const candidate = await store.getRuleVersion(comparison.input.candidateRuleDigest);
  const selectedFeedback = [];
  for (const binding of request.request.feedbackBindings) {
    const feedback = await store.getReviewFeedback(binding.id);
    selectedFeedback.push({ feedback, digest: binding.digest, focused: input.feedbackId === binding.id,
      observations: comparison.feedback.filter(row => row.feedbackId === binding.id),
      links: { feedback: ['feedback', 'show', '--id', binding.id], finding: ['reviews', 'finding', '--id', feedback.findingId] } });
  }
  const decisions = await store.listRevisionDecisions(stored.digest);
  // One existing atomic selection read supplies both current eligibility and its head.
  const selection = await store.selectLocalSemanticRules({ repository: input.repository, paths: input.paths });
  const selected = selection.selected.find(entry => entry.ruleDigest === candidate.digest);
  const excluded = selection.excluded.find(entry => entry.ruleDigest === candidate.digest);
  const current = selected ?? excluded;
  return { schemaVersion: 1, kind: 'rule-revision-explanation',
    comparisonDigest: stored.digest, request, focusFeedbackId: input.feedbackId ?? null,
    versions: { base: { digest: base.digest, ruleId: base.rule.ruleId, version: base.rule.version },
      candidate: { digest: candidate.digest, ruleId: candidate.rule.ruleId, version: candidate.rule.version } },
    changes: ruleFieldChanges(base.rule, candidate.rule), changeInterpretation: 'literal-fields-arrays-as-whole-values-not-semantic-proof',
    selectedFeedback, evaluation: { ...comparison }, decisions,
    localReview: { query: { repository: input.repository, paths: input.paths }, eligible: selected !== undefined,
      status: current?.status ?? 'unregistered', reason: selected ? 'selected-by-current-local-governance' : excluded?.reason ?? 'unregistered',
      governanceHeadDigest: current?.headDigest ?? null, selectionEvidence: current?.selectionEvidence ?? null,
      selectedUsingThisComparison: selected?.selectionEvidence?.kind === 'accepted-local-comparison'
        && selected.selectionEvidence.comparisonDigest === stored.digest,
      scope: 'local-experimental-review-only', execution: 'not_run',
      freshness: 'observed-current-selection-recheck-with-governed-plan-before-execution' },
    links: { base: ['rules', 'show', '--digest', base.digest], candidate: ['rules', 'show', '--digest', candidate.digest],
      comparison: ['revisions', 'comparison', '--digest', stored.digest],
      generationRecords: ['revisions', 'candidates', '--request-digest', request.digest, '--rule-digest', candidate.digest],
      governance: ['rules', 'governance', 'show', '--rule-id', candidate.rule.ruleId],
      governanceHistory: ['rules', 'governance', 'history', '--rule-id', candidate.rule.ruleId] },
    trust: { ...comparison.trust, generation: 'not-established-by-comparison-use-generation-records',
      activation: 'not_performed', identityVerification: 'caller-declared-unverified' },
  };
}

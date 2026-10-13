import type { QualEvoStore } from './storage/store.js';
import type { ReviewFixture } from './core/semantic-review.js';
import { digestOf } from './core/identity.js';
import { GovernedReviewPlanInputSchema, runGovernedReviewPlan, type GovernedReviewPlanInput } from './governed-semantic-review.js';

/** Freeze authored response identities into the existing plan, never into a live job. */
export function bindGovernedOfflineFixtures(raw: GovernedReviewPlanInput, fixtures: ReadonlyMap<string, ReviewFixture>) {
  const input = GovernedReviewPlanInputSchema.parse(raw);
  if (input.evaluationExportId) throw new Error('Offline governed review cannot use evaluation exports');
  const offlineFixtures = [...fixtures].map(([fixtureDigest, fixture]) => {
    if (digestOf(fixture) !== fixtureDigest || fixture.snapshotDigest !== input.snapshotDigest
      || digestOf('repositoryContextDigests' in fixture ? fixture.repositoryContextDigests : []) !== digestOf(input.repositoryContextDigests ?? []))
      throw new Error('Offline fixture must match exact snapshot and context selection');
    return { ruleDigest: fixture.ruleDigest, fixtureDigest };
  }).sort((a, b) => a.ruleDigest.localeCompare(b.ruleDigest));
  if (input.offlineFixtures && digestOf([...input.offlineFixtures].sort((a, b) => a.ruleDigest.localeCompare(b.ruleDigest))) !== digestOf(offlineFixtures))
    throw new Error('Offline fixtures differ from frozen plan bindings');
  return GovernedReviewPlanInputSchema.parse({ ...input, offlineFixtures });
}
export async function runGovernedOfflineReview(store: QualEvoStore, digest: string,
  fixtures: ReadonlyMap<string, ReviewFixture>, signal: AbortSignal) {
  const stored = await store.requireCurrentGovernedReviewPlan(digest);
  if (!stored.plan.input.offlineFixtures) throw new Error('Plan has no offline bindings; create a new plan ID with --offline-fixtures');
  bindGovernedOfflineFixtures(stored.plan.input, fixtures); // All bytes checked before any claim.
  const status = await runGovernedReviewPlan({ store, offlineReviewFixtures: fixtures }, digest, signal);
  return { ...status, executionMode: 'authored-offline-fixtures', modelExecution: 'not_run', workspaceExecution: 'not_run' };
}

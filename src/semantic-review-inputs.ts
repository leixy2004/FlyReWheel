import { RuleVersionSchema, RepositoryIdSchema, RepositoryPathSchema, matchesRuleScope, type SemanticRuleVersion, type StoredRuleVersion } from './core/semantic-rule.js';
import { ruleVersionDigest } from './core/identity.js';
import { validateChangeSnapshot, type StoredChangeSnapshot } from './change-snapshot.js';
import { REVIEW_LIMITS, reviewTargetId, type ReviewTarget } from './core/semantic-review.js';

export const notRun = (): ReviewTarget['semantic'] => ({ state: 'not_run', reasoning: 'No explicit semantic fixture judgment was supplied; structural hits or silence do not establish semantic safety.', missingContext: [] });
export function semanticReviewInputs(ruleInput: StoredRuleVersion, snapshotInput: StoredChangeSnapshot) {
  const rule = RuleVersionSchema.parse(ruleInput.rule);
  if (rule.schemaVersion !== 2) throw new Error('Snapshot review requires a semantic rule schemaVersion 2');
  if (ruleVersionDigest(rule) !== ruleInput.digest) throw new Error('Stored rule digest mismatch');
  const snapshot = validateChangeSnapshot(snapshotInput.snapshot);
  if (snapshot.digest !== snapshotInput.digest) throw new Error('Stored snapshot digest mismatch');
  if ((rule.detectionAssets?.length ?? 0) > REVIEW_LIMITS.assets) throw new Error(`Review exceeds ${REVIEW_LIMITS.assets} detection assets; no partial review was stored`);
  if (rule.semantics.requiredContext.length > 100 || rule.semantics.requiredContext.some(value => value.length > 16_384)) throw new Error('Required-context declaration exceeds bounded review limits');
  return { rule, snapshot };
}
export function makeReviewTargets(rule: SemanticRuleVersion, ruleDigest: string, snapshot: StoredChangeSnapshot): ReviewTarget[] {
  return snapshot.snapshot.changes.map((change, changeIndex) => {
    const side = change.after.state === 'absent' ? change.before : change.after;
    if (side.state === 'absent') throw new Error('Invalid snapshot change has no path');
    const path = side.path, sourceDigest = change.after.state === 'captured' ? change.after.sha256 : null;
    let disposition: ReviewTarget['disposition'] = 'captured', reason: string | null = null;
    if (!RepositoryIdSchema.safeParse(snapshot.snapshot.repository.id).success || !RepositoryPathSchema.safeParse(path).success) {
      disposition = 'unsupported_scope'; reason = 'Snapshot identity/path is outside the current semantic scope representation; it was not normalized or ignored.';
    } else if (!matchesRuleScope(rule.scope, snapshot.snapshot.repository.id, path)) {
      disposition = 'out_of_scope'; reason = 'Exact repository/path selection does not match this rule; semantic applicability was not judged.';
    } else if (change.after.state === 'absent') {
      disposition = 'deleted'; reason = 'No head-side file exists; deletion effects and before-side evidence were not semantically reviewed.';
    } else if (change.after.state === 'excluded') {
      disposition = 'excluded'; reason = `Snapshot after-side bytes are excluded: ${change.after.reason}`;
    }
    return { id: reviewTargetId(ruleDigest, snapshot.digest, changeIndex, path, sourceDigest), changeIndex, path, sourceDigest, disposition, reason, scans: [], semantic: notRun() };
  });
}

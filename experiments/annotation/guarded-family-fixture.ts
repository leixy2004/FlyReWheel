import { digestOf } from '../../src/core/identity.js';
import { gitBlobId, gitSha256 } from '../../src/git-object-evidence.js';
import { validateChangeSnapshot, DEFAULT_SNAPSHOT_LIMITS } from '../../src/change-snapshot.js';
import { makeSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { createMatchedFixture } from '../matched-revision/fixture.js';
import { createAnnotationFixture } from './fixture.js';
import { GuardedFamilySchema, GUARDED_FAMILY_VERSION, GUARDED_RUBRIC } from './guarded-family.js';
import { validatePlan } from './workflow.js';
/** Rebind existing authored matched source inputs to real snapshot packages. */
export function createGuardedFamilyFixture() {
  const matched = createMatchedFixture(), seed = createAnnotationFixture(), plan = structuredClone(seed.plan);
  const rule = matched.packet.episode.revision.baseRule;
  const targets = matched.future.cases.map(c => structuredClone(c.input));
  plan.dataset.families = [{ id: 'fixture-family', ruleIds: [rule.rule.ruleId], definitionDigest: digestOf(GUARDED_RUBRIC), description: 'Authored guarded-operation measurement only' }];
  plan.rubrics = [{ familyId: 'fixture-family', text: GUARDED_RUBRIC, definitionDigest: digestOf(GUARDED_RUBRIC), scope: 'predefined-after-side-opportunities-only' }];
  plan.dataset.prs = targets.map((target, i) => {
    const bytes = Buffer.from(target.source);
    const snapshot = validateChangeSnapshot({ schemaVersion: 1, kind: 'git-change-snapshot',
      repository: matched.packet.episode.revision.snapshots[0].snapshot.repository,
      baseTip: '1'.repeat(40), mergeBase: '1'.repeat(40), head: String(i + 3).repeat(40), comparison: 'merge-base-to-head',
      renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
      changes: [{ status: 'A', before: { state: 'absent' }, after: { state: 'captured', path: target.path, mode: '100644',
        objectId: gitBlobId(bytes), byteLength: bytes.length, sha256: gitSha256(bytes), bytesBase64: bytes.toString('base64') } }],
      coverage: { changedPaths: 1, capturedSides: 1, excludedSides: 0, capturedBytes: bytes.length, scope: 'changed-entries-only' } });
    target.sourceSnapshotDigest = snapshot.digest;
    return { id: target.prId, repository: snapshot.snapshot.repository.id, number: i + 1, split: 'synthetic' as const,
      lineageId: target.lineageId, inclusionProbability: null, checkpointAt: null, checkpointEvidenceDigest: null, snapshot };
  });
  plan.opportunities = targets.map((target, i) => ({ id: target.id, prId: target.prId, familyId: target.familyId,
    issueId: target.id, lineageId: target.lineageId,
    anchors: [makeSnapshotAnchor(plan.dataset.prs[i].snapshot, 'after', target.path, target.issueScope.start, target.issueScope.end)] }));
  plan.sourceBindings = plan.dataset.prs.map(pr => ({ prId: pr.id, snapshotDigest: pr.snapshot.digest,
    capturedAt: plan.observationCutoff, captureEvidenceDigest: digestOf(['authored-source', pr.snapshot.digest]), historicalVisibility: 'not-established' as const }));
  validatePlan(plan);
  const spec = GuardedFamilySchema.parse({ schemaVersion: 1, kind: 'guarded-operation-development-measurement',
    version: GUARDED_FAMILY_VERSION, origin: 'authored-fixture', familyId: 'fixture-family', rule: rule.rule, ruleDigest: rule.digest,
    rubric: GUARDED_RUBRIC, rubricDigest: digestOf(GUARDED_RUBRIC), planDigest: digestOf(plan),
    admission: 'authored-development-only-not-httpx-or-h2', temporalBasis: 'current-capture-declarations-not-historical-proof' });
  return { plan, spec, targets, assignment: seed.assignment };
}

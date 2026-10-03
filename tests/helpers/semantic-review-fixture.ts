import { createHash } from 'node:crypto';
import { validateChangeSnapshot, DEFAULT_SNAPSHOT_LIMITS } from '../../src/change-snapshot.js';
import { ruleVersionDigest } from '../../src/core/identity.js';
import { type SemanticRuleVersion } from '../../src/core/semantic-rule.js';
import { type ProblemCase } from '../../src/core/model.js';

export function capturedSide(path: string, source: string, mode: '100644' | '100755' = '100644') {
  const bytes = Buffer.from(source);
  return { state: 'captured' as const, path, mode,
    objectId: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
}
export function semanticInputs(options: { before?: string; after?: string; path?: string; assets?: SemanticRuleVersion['detectionAssets']; requiredContext?: string[] } = {}) {
  const path = options.path ?? 'src/sample.ts', before = options.before ?? 'function run() { return 0; }\n', after = options.after ?? 'function run() { dangerousRead(); }\n';
  const oldSide = capturedSide(path, before), newSide = capturedSide(path, after, before === after ? '100755' : '100644');
  const snapshot = validateChangeSnapshot({
    schemaVersion: 1, kind: 'git-change-snapshot', repository: { id: 'synthetic:review', identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: '1'.repeat(40), mergeBase: '1'.repeat(40), head: '2'.repeat(40), comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    changes: [{ status: 'M', before: oldSide, after: newSide }],
    coverage: { changedPaths: 1, capturedSides: 2, excludedSides: 0, capturedBytes: oldSide.byteLength + newSide.byteLength, scope: 'changed-entries-only' },
  });
  const problemCase: ProblemCase = { id: 'synthetic-review-source', lineageId: 'synthetic-review-source-lineage', split: 'training', expected: 'unknown', title: 'Synthetic source with no human correctness label', repository: snapshot.snapshot.repository.id, commit: snapshot.snapshot.mergeBase,
    path: 'src/sample.ts', sourceDigest: oldSide.sha256, provenance: { kind: 'synthetic', reference: 'fixture:semantic-review', reviewedBy: null, derivedFromCaseId: null } };
  const rule: SemanticRuleVersion = { schemaVersion: 2, ruleId: 'synthetic-review-rule', version: 'draft-1',
    semantics: { title: 'A dangerous read needs policy context', mechanism: 'Missing authorization can expose data.', invariant: 'Respect the local read policy.', applicability: ['Privileged reads'], exceptions: ['Explicitly public reads'], requiredContext: options.requiredContext ?? ['local-policy'], expectedBehavior: 'Use supplied policy evidence or return Unknown.' },
    scope: { repositories: ['synthetic:review'], paths: { include: ['src'], exclude: ['src/generated'] } },
    ...(options.assets === undefined ? {} : { detectionAssets: options.assets }), regressionCases: [],
    provenance: { sourceCases: [{ caseId: problemCase.id, repository: problemCase.repository, commit: problemCase.commit, path: problemCase.path, sourceDigest: problemCase.sourceDigest }], parentDigest: null, author: 'synthetic-fixture', createdAt: '2026-10-01T00:00:00Z', rationale: 'Explicit synthetic development fixture; no model or human approval.' },
  };
  return { rule: { digest: ruleVersionDigest(rule), rule }, snapshot, problemCase };
}
export const readAsset = { id: 'read', detector: { kind: 'ast-grep' as const, language: 'typescript', pattern: 'dangerousRead()' } };

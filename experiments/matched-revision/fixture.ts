import { createHash } from 'node:crypto';
import { DEFAULT_SNAPSHOT_LIMITS, validateChangeSnapshot } from '../../src/change-snapshot.js';
import { canonicalJson, digestOf, ruleVersionDigest } from '../../src/core/identity.js';
import { ProblemCaseSchema } from '../../src/core/model.js';
import { LocalReviewFeedbackSchema, RevisionRequestSchema, type LegacyReviewFixture } from '../../src/core/semantic-review.js';
import { SemanticRuleVersionSchema } from '../../src/core/semantic-rule.js';
import { buildSemanticReview } from '../../src/semantic-review.js';
import { makeReviewEvidence, makeSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { bytesDigest } from '../../src/workspace/execution-receipt.js';
import { type AuthoredTransport, type FrozenEpisode, type FrozenFuture, type FrozenPacket,
  type ModelRequest, type Proposal, type TargetInput, type TransportResult } from './contracts.js';

/** All text, labels, diagnoses and responses are co-authored mechanics fixtures, not empirical observations. */
export function createMatchedFixture() {
  const date = '2026-10-02T00:00:00Z', repository = 'synthetic:matched-revision';
  const sources = [
    { id: 'source-a', path: 'src/a.ts', source: 'danger(a);\n', expected: 'violation' as const, role: 'positive' as const },
    { id: 'source-b', path: 'src/b.ts', source: 'guard(b); danger(b);\n', expected: 'safe' as const, role: 'negative' as const },
  ];
  const side = (path: string, source: string) => {
    const bytes = Buffer.from(source);
    return { state: 'captured' as const, path, mode: '100644' as const,
      objectId: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      byteLength: bytes.length, sha256: bytesDigest(source), bytesBase64: bytes.toString('base64') };
  };
  const snapshot = validateChangeSnapshot({ schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: repository, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: '1'.repeat(40), mergeBase: '1'.repeat(40), head: '2'.repeat(40), comparison: 'merge-base-to-head',
    renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    changes: sources.map(s => ({ status: 'M', before: side(s.path, '// before\n'), after: side(s.path, s.source) })),
    coverage: { changedPaths: 2, capturedSides: 4, excludedSides: 0,
      capturedBytes: sources.reduce((n, s) => n + Buffer.byteLength('// before\n' + s.source), 0), scope: 'changed-entries-only' } });
  const cases = sources.map(s => ProblemCaseSchema.parse({ id: s.id, lineageId: s.id, split: 'training', expected: s.expected,
    title: 'Authored fixture obligation', repository, commit: snapshot.snapshot.head, path: s.path, sourceDigest: bytesDigest(s.source),
    provenance: { kind: 'synthetic', reference: 'authored-matched-fixture', reviewedBy: null, derivedFromCaseId: null } }));
  const rule = SemanticRuleVersionSchema.parse({ schemaVersion: 2, ruleId: 'fixture-rule', version: 'v0',
    semantics: { title: 'Guarded operations', mechanism: 'Missing applicable guard', invariant: 'An applicable guard protects a danger call',
      applicability: ['Danger calls'], exceptions: [], requiredContext: [], expectedBehavior: 'Identify unguarded calls' },
    scope: { repositories: [repository], paths: { include: ['src'], exclude: [] } }, detectionAssets: [],
    regressionCases: sources.map(s => ({ caseId: s.id, role: s.role })),
    provenance: { sourceCases: [{ caseId: cases[0].id, repository, commit: cases[0].commit, path: cases[0].path, sourceDigest: cases[0].sourceDigest }],
      parentDigest: null, author: 'authored-fixture', createdAt: date, rationale: 'Authored mechanics only' } });
  const baseRule = { digest: ruleVersionDigest(rule), rule };
  const structural = buildSemanticReview({ rule: baseRule, snapshot });
  const evidence = sources.map(s => makeReviewEvidence(snapshot, makeSnapshotAnchor(snapshot, 'after', s.path, 0, s.source.length), 'authored-source'));
  const fixtures: LegacyReviewFixture = { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: baseRule.digest,
    snapshotDigest: snapshot.digest, evidence, judgments: sources.map((s, index) => ({
      targetId: structural.coverage.targets.find(t => t.path === s.path)!.id, decision: 'violation', reasoning: 'Authored original fixture response',
      evidenceRefs: [evidence[index].id], findingAnchors: [evidence[index].anchor],
    })) };
  const review = buildSemanticReview({ rule: baseRule, snapshot, fixtures });
  const finding = review.findings.find(f => f.anchor.path === sources[1].path)!;
  const feedback = LocalReviewFeedbackSchema.parse({ id: 'feedback-b', findingId: finding.id, reviewId: review.id,
    ruleDigest: baseRule.digest, ruleVersion: rule.version, source: 'fixture', actor: 'fixture-author', kind: 'label', label: 'FP',
    reason: 'Authored label for the guarded call', createdAt: date });
  const request = RevisionRequestSchema.parse({ schemaVersion: 1, kind: 'rule-revision-request', status: 'pending', synthesis: 'not_run',
    id: 'fixture-request', baseRuleDigest: baseRule.digest, requestedRuleVersion: 'v1', feedbackIds: [feedback.id],
    feedbackBindings: [{ id: feedback.id, digest: digestOf(feedback) }], requestedChange: 'Assess the supplied feedback', actor: 'fixture-author', source: 'fixture', createdAt: date });
  const target = (id: string, lineageId: string, path: string, source: string): TargetInput => ({ id, prId: `pr-${id}`, familyId: 'fixture-family',
    lineageId, path, source, sourceDigest: bytesDigest(source), sourceSnapshotDigest: id.startsWith('gate-') ? snapshot.digest : digestOf(`authored-${id}`),
    issueScope: { start: 0, end: source.length }, evidence: [{ id: `evidence-${id}`, content: source }], missingEvidence: [] });
  const episode: FrozenEpisode = { schemaVersion: 1, kind: 'matched-revision-frozen-episode', origin: 'authored_fixture',
    id: 'authored-episode', familyId: 'fixture-family', frozenAt: date,
    revision: { request: { digest: digestOf(request), request }, baseRule, cases, feedback: [{ feedback, finding, review }], snapshots: [snapshot],
      candidateId: 'fixture-candidate', candidateCreatedAt: date, context: { kind: 'selected-evidence-no-tools',
        workspace: { repoPath: '/fixture/not-a-checkout', runId: 'fixture', attemptId: 'one' }, snapshotDigest: snapshot.digest } },
    diagnosis: { condition: 'provided', lockedAt: date, diagnoses: [{ feedbackId: feedback.id, category: 'boundary',
      reasoning: 'Authored diagnosis, not a human judgment or inference result', evidenceRefs: [`feedback:${feedback.id}`, `finding:${finding.id}`],
      missingEvidence: [], claim: 'proposal-not-established-fact' }], originalContextStatus: 'decisive_evidence_present', revisionContextStatus: 'sufficient',
      provenance: { origin: 'authored_fixture', sourceRecordDigest: digestOf('authored diagnosis'), description: 'Authored supplied diagnosis for interface testing',
        upstreamModel: null, upstreamCalls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, elapsedMs: 0, rawFailure: null } },
    gate: sources.map((s, i) => ({ input: target(`gate-${i}`, s.id, s.path, s.source), expected: s.expected,
      role: i === 0 ? 'old_positive' : 'feedback', obligationRefs: [`case:${s.id}`, ...(i === 1 ? [`feedback:${feedback.id}`] : [])],
      evidenceRecordDigest: digestOf(`authored-gate-${i}`) })), revisionLineageIds: cases.map(c => c.lineageId),
    visibilityAndMissingness: 'Synthetic fixture. No historical visibility, human labels, or W0/W1/W2 freeze is established.',
    protocolRecordDigest: digestOf('matched-revision-fixture-protocol-v1'),
    settings: { revisionModel: 'authored-no-live-model', reviewerModel: 'authored-no-live-model', sampler: { temperature: 0, seed: 1 },
      armOrder: ['U', 'F', 'M', 'H'], tokenizer: 'fixture-utf8-byte-upper-bound-v1', limits: {
        revisionInputTokens: 100_000, revisionOutputTokens: 20_000, persistentStateTokens: 8_000,
        reviewInputTokens: 100_000, reviewOutputTokens: 20_000, maxCallsPerArm: 3,
        maxInputBytes: 200_000, maxOutputBytes: 100_000, maxInputTokensPerArm: 300_000, maxOutputTokensPerArm: 60_000,
        timeoutMsPerCall: 1000, maxElapsedMsPerArm: 10_000, maxCostMicrosPerArm: 0 } } };
  const future: FrozenFuture = { digest: '', cases: [
    { input: target('target-c', 'later-c', 'src/c.ts', 'danger(c);\n'), label: 'violation', repeatedFeedbackMechanism: false, labelRecordDigest: digestOf('authored-c') },
    { input: target('target-d', 'later-d', 'src/d.ts', 'guard(d); danger(d);\n'), label: 'legal_neighbor', repeatedFeedbackMechanism: true, labelRecordDigest: digestOf('authored-d') },
    { input: target('target-e', 'later-e', 'src/e.ts', 'unknown(e);\n'), label: 'unknown', repeatedFeedbackMechanism: false, labelRecordDigest: digestOf('authored-e') },
  ] };
  future.digest = digestOf(future.cases);
  const packet: FrozenPacket = { digest: digestOf(episode), episode };
  const content = { semantics: { ...rule.semantics, exceptions: ['An explicit applicable guard protects the call'] }, paths: rule.scope.paths, detectionAssets: [] };
  const proposal: Proposal = { action: 'revise', state: { kind: 'structured', content }, replacement: null,
    rationale: 'Authored candidate used equally in both structured arms', missingEvidence: [], nextStep: null,
    evidenceRefs: [`rule:${baseRule.digest}`, `feedback:${feedback.id}`, `finding:${finding.id}`] };
  const initialLesson = canonicalJson({ semantics: rule.semantics, paths: rule.scope.paths, detectionAssets: [] });
  const memoryProposal: Proposal = { ...proposal, state: { kind: 'scoped_memory', initialLesson,
    delta: { operation: 'revise', text: canonicalJson(content) } } };
  const predictions = new Map<string, 'violation' | 'safe' | 'unresolved'>([
    ['gate-0', 'violation'], ['gate-1', 'safe'], ['target-c', 'violation'], ['target-d', 'safe'], ['target-e', 'unresolved'],
  ]);
  const transport: AuthoredTransport = { kind: 'authored-test-no-model', id: 'authored-equal-proposals-and-reviews-v1',
    async execute(request: ModelRequest): Promise<TransportResult> {
      const output = request.stage === 'proposal'
        ? structuredClone(request.prompt.includes('initialLesson is a lossless') ? memoryProposal : proposal)
        : { judgments: (JSON.parse(request.prompt.split('\nINPUT=')[1]) as { targets: TargetInput[] }).targets.map(t => ({
          targetId: t.id, prediction: predictions.get(t.id) ?? 'unresolved',
          reason: predictions.get(t.id) === 'unresolved' ? 'abstained' : 'judgment',
          rationale: 'Prescripted fixture response, identical across arms; no interpretation or inference performed',
          evidenceRefs: [t.evidence[0].id], missingEvidence: [],
        })) };
      return { status: 'completed', output, error: null, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0 } };
    } };
  return { packet, future, transport, proposal, memoryProposal };
}

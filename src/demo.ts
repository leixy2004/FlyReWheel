import { sourceDigest } from './adapters/index.js';
import { type RuleBundle } from './core/index.js';
import { replayDataset, type ReplayDataset } from './pipeline.js';
import { QualEvoStore } from './storage/index.js';

export function demoInputs(): { bundle: RuleBundle; dataset: ReplayDataset } {
  const definitions = [
    { id: 'learning-bug', source: 'async function training() { await waitUntilReady("training"); }', decision: 'violation', expected: 'violation', context: 'Training case: caller and API contract confirm no effective deadline.' },
    { id: 'learning-fix', source: 'async function trainingFixed() { await waitUntilReady("training", { timeoutMs: 1000 }); }', decision: 'safe', expected: 'safe', context: 'The explicit API timeout bounds the wait.' },
    { id: 'new-unbounded', source: 'async function nextJob() { await waitUntilReady("new-job"); }', decision: 'violation', expected: 'violation', context: 'Reviewed caller and API contract: no deadline or cancellation is supplied.' },
    { id: 'new-fixed', source: 'async function fixedJob() { await waitUntilReady("new-job", { timeoutMs: 2000 }); }', decision: 'safe', expected: 'safe', context: 'The explicit API timeout bounds the wait.' },
    { id: 'outer-deadline', source: 'async function boundedJob() { return withDeadline(1000, () => waitUntilReady("bounded-job")); }', decision: 'safe', expected: 'safe', context: 'Reviewed withDeadline contract propagates cancellation and enforces a 1000ms deadline on waitUntilReady.' },
    { id: 'missing-context', source: 'async function opaqueJob() { await waitUntilReady("opaque-job"); }', decision: 'violation', expected: 'unknown', context: null },
  ] as const;
  const dataset: ReplayDataset = { name: 'synthetic-deadline-regressions-v1', samples: definitions.map((d, index) => ({
    problemCase: { id: d.id, lineageId: index < 2 ? 'learning-pair' : `independent-${d.id}`, split: index < 2 ? 'training' : 'validation', expected: d.expected, title: d.id, repository: 'synthetic:deadline-contract', commit: `${index + 1}`.padStart(40, '0'), path: `${d.id}.ts`, sourceDigest: sourceDigest(d.source), provenance: { kind: 'synthetic', reference: `fixture:${d.id}`, reviewedBy: 'synthetic-fixture-author', derivedFromCaseId: index === 1 ? 'learning-bug' : null } },
    source: d.source,
    evidence: d.context ? [{ id: `context:${d.id}`, kind: 'caller-deadline-contract', content: d.context }] : [],
    fixtureDecision: d.decision, fixtureReason: d.context ?? 'Deliberately optimistic fixture is overridden by the missing-evidence gate',
  })) };
  const bundle: RuleBundle = { schemaVersion: 1, ruleId: 'effective-wait-deadline', version: '1', skill: { title: '等待必须受有效截止时间约束', invariant: 'A readiness wait must have an effective local or propagated outer deadline.', applicability: ['Asynchronous readiness waits that may otherwise remain pending'], exceptions: ['A verified outer deadline propagates cancellation to the wait', 'The operation is already bounded by its API contract'], requiredContext: ['caller-deadline-contract'] }, detector: { kind: 'ast-grep', language: 'typescript', pattern: 'waitUntilReady($JOB)' }, regressionCases: [{ caseId: 'learning-bug', role: 'positive' }, { caseId: 'learning-fix', role: 'fixed' }], provenance: { sourceCaseIds: ['learning-bug', 'learning-fix'], parentDigest: null, author: 'synthetic-fixture-author', createdAt: '2026-09-30T00:00:00Z', rationale: 'Explicitly synthetic bug/fix example inspired by the missing-caller-context class of false positives', evidenceRefs: ['fixture:learning-bug', 'fixture:learning-fix'] } };
  return { bundle, dataset };
}

export async function runDemo(store: QualEvoStore) {
  const result = await replayDataset({ store, ...demoInputs(), mode: 'offline_fixture' });
  const candidate = result.observations.find(f => f.candidateState === 'passed')!;
  await store.appendFeedback({ id: `resolve_${candidate.id}`, findingId: candidate.id, bundleDigest: candidate.bundleDigest, ruleVersion: candidate.ruleVersion, actor: 'synthetic-workflow', source: 'system', kind: 'resolve', label: null, reason: 'Demonstrate that resolved does not mean fixed or correct', createdAt: '2026-09-30T00:00:00Z' });
  const record = await store.getFinding(candidate.id);
  return { ...result, feedbackExample: { resolveRecorded: true, groundTruthVerdict: record.verdict, explanation: 'A resolve event alone supplies no correctness label' } };
}

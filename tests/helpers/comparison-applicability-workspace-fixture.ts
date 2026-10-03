import { digestOf } from '../../src/core/identity.js';
import { makeReviewEvidence } from '../../src/adapters/semantic-review-fixture.js';
import { createComparisonApplicabilityWorkspaceModelAdapter } from '../../src/adapters/comparison-applicability-model.js';
import { buildComparisonApplicabilityInput, type ComparisonApplicabilityContext } from '../../src/comparison-applicability.js';
import type { ComparisonApplicabilityModelInput } from '../../src/comparison-applicability-execution.js';
import type { ComparisonApplicabilityWorkspaceWorkerResult } from '../../src/workspace/worker-protocol.js';
import { revisionConfig, revisionGenerationFixture, revisionUsage } from './revision-generation-fixture.js';

/** Real local Git capture; authored output only, with no backend/model/network calls. */
export async function comparisonApplicabilityWorkspaceFixture(withContext = false) {
  const f = await revisionGenerationFixture(undefined, false, withContext);
  try {
    const candidateRule = await f.store.importRuleVersion({ ...f.baseInput, version: 'generated',
      scope: { ...f.baseInput.scope, paths: { include: ['src'], exclude: ['src/safe.ts'] } },
      provenance: { ...f.baseInput.provenance, parentDigest: f.baseRule.digest } });
    const fixtures = withContext ? f.contextFixtures(candidateRule, ['violation', 'safe']) : f.fixtures(candidateRule, ['violation', 'safe']);
    fixtures.judgments = fixtures.judgments.slice(0, 1);
    const candidateReview = await f.store.runSemanticReview({ ruleDigest: candidateRule.digest, snapshotDigest: f.snapshot.digest,
      fixtures, ...f.reviewOptions });
    const comparison: ComparisonApplicabilityContext = { request: f.request, baseRule: f.baseRule, candidateRule,
      pair: { base: f.baseReview, candidate: candidateReview, snapshot: f.snapshot },
      feedback: { feedback: f.feedback, finding: f.finding, review: f.baseReview } };
    const selected = buildComparisonApplicabilityInput(comparison);
    const evidence = makeReviewEvidence(f.snapshot, f.finding.anchor, 'captured-source');
    const value = { bindingDigest: digestOf(selected.binding), decision: 'NOT_APPLICABLE' as const,
      reasoning: 'Authored fixture declares a guarded semantic boundary; not a correctness certification.',
      evidence: [evidence, ...(withContext ? [f.policyEvidence!] : [])],
      evidenceRefs: [evidence.id, ...(withContext ? [f.policyEvidence!.id] : [])], missingContext: [] as string[] };
    const envelope: ComparisonApplicabilityWorkspaceWorkerResult = { protocolVersion: 2, outputContract: 'comparison-applicability-v1', value,
      usage: revisionUsage, sessionId: 'authored-applicability', boundary: 'authored-test-no-isolation',
      processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true } };
    f.runtime.execute = async () => { f.calls.push('execute'); return envelope; };
    const input: ComparisonApplicabilityModelInput = { comparison,
      context: { kind: 'full-repository', checkout: 'after', repository: f.repository, workspace: f.workspace } };
    return { ...f, candidateRule, candidateReview, comparison, selected, input, value, envelope,
      adapter: () => createComparisonApplicabilityWorkspaceModelAdapter(revisionConfig, f.dependency) };
  } catch (error) { await f.cleanup(); throw error; }
}

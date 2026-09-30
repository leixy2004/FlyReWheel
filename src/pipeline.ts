import { z } from 'zod';
import { RuleBundleSchema, ProblemCaseSchema, ExecutionMetadataSchema, digestOf, DEFAULT_PROMOTION_POLICY, type RuleBundle, type Finding, type EvaluationResult } from './core/index.js';
import { QualEvoStore } from './storage/index.js';
import { detectAstGrep, sourceDigest, adjudicateOfflineFixture } from './adapters/index.js';
import type { AdjudicationInput, SemanticOutcome } from './adapters/semantic.js';
import { SemanticEvidenceSchema } from './adapters/semantic.js';
import { CodexExecutionConfigSchema, type CodexExecutionConfig } from './model-runtime.js';

export const AttemptSchema = z.string().trim().min(1).max(200);

export const ReplaySampleSchema = z.object({
  problemCase: ProblemCaseSchema,
  source: z.string().max(1_000_000),
  evidence: z.array(SemanticEvidenceSchema),
  fixtureDecision: z.enum(['violation', 'safe', 'unknown']).optional(),
  fixtureReason: z.string().optional(),
}).strict();
export const ReplayDatasetSchema = z.object({
  name: z.string().min(1),
  samples: z.array(ReplaySampleSchema).min(1).max(1000),
}).strict();
export type ReplayDataset = z.infer<typeof ReplayDatasetSchema>;
export type Adjudicator = (input: AdjudicationInput) => Promise<SemanticOutcome>;

/** Calls receive source and evidence, never the case label or post-fix test expectations. */
export async function replayDataset(options: {
  store: QualEvoStore; bundle: RuleBundle; dataset: ReplayDataset;
  mode: 'offline_fixture' | 'model'; modelConfig?: CodexExecutionConfig; adjudicator?: Adjudicator; attempt?: string;
  signal?: AbortSignal;
}) {
  const { store } = options;
  const checkCancellation = () => { if (options.signal?.aborted) throw new Error('Replay cancelled; unfinished observations remain resumable with the same attempt'); };
  checkCancellation();
  const bundle = RuleBundleSchema.parse(options.bundle);
  const dataset = ReplayDatasetSchema.parse(options.dataset);
  if (options.mode === 'model' && (!options.adjudicator || !options.modelConfig)) throw new Error('Model replay requires an explicit frozen model configuration and adjudicator');
  if (options.mode === 'offline_fixture' && (options.modelConfig || options.adjudicator)) throw new Error('Offline replay cannot carry model configuration or an adjudicator');
  const modelConfig = options.mode === 'model' ? CodexExecutionConfigSchema.parse(options.modelConfig) : null;
  const attempt = AttemptSchema.parse(options.attempt ?? 'initial');
  if (bundle.detector.kind !== 'ast-grep') throw new Error('Replay CLI currently supports the native ast-grep adapter; import Semgrep/OpenGrep JSON through its adapter');
  for (const sample of dataset.samples) {
    checkCancellation();
    if (sourceDigest(sample.source) !== sample.problemCase.sourceDigest) throw new Error(`Source integrity mismatch: ${sample.problemCase.id}`);
    await store.importProblemCase(sample.problemCase);
  }
  const stored = await store.importBundle(bundle);
  const datasetDigest = digestOf(dataset);
  const configDigest = digestOf({ pipeline: 'replay-v2', detectorAdapter: 'ast-grep-v1', scannerVersion: '0.45.3', mode: options.mode, modelConfig, detector: bundle.detector, datasetDigest, attempt });
  const results: EvaluationResult[] = [];
  const observations: Finding[] = [];
  for (const sample of dataset.samples) {
    checkCancellation();
    const c = sample.problemCase;
    const run = await store.createRun({ key: `replay:${digestOf([c.id, stored.digest, configDigest])}`, repository: c.repository, commit: c.commit, bundleDigest: stored.digest, configDigest });
    const existing = await store.listFindings(run.id);
    if (existing.length) {
      observations.push(...existing);
      results.push({ caseId: c.id, runId: run.id, findingId: existing[0]!.id });
      continue;
    }
    // Outside the execution-error catch: cancellation is job control, not a model prediction.
    // The detector is synchronous, so this is also the final cancellation check before a model call.
    checkCancellation();
    const base = { id: `observation_${digestOf([run.id, c.id])}`, runId: run.id, bundleDigest: stored.digest, ruleId: bundle.ruleId, ruleVersion: bundle.version, sourceDigest: c.sourceDigest, evidenceRefs: sample.evidence.map(e => e.id) };
    let finding: Finding;
    let executionMetadata: Finding['executionMetadata'];
    try {
      const candidates = detectAstGrep({ source: sample.source, path: c.path, language: bundle.detector.language, pattern: bundle.detector.pattern, ruleId: bundle.ruleId, ruleVersion: bundle.version, bundleDigest: stored.digest });
      if (!candidates.length) {
        // A coverage observation, never a publishable diagnostic. The path is real; no error location is claimed.
        finding = { ...base, location: { path: c.path, startLine: 1, endLine: 1 }, candidateState: 'not_recalled', execution: { state: 'succeeded', error: null }, adjudication: null };
      } else {
        if (candidates.length !== 1) throw new Error('A replay ProblemCase must select one diagnostic; split multi-match cases rather than silently truncating');
        const candidate = candidates[0]!;
        const input: AdjudicationInput = { candidate, source: sample.source, skill: bundle.skill, evidence: sample.evidence };
        const outcome = options.mode === 'offline_fixture'
          ? adjudicateOfflineFixture(input, { fixtureId: c.id, candidateId: candidate.id, candidateSourceDigest: candidate.sourceDigest, matchedText: candidate.matchedText, decision: sample.fixtureDecision ?? 'unknown', reasoning: sample.fixtureReason ?? 'Offline fixture has no explicit judgment', evidenceRefs: sample.evidence.map(e => e.id) })
          : await options.adjudicator!(input);
        executionMetadata = ExecutionMetadataSchema.parse(outcome.metadata);
        const location = { path: c.path, startLine: candidate.span.start.line, endLine: candidate.span.end.line, startColumn: candidate.span.start.column, endColumn: candidate.span.end.column };
        if (outcome.execution === 'failed' || !outcome.adjudication) {
          finding = { ...base, location, candidateState: 'execution_error', execution: { state: 'failed', error: outcome.error ?? 'Semantic execution failed' }, adjudication: null };
        } else {
          finding = { ...base, location, candidateState: outcome.adjudication.decision === 'violation' ? 'passed' : outcome.adjudication.decision === 'safe' ? 'rejected' : 'abstained', execution: { state: 'succeeded', error: null }, adjudication: outcome.adjudication };
        }
      }
    } catch (error) {
      finding = { ...base, location: { path: c.path, startLine: 1, endLine: 1 }, candidateState: 'execution_error', execution: { state: 'failed', error: error instanceof Error ? error.message : 'Unknown execution failure' }, adjudication: null };
    }
    if (executionMetadata) finding = { ...finding, executionMetadata };
    await store.appendFinding(finding);
    observations.push(finding);
    results.push({ caseId: c.id, runId: run.id, findingId: finding.id });
  }
  checkCancellation();
  const evaluationId = `evaluation_${digestOf([stored.digest, datasetDigest, configDigest])}`;
  await store.createEvaluation({ id: evaluationId, bundleDigest: stored.digest, datasetVersion: datasetDigest, caseIds: dataset.samples.map(s => s.problemCase.id), configDigest, createdAt: bundle.provenance.createdAt }, results);
  return { mode: options.mode, modelIdentity: modelConfig?.model ?? null, modelConfig, attempt, configDigest, bundleDigest: stored.digest, evaluationId, datasetDigest, observations, report: await store.evaluate(evaluationId, DEFAULT_PROMOTION_POLICY), limitations: options.mode === 'offline_fixture' ? ['Semantic decisions are explicit offline fixtures, not live model measurements', 'Synthetic development cases cannot certify production promotion'] : ['Model decisions are predictions, not human labels', 'Historical replay alone does not establish prospective effectiveness'] };
}

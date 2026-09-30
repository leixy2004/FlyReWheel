import { z } from 'zod';
import { AdjudicationSchema, RuleBundleSchema, type Adjudication, type RuleBundle } from '../core/model.js';
import { SpanSchema, sourceDigest, sourcePosition, validateCandidateAnchor, type Candidate } from './candidates.js';

export const SemanticEvidenceSchema = z.object({
  id: z.string().min(1), kind: z.string().min(1), content: z.string().min(1),
  anchor: z.object({ path: z.string().min(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), span: SpanSchema }).strict().optional(),
}).strict();
export type SemanticEvidence = z.infer<typeof SemanticEvidenceSchema>;
export interface AdjudicationInput {
  candidate: Candidate; source: string; skill: RuleBundle['skill']; evidence: SemanticEvidence[];
  additionalSources?: Readonly<Record<string, string>>;
}
export interface SemanticOutcome {
  execution: 'succeeded' | 'failed'; adjudication: Adjudication | null; missingEvidence: string[]; error: string | null;
  metadata: { mode: 'offline_fixture' | 'codex_sdk' | 'openai_compatible'; origin: 'fixture_replay' | 'model' | 'evidence_gate' | 'execution_error'; model: string | null; usage?: { inputTokens: number; outputTokens: number }; sessionId: string | null; costUsd: number | null };
}
export function failedOutcome(mode: SemanticOutcome['metadata']['mode'], error: string, model: string | null = null): SemanticOutcome {
  return { execution: 'failed', adjudication: null, missingEvidence: [], error, metadata: { mode, origin: 'execution_error', model, sessionId: null, costUsd: null } };
}
export function checkAdjudicationInput(input: AdjudicationInput): string[] {
  validateCandidateAnchor(input.candidate, input.source);
  RuleBundleSchema.shape.skill.parse(input.skill);
  const seen = new Set<string>();
  const sources = { ...input.additionalSources, [input.candidate.path]: input.source };
  for (const raw of input.evidence) {
    const evidence = SemanticEvidenceSchema.parse(raw);
    if (seen.has(evidence.id)) throw new Error('Duplicate evidence ID');
    seen.add(evidence.id);
    if (evidence.anchor) {
      const { path, span, sourceDigest: digest } = evidence.anchor;
      const source = sources[path];
      if (source === undefined || sourceDigest(source) !== digest) throw new Error(`Evidence source is missing or stale: ${evidence.id}`);
      if (span.end.offset <= span.start.offset) throw new Error(`Invalid evidence span: ${evidence.id}`);
      for (const side of ['start', 'end'] as const) {
        const position = sourcePosition(source, span[side].offset);
        if (position.line !== span[side].line || position.column !== span[side].column) throw new Error(`Invalid evidence position: ${evidence.id}`);
      }
      if (source.slice(span.start.offset, span.end.offset) !== evidence.content) throw new Error(`Evidence excerpt mismatch: ${evidence.id}`);
    }
  }
  return input.skill.requiredContext.filter(kind => !input.evidence.some(item => item.kind === kind && item.content.trim().length > 0));
}
export function missingEvidenceOutcome(mode: SemanticOutcome['metadata']['mode'], input: AdjudicationInput, missingEvidence: string[], model: string | null = null): SemanticOutcome {
  return { execution: 'succeeded', adjudication: { decision: 'unknown', source: mode === 'offline_fixture' ? 'fixture' : 'agent', reasoning: `Required contextual evidence is missing: ${missingEvidence.join(', ')}`, evidenceRefs: input.evidence.map(item => item.id) }, missingEvidence, error: null, metadata: { mode, origin: 'evidence_gate', model, sessionId: null, costUsd: 0 } };
}

export interface OfflineFixtureVerdict {
  fixtureId: string; candidateSourceDigest: string; matchedText: string;
  /** Exact candidate binding prevents one fixture verdict from being reused at another location/rule. */
  candidateId: string; decision: Adjudication['decision']; reasoning: string; evidenceRefs: string[];
}
/** An explicit replay fixture proves plumbing only. It is never a model evaluation or ground-truth label. */
export function adjudicateOfflineFixture(input: AdjudicationInput, fixture: OfflineFixtureVerdict): SemanticOutcome {
  try {
    const missing = checkAdjudicationInput(input);
    if (missing.length) return missingEvidenceOutcome('offline_fixture', input, missing);
    if (!fixture.fixtureId.trim() || fixture.candidateId !== input.candidate.id || fixture.candidateSourceDigest !== input.candidate.sourceDigest || fixture.matchedText !== input.candidate.matchedText) throw new Error('Offline fixture does not bind to this candidate');
    if (fixture.evidenceRefs.some(ref => !input.evidence.some(item => item.id === ref))) throw new Error('Offline fixture cites unavailable evidence');
    const adjudication = AdjudicationSchema.parse({ decision: fixture.decision, reasoning: fixture.reasoning, evidenceRefs: fixture.evidenceRefs, source: 'fixture' });
    if (adjudication.decision !== 'unknown') {
      if (!adjudication.evidenceRefs.length) throw new Error('A decisive fixture verdict requires cited evidence');
      for (const kind of input.skill.requiredContext) {
        if (!input.evidence.some(item => item.kind === kind && adjudication.evidenceRefs.includes(item.id))) throw new Error(`A decisive fixture verdict must cite required context: ${kind}`);
      }
    }
    return { execution: 'succeeded', adjudication, missingEvidence: [], error: null, metadata: { mode: 'offline_fixture', origin: 'fixture_replay', model: null, sessionId: null, costUsd: 0 } };
  } catch (error) { return failedOutcome('offline_fixture', error instanceof Error ? error.message : 'Fixture replay failed'); }
}

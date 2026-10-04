import { z } from 'zod';
import { digestOf } from '../../src/core/identity.js';
import { DigestSchema } from '../../src/core/model.js';
import { SettingsSchema, type AuthoredTransport, type FrozenPacket, type FrozenFuture } from './contracts.js';
import { commonRevisionBlock, validatePacket } from './validation.js';
import { runMatchedRevision } from './runner.js';
import { renderState } from './prompts.js';

const Time = z.string().datetime({ offset: true });
const Entry = z.object({ inputDigest: DigestSchema, declaredAvailableAt: Time }).strict();
/** Authored declarations bind inputs; they do not authenticate historical visibility. */
export const MatchedEvaluationContractSchema = z.object({
  schemaVersion: z.literal(1), purpose: z.literal('offline-study'), execution: z.literal('authored-only'),
  arms: z.tuple([z.literal('F'), z.literal('U'), z.literal('H'), z.literal('M')]),
  implementationBaseCommit: z.literal('90432743d2a8ff316aecf862e42c0613d35ff9a6'),
  researchDesign: z.literal('7eb922bf91e4c5ee0fd1f51088ff6d2348597bec'),
  packetDigest: DigestSchema, futureDigest: DigestSchema, settings: SettingsSchema,
  temporal: z.object({ basis: z.literal('authored-declarations-not-historical-proof'),
    revisionCutoff: Time, futureWindowStart: Time }).strict(),
  inputs: z.object({ revision: Entry, gate: z.array(Entry).min(1).max(100),
    futureReview: z.array(Entry).min(1).max(100), scoringLabelsDigest: DigestSchema }).strict(),
  accounting: z.literal('existing-authored-ledger-declared-usage-not-provider-billing'),
}).strict();
export type MatchedEvaluationContract = z.infer<typeof MatchedEvaluationContractSchema>;
export interface FrozenEvaluationContract { digest: string; value: MatchedEvaluationContract }

function inputBindings(packet: FrozenPacket, future: FrozenFuture) {
  const { episode, cases, prepared } = validatePacket(packet, future);
  return { revision: digestOf(commonRevisionBlock(episode, prepared)),
    gate: episode.gate.map(g => digestOf(g.input)), futureReview: cases.map(c => digestOf(c.input)),
    scoringLabelsDigest: digestOf(cases.map(({ input, ...labels }) => ({ targetId: input.id, ...labels }))) };
}
export function freezeAuthoredEvaluationContract(packet: FrozenPacket, future: FrozenFuture,
  temporal: MatchedEvaluationContract['temporal']): FrozenEvaluationContract {
  const bound = inputBindings(packet, future);
  const value = MatchedEvaluationContractSchema.parse({ schemaVersion: 1, purpose: 'offline-study', execution: 'authored-only',
    arms: ['F', 'U', 'H', 'M'], implementationBaseCommit: '90432743d2a8ff316aecf862e42c0613d35ff9a6',
    researchDesign: '7eb922bf91e4c5ee0fd1f51088ff6d2348597bec', packetDigest: packet.digest, futureDigest: future.digest,
    settings: packet.episode.settings, temporal,
    inputs: { revision: { inputDigest: bound.revision, declaredAvailableAt: temporal.revisionCutoff },
      gate: bound.gate.map(inputDigest => ({ inputDigest, declaredAvailableAt: temporal.revisionCutoff })),
      futureReview: bound.futureReview.map(inputDigest => ({ inputDigest, declaredAvailableAt: temporal.futureWindowStart })),
      scoringLabelsDigest: bound.scoringLabelsDigest }, accounting: 'existing-authored-ledger-declared-usage-not-provider-billing' });
  const frozen = { digest: digestOf(value), value };
  validateEvaluationContract(frozen, packet, future);
  return frozen;
}
export function validateEvaluationContract(raw: FrozenEvaluationContract, packet: FrozenPacket, future: FrozenFuture) {
  const c = MatchedEvaluationContractSchema.parse(raw.value);
  if (digestOf(c) !== raw.digest || packet.digest !== c.packetDigest || future.digest !== c.futureDigest
    || digestOf(packet.episode.settings) !== digestOf(c.settings)) throw new Error('Frozen evaluation contract/input/settings mismatch');
  const cutoff = Date.parse(c.temporal.revisionCutoff), start = Date.parse(c.temporal.futureWindowStart);
  if (!(cutoff < start) || Date.parse(packet.episode.frozenAt) > cutoff
    || [c.inputs.revision, ...c.inputs.gate].some(e => Date.parse(e.declaredAvailableAt) > cutoff)
    || c.inputs.futureReview.some(e => Date.parse(e.declaredAvailableAt) < start)) throw new Error('Authored temporal admission failed');
  const b = inputBindings(packet, future);
  if (b.revision !== c.inputs.revision.inputDigest || b.scoringLabelsDigest !== c.inputs.scoringLabelsDigest
    || digestOf(b.gate) !== digestOf(c.inputs.gate.map(e => e.inputDigest))
    || digestOf(b.futureReview) !== digestOf(c.inputs.futureReview.map(e => e.inputDigest))) throw new Error('Exact stage input allowlist mismatch');
  return c;
}

/** Thin admission/reporting wrapper over the existing runner, not a new backend. */
export async function runContractedEvaluation(input: { mode: 'authored_fixture' | 'production';
  contract: FrozenEvaluationContract; packet: FrozenPacket; future: FrozenFuture; transport?: AuthoredTransport }) {
  if (input.mode === 'production') return { execution: 'not_run' as const, modelExecution: 'not_run' as const,
    reason: 'production_adapter_unconfigured', arms: [], prerequisites: REAL_EXPERIMENT_PREREQUISITES };
  // Clone admitted inputs so caller mutation during an await cannot change this run.
  const packet = structuredClone(input.packet), future = structuredClone(input.future);
  const contract = validateEvaluationContract(structuredClone(input.contract), packet, future);
  const report = await runMatchedRevision({ mode: input.mode, packet, future, transport: input.transport });
  if (report.execution !== 'completed') return report;
  return { execution: 'completed' as const, modelExecution: 'not_run' as const, contractDigest: digestOf(contract),
    scientificConclusion: 'not_estimated-authored-mechanics-only' as const,
    comparisons: report.pairedDifferences,
    arms: report.arms.map(a => ({ arm: a.arm, persistentBytes: Buffer.byteLength(renderState(a.effectiveState)),
      commonInputDigest: a.commonRevisionInputDigest, sharedDiagnosisDigest: a.sharedDiagnosisDigest,
      metrics: a.metrics, usage: a.usage, requests: a.calls.map(c => ({ stage: c.stage,
        requestDigest: c.requestDigest, status: c.status, invoked: c.invoked })) })),
    report, prerequisites: REAL_EXPERIMENT_PREREQUISITES };
}
export const REAL_EXPERIMENT_PREREQUISITES = [
  'Configured and authorized real reviewer/revision adapters; no authored callback promotion or service fallback',
  'Real rule family, locked W0/W1 feedback and diagnoses, two independent human references and adjudication',
  'Independent W2 legal-mechanism and positive opportunities; preserve Unknown, zero-yield and failed cases',
  'Verified experimental exposure isolation and lineage audit; historical as-of visibility proof only if that optional claim is made',
  'Provider-aware tokenizer, admission/settlement and complete construction/retrieval/diagnosis/review billing',
  'Frozen H-U and H-M margins/uncertainty, L_mech strict resolution, family/episode aggregation and M competence',
  'Task adapters for external baselines; local M and U are adaptations, not ACE/Self-Refine reproductions',
] as const;

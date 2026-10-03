import { z } from 'zod';
import { canonicalJson, digestOf } from '../../src/core/identity.js';
import { DigestSchema, IdSchema } from '../../src/core/model.js';
import { freeze } from '../../src/workspace/execution-receipt.js';
import { ARMS, type FrozenFuture, type FrozenPacket } from './contracts.js';
import { SDK_NATIVE_PROFILE_VERSION, type SdkNativeConfiguration } from './sdk-native-contracts.js';
import { validateSdkNativeConfiguration } from './sdk-native-validation.js';
import { validatePacket } from './validation.js';

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Condition = z.enum(['provided', 'inferred']);
export const SDK_NATIVE_SCHEDULE_ALGORITHM = 'sha256-williams-paired-block-v1';
// Versioned algorithm specification, not an executable/runtime attestation.
export const SDK_NATIVE_SCHEDULE_ALGORITHM_DIGEST = digestOf({
  algorithm: SDK_NATIVE_SCHEDULE_ALGORITHM,
  canonicalization: 'canonical-json-utf8-v1',
  shuffle: 'ascending SHA256([seed, domain, value]); ties by canonical JSON code-unit order',
  groups: 'hash-sort episode/repetition pairs; keep diagnosis conditions adjacent',
  conditions: 'seeded permutation per episode/two-repeat cycle; rotate by repetition offset',
  arms: 'seeded labels and row permutation per episode/condition/four-repeat cycle',
  williamsRows: [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]],
  targets: 'hash-sort target IDs independently per block; identical order for every arm',
});
const TargetSchema = z.object({ targetId: IdSchema, prId: IdSchema, familyId: IdSchema,
  lineageId: IdSchema, caseDigest: DigestSchema }).strict();
const SourceSchema = z.object({ episodeId: IdSchema, familyId: IdSchema, condition: Condition,
  repetition: Count.min(1), packetDigest: DigestSchema, futureDigest: DigestSchema,
  episodeInputDigest: DigestSchema, diagnosisDigest: DigestSchema, diagnosisSourceRecordDigest: DigestSchema,
  diagnosisExecution: z.literal('pending-authored-sdk').optional(),
  gateDigest: DigestSchema, targets: z.array(TargetSchema).min(1).max(100) }).strict();
const BlockSchema = z.object({ blockId: DigestSchema, episodeId: IdSchema, condition: Condition,
  repetition: Count.min(1), sourceDigest: DigestSchema,
  armOrder: z.array(z.enum(ARMS)).length(4), futureTargetOrder: z.array(IdSchema).min(1).max(100) }).strict();
const BodySchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('matched-revision-sdk-native-schedule'),
  profileVersion: z.literal(SDK_NATIVE_PROFILE_VERSION), algorithm: z.literal(SDK_NATIVE_SCHEDULE_ALGORITHM),
  algorithmDigest: z.literal(SDK_NATIVE_SCHEDULE_ALGORITHM_DIGEST), schedulingSeed: Count,
  seedPurpose: z.literal('assignment_and_order_only'), repetitions: Count.min(1).max(1000),
  conditions: z.array(Condition).min(1).max(2),
  sources: z.array(SourceSchema).min(1).max(10_000), blocks: z.array(BlockSchema).min(1).max(10_000),
  counting: z.object({ proposalSlotsPerUpdatingArm: z.literal(1), gateSlotsPerArm: z.literal(1),
    futureSlotsPerArm: z.literal(1), retries: z.literal(0), freshThreadPerCall: z.literal(true),
    outputCacheReuse: z.literal(false), repeatedEpisodesAreIndependent: z.literal(false),
    missingBlocks: z.literal('retain-planned-roster-no-replacement'),
    diagnosis: z.enum(['supplied-locked-records-only-no-diagnosis-execution', 'authored-sdk-once-per-inferred-block']) }).strict(),
}).strict();
export const SdkNativeScheduleSchema = BodySchema.extend({ digest: DigestSchema }).strict();
export type SdkNativeSchedule = z.infer<typeof SdkNativeScheduleSchema>;
export type SdkNativeScheduledBlock = z.infer<typeof BlockSchema>;
type Source = z.infer<typeof SourceSchema>;
type Condition = z.infer<typeof Condition>;
export interface SdkNativeScheduleInput { packet: FrozenPacket; future: FrozenFuture; repetition: number }

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sourceKey = (source: Pick<Source, 'episodeId' | 'condition' | 'repetition'>) => canonicalJson([source.episodeId, source.condition, source.repetition]);
function shuffled<T>(values: readonly T[], seed: number, domain: unknown): T[] {
  return values.map(value => ({ value, hash: digestOf([seed, domain, value]), key: canonicalJson(value) }))
    .sort((a, b) => compare(a.hash, b.hash) || compare(a.key, b.key)).map(row => row.value);
}
function sourceOf(input: SdkNativeScheduleInput): Source {
  // These are packet provenance checks, not native budget admission. A minimal
  // native limit object avoids reviving legacy token/sampler enforcement.
  const { episode, cases } = validatePacket(input.packet, input.future, {
    renderedPersistentStateBytes: 1, model: 'schedule-only-no-model', maxOutputBytes: 1_000_000, timeoutMs: 1000 });
  const { diagnosis, settings, ...common } = episode;
  const { armOrder: _legacyArmOrder, ...legacySettings } = settings;
  return SourceSchema.parse({ episodeId: episode.id, familyId: episode.familyId, condition: diagnosis.condition,
    repetition: input.repetition, packetDigest: input.packet.digest, futureDigest: input.future.digest,
    episodeInputDigest: digestOf({ ...common, settings: legacySettings }), diagnosisDigest: digestOf(diagnosis),
    diagnosisSourceRecordDigest: diagnosis.provenance.sourceRecordDigest,
    ...(diagnosis.provenance.origin === 'authored_sdk_diagnosis_pending' ? { diagnosisExecution: 'pending-authored-sdk' } : {}),
    gateDigest: digestOf(episode.gate),
    targets: cases.map(c => ({ targetId: c.input.id, prId: c.input.prId, familyId: c.input.familyId,
      lineageId: c.input.lineageId, caseDigest: digestOf(c) })) });
}
function canonicalSources(sources: Source[], repetitions: number, conditions: Condition[], diagnosis: SdkNativeSchedule['counting']['diagnosis']) {
  const sorted = [...sources].sort((a, b) => compare(sourceKey(a), sourceKey(b)));
  const expectedConditions = (['provided', 'inferred'] as const).filter(c => conditions.includes(c));
  if (digestOf(conditions) !== digestOf(expectedConditions)) throw new Error('Schedule conditions must be unique and canonical');
  if (new Set(sorted.map(sourceKey)).size !== sorted.length) throw new Error('Duplicate episode/condition/repetition in schedule');
  const episodes = [...new Set(sorted.map(s => s.episodeId))];
  if (episodes.length * repetitions * conditions.length !== sorted.length) throw new Error('Schedule must freeze the complete episode/condition/repetition roster');
  for (const source of sorted) {
    const planned = diagnosis === 'authored-sdk-once-per-inferred-block' && source.condition === 'inferred';
    if (planned !== (source.diagnosisExecution === 'pending-authored-sdk')) {
      throw new Error('Diagnosis schedule mode requires matching unexecuted authored slots, never supplied inference outputs');
    }
  }
  for (const episodeId of episodes) {
    const rows = sorted.filter(s => s.episodeId === episodeId), base = rows[0];
    const provided = rows.filter(s => s.condition === 'provided');
    const inferred = rows.filter(s => s.condition === 'inferred');
    if (new Set(provided.map(s => s.diagnosisDigest)).size > 1) throw new Error('Provided diagnosis must stay locked across repetitions');
    if (new Set(inferred.map(s => s.diagnosisSourceRecordDigest)).size !== inferred.length) {
      throw new Error('Each inferred repetition needs its own supplied diagnosis-attempt identity; no reused inference');
    }
    for (const row of rows) {
      if (row.repetition > repetitions || !conditions.includes(row.condition)) throw new Error('Source is outside the declared schedule');
      if (row.familyId !== base.familyId || row.episodeInputDigest !== base.episodeInputDigest || row.gateDigest !== base.gateDigest
        || row.futureDigest !== base.futureDigest || digestOf(row.targets) !== digestOf(base.targets)) {
        throw new Error('An episode must retain the same incumbent, inputs, gate and labeled future roster across conditions/repetitions');
      }
      if (new Set(row.targets.map(t => t.targetId)).size !== row.targets.length || row.targets.some(t => t.familyId !== row.familyId)) {
        throw new Error('Duplicate or mismatched scheduled target identity');
      }
    }
  }
  return sorted;
}
function deriveBlocks(sources: Source[], seed: number, repetitions: number, conditions: Condition[]): SdkNativeScheduledBlock[] {
  const groups = [...new Set(sources.map(s => s.episodeId))].flatMap(episodeId =>
    Array.from({ length: repetitions }, (_, i) => ({ episodeId, repetition: i + 1 })));
  const byKey = new Map(sources.map(s => [sourceKey(s), s]));
  const rows = [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]];
  return shuffled(groups, seed, 'block-groups').flatMap(({ episodeId, repetition }) => {
    const order = shuffled(conditions, seed, ['conditions', episodeId, Math.floor((repetition - 1) / conditions.length)]);
    const offset = (repetition - 1) % conditions.length;
    return [...order.slice(offset), ...order.slice(0, offset)].map(condition => {
      const source = byKey.get(sourceKey({ episodeId, condition, repetition }));
      if (!source) throw new Error('Schedule is missing a planned condition/repetition');
      const sourceDigest = digestOf(source);
      const blockId = digestOf([SDK_NATIVE_SCHEDULE_ALGORITHM, seed, sourceDigest]);
      const domain = [episodeId, condition, Math.floor((repetition - 1) / 4)];
      const labels = shuffled(ARMS, seed, ['arm-labels', domain]);
      const row = shuffled(rows, seed, ['arm-rows', domain])[(repetition - 1) % 4];
      return { blockId, episodeId, condition, repetition, sourceDigest, armOrder: row.map(index => labels[index]),
        futureTargetOrder: shuffled(source.targets.map(t => t.targetId), seed, ['targets', blockId]) };
    });
  });
}

/** Deterministic local assignment only. Call before any authored outputs; this
 * manifest is not a study preregistration, inference permission or runtime proof. */
export function createSdkNativeSchedule(input: { schedulingSeed: number; repetitions: number;
  conditions: Condition[]; blocks: SdkNativeScheduleInput[];
  diagnosis?: SdkNativeSchedule['counting']['diagnosis'] }): SdkNativeSchedule {
  const seed = Count.parse(input.schedulingSeed), repetitions = Count.min(1).max(1000).parse(input.repetitions);
  const conditions = z.array(Condition).min(1).max(2).parse(input.conditions);
  const diagnosis = input.diagnosis ?? 'supplied-locked-records-only-no-diagnosis-execution';
  const sources = canonicalSources(z.array(SourceSchema).min(1).max(10_000).parse(input.blocks.map(sourceOf)), repetitions, conditions, diagnosis);
  const body = BodySchema.parse({ schemaVersion: 1, kind: 'matched-revision-sdk-native-schedule',
    profileVersion: SDK_NATIVE_PROFILE_VERSION, algorithm: SDK_NATIVE_SCHEDULE_ALGORITHM,
    algorithmDigest: SDK_NATIVE_SCHEDULE_ALGORITHM_DIGEST, schedulingSeed: seed, seedPurpose: 'assignment_and_order_only',
    repetitions, conditions, sources, blocks: deriveBlocks(sources, seed, repetitions, conditions),
    counting: { proposalSlotsPerUpdatingArm: 1, gateSlotsPerArm: 1, futureSlotsPerArm: 1, retries: 0,
      freshThreadPerCall: true, outputCacheReuse: false, repeatedEpisodesAreIndependent: false,
      missingBlocks: 'retain-planned-roster-no-replacement', diagnosis } });
  return freeze({ ...body, digest: digestOf(body) });
}
function schedulingOf(schedule: SdkNativeSchedule): SdkNativeConfiguration['scheduling'] {
  return { schedulingSeed: schedule.schedulingSeed, seedPurpose: schedule.seedPurpose, repetitions: schedule.repetitions,
    algorithm: schedule.algorithm, algorithmDigest: schedule.algorithmDigest,
    blockRosterDigest: digestOf({ conditions: schedule.conditions, sources: schedule.sources,
      blocks: schedule.blocks.map(({ futureTargetOrder: _targets, ...block }) => block), counting: schedule.counting }),
    targetScheduleDigest: digestOf(schedule.blocks.map(({ blockId, futureTargetOrder }) => ({ blockId, futureTargetOrder }))) };
}
export function validateSdkNativeSchedule(raw: unknown, configuration?: SdkNativeConfiguration): SdkNativeSchedule {
  canonicalJson(raw);
  const schedule = SdkNativeScheduleSchema.parse(raw), { digest, ...body } = schedule;
  if (digestOf(body) !== digest) throw new Error('Frozen native schedule digest mismatch');
  const sources = canonicalSources(schedule.sources, schedule.repetitions, schedule.conditions, schedule.counting.diagnosis);
  if (digestOf(sources) !== digestOf(schedule.sources)
    || digestOf(deriveBlocks(sources, schedule.schedulingSeed, schedule.repetitions, schedule.conditions)) !== digestOf(schedule.blocks)) {
    throw new Error('Schedule order/identity differs from the frozen algorithm');
  }
  if (configuration && digestOf(validateSdkNativeConfiguration(configuration).scheduling) !== digestOf(schedulingOf(schedule))) {
    throw new Error('Native configuration does not bind this schedule roster/target order');
  }
  return freeze(schedule);
}
export function bindSdkNativeScheduleConfiguration(configuration: SdkNativeConfiguration, raw: SdkNativeSchedule) {
  const schedule = validateSdkNativeSchedule(raw), config = validateSdkNativeConfiguration(configuration);
  return validateSdkNativeConfiguration({ ...config, scheduling: schedulingOf(schedule) });
}
/** Verify supplied immutable identities before selecting an execution order. */
export function validateSdkNativeScheduledInput(schedule: SdkNativeSchedule, blockId: string, input: SdkNativeScheduleInput) {
  const block = schedule.blocks.find(b => b.blockId === blockId);
  if (!block || digestOf(sourceOf(input)) !== block.sourceDigest) throw new Error('Scheduled block packet/future/diagnosis/repetition identity mismatch');
  return block;
}

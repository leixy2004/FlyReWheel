import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digestOf } from '../core/identity.js';
import { NativeEvaluationContextSchema, MatchedDiagnosisSchema } from '../core/matched-revision-model.js';
import { DigestSchema } from '../core/model.js';
import { freeze } from '../workspace/execution-receipt.js';
import type { Database, Queryable } from './database.js';
import { migrateDatabase, inspectDatabaseMigrations } from './migrations.js';

export interface MatchedStudyManifest { schemaVersion: 1; kind: 'authored-matched-study-recovery';
  scheduleDigest: string; configurationDigest: string; blockIds: string[]; input: unknown }
export interface MatchedStudyClaim { studyDigest: string; owner: string; fence: number; leaseMs: number }
export interface MatchedStudyEvent { blockId: string; key: string; fence: number; payload: unknown; digest: string }
type Row = Record<string, unknown> & { study_digest: string; manifest: MatchedStudyManifest; manifest_digest: string;
  state: 'running' | 'finished'; owner: string | null; fence: number; lease_valid: boolean; lease_expires_at: Date | null;
  result: unknown; result_digest: string | null };
const BlockBinding = z.object({ blockId: DigestSchema, repetition: z.number().int().positive(), episodeId: z.string(),
  armOrder: z.array(z.enum(['F','U','H','M'])), futureTargetOrder: z.array(z.string()) }).passthrough();
const ManifestInput = z.object({ schedule: z.object({ digest: DigestSchema, blocks: z.array(BlockBinding) }).passthrough(),
  evaluation: NativeEvaluationContextSchema.optional(), configuration: z.unknown(), blocks: z.array(z.unknown()) }).strict();
const ObjectPayload = z.record(z.string(), z.unknown());
function lockedDigest(value: unknown) {
  const record = ObjectPayload.parse(value), { digest, ...body } = record;
  if (digest !== digestOf(body)) fail('STUDY_INTEGRITY', 'Checkpoint report digest mismatch');
  return record;
}
function bindings(manifest: MatchedStudyManifest) {
  const input = ManifestInput.parse(manifest.input);
  if (input.schedule.digest !== manifest.scheduleDigest || digestOf(input.configuration) !== manifest.configurationDigest
    || digestOf(input.schedule.blocks.map(b => b.blockId)) !== digestOf(manifest.blockIds)
    || input.blocks.length !== manifest.blockIds.length) fail('STUDY_INTEGRITY', 'Manifest schedule/configuration/input binding mismatch');
  lockedDigest(input.schedule);
  return input;
}
function blockResult(manifest: MatchedStudyManifest, blockId: string, raw: unknown) {
  const input = bindings(manifest), block = input.schedule.blocks.find(b => b.blockId === blockId)!;
  const result = ObjectPayload.parse(raw);
  if (result.blockId !== blockId || result.episodeId !== block.episodeId || result.repetition !== block.repetition
    || digestOf(result.plannedArmOrder) !== digestOf(block.armOrder)
    || digestOf(result.plannedFutureTargetOrder) !== digestOf(block.futureTargetOrder)
    || !['completed','failed','missing'].includes(String(result.status))) fail('STUDY_INTEGRITY', 'Block result differs from the frozen roster');
  const roster = z.array(z.object({ arm: z.string(), future: z.array(z.object({ targetId: z.string() }).passthrough()) }).passthrough()).parse(result.roster);
  if (digestOf(roster.map(r => r.arm)) !== digestOf(block.armOrder)
    || roster.some(r => digestOf(r.future.map(t => t.targetId)) !== digestOf(block.futureTargetOrder)))
    fail('STUDY_INTEGRITY', 'Block result omits or reorders planned targets');
  if (result.report !== null) {
    const report = lockedDigest(result.report), index = manifest.blockIds.indexOf(blockId);
    const supplied = z.object({ packet: z.object({ digest: DigestSchema }).passthrough(),
      future: z.object({ digest: DigestSchema }).passthrough() }).passthrough().parse(input.blocks[index]);
    const native = ObjectPayload.parse(report.nativeProfile);
    if (report.packetDigest !== supplied.packet.digest || report.futureDigest !== supplied.future.digest
      || native.scheduleDigest !== manifest.scheduleDigest || native.configurationDigest !== manifest.configurationDigest
      || digestOf(native.configuration) !== manifest.configurationDigest || native.blockId !== blockId) fail('STUDY_INTEGRITY', 'Block report source identity mismatch');
  }
  return result;
}
export class MatchedStudyError extends Error {
  constructor(public readonly code: 'STUDY_FENCED' | 'STUDY_CONFLICT' | 'STUDY_INTEGRITY', message: string) { super(message); }
}
function fail(code: MatchedStudyError['code'], message: string): never { throw new MatchedStudyError(code, message); }
export function matchedStudyDigest(manifest: MatchedStudyManifest): string {
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'authored-matched-study-recovery'
    || !Array.isArray(manifest.blockIds) || !manifest.blockIds.length
    || new Set(manifest.blockIds).size !== manifest.blockIds.length) fail('STUDY_INTEGRITY', 'Invalid frozen study manifest');
  [manifest.scheduleDigest, manifest.configurationDigest, ...manifest.blockIds].forEach(d => DigestSchema.parse(d));
  digestOf(manifest); const input = bindings(manifest);
  return digestOf([manifest.kind, manifest.scheduleDigest, manifest.configurationDigest,
    ...(input.evaluation === undefined ? [] : [digestOf(input.evaluation)])]);
}

/** SQL transactions and row fencing, like application jobs. No broker, filesystem
 * locks, automatic call retries, external connections, or runtime capabilities. */
export class MatchedStudyStore {
  private constructor(private readonly db: Database) {}
  static async initialize(db: Database): Promise<MatchedStudyStore> {
    await migrateDatabase(db); return new MatchedStudyStore(db);
  }
  /** Status must not create tables or advance migration history. */
  static async openExisting(db: Database): Promise<MatchedStudyStore> {
    const inspection = await inspectDatabaseMigrations(db);
    if (inspection.state !== 'versioned' || !inspection.applied.includes('015_matched_studies'))
      fail('STUDY_INTEGRITY', 'Study recovery schema is not initialized; run the explicit database migration command first');
    return new MatchedStudyStore(db);
  }
  private async read(tx: Queryable, studyDigest: string, lock: boolean | 'share' = false): Promise<Row | null> {
    DigestSchema.parse(studyDigest);
    const row = (await tx.query<Row>(`SELECT *, COALESCE(lease_expires_at > clock_timestamp(),false) AS lease_valid
      FROM qe_matched_studies WHERE study_digest=$1${lock === 'share' ? ' FOR SHARE' : lock ? ' FOR UPDATE' : ''}`, [studyDigest])).rows[0];
    if (!row) return null;
    if (row.study_digest !== matchedStudyDigest(row.manifest) || row.manifest_digest !== digestOf(row.manifest)
      || (row.state === 'finished' ? row.result_digest !== digestOf(row.result) : row.result !== null))
      fail('STUDY_INTEGRITY', 'Stored study manifest or result digest mismatch');
    if (row.state === 'finished') await this.validateResult(tx, row, row.result);
    return row;
  }
  private async validateResult(tx: Queryable, row: Row, raw: unknown) {
    const result = lockedDigest(raw);
    const recovery = ObjectPayload.parse(result.recovery);
    if (digestOf(result.evaluation ?? null) !== digestOf(bindings(row.manifest).evaluation ?? null))
      fail('STUDY_INTEGRITY', 'Final report evaluation context mismatch');
    if (result.scheduleDigest !== row.manifest.scheduleDigest || result.configurationDigest !== row.manifest.configurationDigest
      || recovery.studyDigest !== row.study_digest || result.kind !== 'matched-revision-sdk-native-authored-study-report'
      || result.execution !== 'completed' || result.modelExecution !== 'not_run' || result.providerModelCalls !== 0
      || digestOf(result.schedule) !== digestOf(bindings(row.manifest).schedule)) fail('STUDY_INTEGRITY', 'Final report differs from the frozen study');
    const saved = (await tx.query<{block_id: string; payload: unknown; payload_digest: string}>(
      "SELECT block_id,payload,payload_digest FROM qe_matched_study_events WHERE study_digest=$1 AND event_key='block-result'", [row.study_digest])).rows;
    const blocks = z.array(z.unknown()).parse(result.blocks);
    if (saved.length !== row.manifest.blockIds.length || blocks.length !== saved.length) fail('STUDY_INTEGRITY', 'Final report must retain every planned block');
    row.manifest.blockIds.forEach((blockId, index) => {
      const event = saved.find(e => e.block_id === blockId);
      blockResult(row.manifest, blockId, blocks[index]);
      if (!event || digestOf(event.payload) !== event.payload_digest || digestOf(blocks[index]) !== event.payload_digest)
        fail('STUDY_INTEGRITY', 'Final report must reuse the exact immutable block results');
    });
  }
  /** Read-only: status never renews ownership, dispatches, or changes evidence. */
  async inspect(studyDigest: string) {
    return this.db.transaction(async tx => {
      const row = await this.read(tx, studyDigest, 'share');
      if (!row) return null;
      const rows = (await tx.query<Record<string, unknown> & { block_id: string; event_key: string; fence: number;
        payload: unknown; payload_digest: string }>(`SELECT * FROM qe_matched_study_events
        WHERE study_digest=$1 ORDER BY ordinal`, [studyDigest])).rows;
      const events: MatchedStudyEvent[] = rows.map(event => {
        if (!row.manifest.blockIds.includes(event.block_id) || digestOf(event.payload) !== event.payload_digest
          || event.fence > row.fence) fail('STUDY_INTEGRITY', 'Stored study checkpoint identity or digest mismatch');
        if (event.event_key.startsWith('call-result:') || event.event_key === 'diagnosis') {
          const call = ObjectPayload.parse(ObjectPayload.parse(event.payload).call);
          if (digestOf(ObjectPayload.parse(call.request).evaluation ?? null) !== digestOf(bindings(row.manifest).evaluation ?? null))
            fail('STUDY_INTEGRITY', 'Stored call evaluation context mismatch');
        }
        return { blockId: event.block_id, key: event.event_key, fence: event.fence, payload: event.payload, digest: event.payload_digest };
      });
      return freeze({ studyDigest, manifest: row.manifest, state: row.state, fence: row.fence,
        leaseExpired: row.state === 'running' && !row.lease_valid,
        leaseExpiresAt: row.lease_expires_at === null ? null : new Date(row.lease_expires_at).toISOString(),
        result: row.result, events });
    });
  }
  async claim(rawManifest: MatchedStudyManifest, leaseMs: number) {
    const manifest = freeze(structuredClone(rawManifest)), studyDigest = matchedStudyDigest(manifest), owner = randomUUID();
    z.number().int().min(1).max(3_600_000).parse(leaseMs);
    return this.db.transaction(async tx => {
      const inserted = await tx.query(`INSERT INTO qe_matched_studies
        (study_digest,manifest,manifest_digest,state,owner,fence,lease_expires_at)
        VALUES($1,$2::jsonb,$3,'running',$4,1,clock_timestamp()+$5*interval '1 millisecond')
        ON CONFLICT DO NOTHING RETURNING study_digest`, [studyDigest, JSON.stringify(manifest), digestOf(manifest), owner, leaseMs]);
      const row = (await this.read(tx, studyDigest, true))!;
      if (row.manifest_digest !== digestOf(manifest)) fail('STUDY_CONFLICT', 'Frozen study inputs cannot be added, replaced or removed during recovery');
      if (row.state === 'finished') return { state: 'finished' as const, studyDigest, result: row.result };
      if (!inserted.rows.length && row.lease_valid) return { state: 'busy' as const, studyDigest };
      let fence = row.fence;
      if (!inserted.rows.length) {
        const changed = await tx.query(`UPDATE qe_matched_studies SET owner=$2,fence=fence+1,
          lease_expires_at=clock_timestamp()+$3*interval '1 millisecond'
          WHERE study_digest=$1 AND state='running' AND lease_expires_at<=clock_timestamp() RETURNING fence`, [studyDigest, owner, leaseMs]);
        if (!changed.rows.length) fail('STUDY_FENCED', 'Study recovery claim changed');
        fence = changed.rows[0].fence as number;
      }
      return { state: 'claimed' as const, claim: { studyDigest, owner, fence, leaseMs } };
    });
  }
  private async owned(tx: Queryable, claim: MatchedStudyClaim) {
    z.uuid().parse(claim.owner);
    const row = await this.read(tx, claim.studyDigest, true);
    if (!row || row.state !== 'running' || row.owner !== claim.owner || row.fence !== claim.fence || !row.lease_valid)
      fail('STUDY_FENCED', 'Study claim expired or belongs to another driver; no further dispatch');
    return row;
  }
  /** Persist BEFORE dispatch, await AFTER receipts. Duplicate keys are never a
   * permission to execute; exact immutable results may only be read and reused. */
  async append(claim: MatchedStudyClaim, blockId: string, key: string, rawPayload: unknown) {
    const payload = freeze(structuredClone(rawPayload)), digest = digestOf(payload);
    if (!/^(block-start|block-result|diagnosis|call-intent:[a-f0-9]{64}|call-result:[a-f0-9]{64})$/.test(key))
      fail('STUDY_INTEGRITY', 'Unknown study checkpoint kind');
    await this.db.transaction(async tx => {
      const row = await this.owned(tx, claim);
      if (!row.manifest.blockIds.includes(blockId)) fail('STUDY_CONFLICT', 'Checkpoint is outside the frozen roster');
      const value = ObjectPayload.parse(payload), planned = bindings(row.manifest).schedule.blocks.find(b => b.blockId === blockId)!;
      const terminal = await tx.query('SELECT event_key FROM qe_matched_study_events WHERE study_digest=$1 AND block_id=$2 AND event_key=$3',
        [claim.studyDigest, blockId, 'block-result']);
      if (terminal.rows.length) fail('STUDY_CONFLICT', 'Finished block checkpoints are immutable');
      if (key === 'block-start') z.object({ startedAt: z.iso.datetime() }).strict().parse(payload);
      if (key === 'block-result') blockResult(row.manifest, blockId, payload);
      if (key === 'block-result') {
        const saved = (await tx.query<{ event_key: string; payload: unknown }>(
          'SELECT event_key,payload FROM qe_matched_study_events WHERE study_digest=$1 AND block_id=$2', [claim.studyDigest, blockId])).rows;
        const report = value.report === null ? null : ObjectPayload.parse(value.report);
        if (report) {
          const arms = z.array(z.object({ calls: z.array(ObjectPayload) }).passthrough()).parse(report.arms);
          for (const call of arms.flatMap(a => a.calls)) {
            const native = ObjectPayload.parse(call.nativeRecord);
            const receipt = saved.find(e => e.event_key === `call-result:${native.callId}`);
            if (!receipt || digestOf(ObjectPayload.parse(receipt.payload).call) !== digestOf(call))
              fail('STUDY_INTEGRITY', 'Block report must reuse exact durable call receipts');
          }
          if (report.diagnosisStage !== undefined) {
            const diagnosis = saved.find(e => e.event_key === 'diagnosis');
            if (!diagnosis || digestOf(diagnosis.payload) !== digestOf(report.diagnosisStage))
              fail('STUDY_INTEGRITY', 'Block report must reuse the exact shared diagnosis');
          }
        }
      }
      if (key.startsWith('call-') || key === 'diagnosis') {
        const started = await tx.query('SELECT event_key FROM qe_matched_study_events WHERE study_digest=$1 AND block_id=$2 AND event_key=$3',
          [claim.studyDigest, blockId, 'block-start']);
        if (!started.rows.length) fail('STUDY_INTEGRITY', 'Call checkpoints require a claimed block start');
      }

      if (key.startsWith('call-')) {
        const call = key.startsWith('call-result:') ? ObjectPayload.parse(value.call) : null;
        const native = call ? ObjectPayload.parse(call.nativeRecord) : null;
        const callId = String(native?.callId ?? value.callId), arm = value.arm;
        const stage = call?.stage ?? ['diagnosis','proposal','gate','future'].find(stage => digestOf([blockId, planned.repetition, arm, stage]) === callId);
        if (!['F','U','H','M',null].includes(arm as string | null) || !['diagnosis','proposal','gate','future'].includes(String(stage))
          || (stage === 'diagnosis') !== (arm === null) || (arm === 'F' && stage === 'proposal')
          || key.slice(key.indexOf(':') + 1) !== callId || digestOf([blockId, planned.repetition, arm, stage]) !== callId)
          fail('STUDY_INTEGRITY', 'Call checkpoint identity differs from its frozen slot');
        if (call && (native!.blockId !== blockId || native!.repetition !== planned.repetition || native!.arm !== arm
          || native!.configurationDigest !== row.manifest.configurationDigest || digestOf(call.request) !== call.requestDigest))
          fail('STUDY_INTEGRITY', 'Call result binding mismatch');
        if (call && digestOf(ObjectPayload.parse(call.request).evaluation ?? null) !== digestOf(bindings(row.manifest).evaluation ?? null))
          fail('STUDY_INTEGRITY', 'Call evaluation context differs from frozen study');

        const intent = (await tx.query<{payload: Record<string, unknown>}>(
          'SELECT payload FROM qe_matched_study_events WHERE study_digest=$1 AND block_id=$2 AND event_key=$3',
          [claim.studyDigest, blockId, `call-intent:${callId}`])).rows[0];
        if (call && ((call.invoked === true && !intent) || (intent && intent.payload.requestDigest !== call.requestDigest)))
          fail('STUDY_INTEGRITY', 'Call result must bind its durable dispatch intent');
        if (!call) DigestSchema.parse(value.requestDigest);
      }
      if (key === 'diagnosis') {
        lockedDigest(payload);
        const call = ObjectPayload.parse(value.call), native = ObjectPayload.parse(call.nativeRecord);
        if (value.blockId !== blockId || value.episodeId !== planned.episodeId || value.repetition !== planned.repetition
          || value.configurationDigest !== row.manifest.configurationDigest || native.callId !== digestOf([blockId, planned.repetition, null, 'diagnosis']))
          fail('STUDY_INTEGRITY', 'Shared diagnosis does not belong to this frozen block');
        const receipt = (await tx.query<{payload: {call: Record<string, unknown>}}>(
          'SELECT payload FROM qe_matched_study_events WHERE study_digest=$1 AND block_id=$2 AND event_key=$3',
          [claim.studyDigest, blockId, `call-result:${native.callId}`])).rows[0];
        const rawCall = (candidate: Record<string, unknown>) => {
          const { status: _status, error: _error, nativeRecord, ...rest } = candidate;
          const { status: _nativeStatus, failure: _failure, ...nativeRest } = ObjectPayload.parse(nativeRecord);
          return { ...rest, nativeRecord: nativeRest };
        };
        if (!receipt || digestOf(rawCall(receipt.payload.call)) !== digestOf(rawCall(call)))
          fail('STUDY_INTEGRITY', 'Shared diagnosis requires its exact durable call receipt');
        if (value.status === 'authored_output_locked') {
          const response = MatchedDiagnosisSchema.parse(call.output), shared = ObjectPayload.parse(value.sharedDiagnosis);
          if (digestOf(response) !== digestOf({ diagnoses: shared.diagnoses,
            originalContextStatus: shared.originalContextStatus, revisionContextStatus: shared.revisionContextStatus }))
            fail('STUDY_INTEGRITY', 'Locked diagnosis cannot replace its recorded answer');
        }

      }

      const inserted = await tx.query(`INSERT INTO qe_matched_study_events(study_digest,block_id,event_key,fence,payload,payload_digest)
        VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING event_key`,
      [claim.studyDigest, blockId, key, claim.fence, JSON.stringify(payload), digest]);
      if (!inserted.rows.length) fail('STUDY_CONFLICT', 'Scheduled checkpoint already exists; no repeated dispatch or replacement');
      const refreshed = await tx.query(`UPDATE qe_matched_studies SET lease_expires_at=clock_timestamp()+$4*interval '1 millisecond'
        WHERE study_digest=$1 AND owner=$2 AND fence=$3 AND state='running' AND lease_expires_at>clock_timestamp() RETURNING study_digest`,
      [claim.studyDigest, claim.owner, claim.fence, claim.leaseMs]);
      if (!refreshed.rows.length) fail('STUDY_FENCED', 'Study claim expired while checkpointing');
    });
  }
  async finish(claim: MatchedStudyClaim, rawResult: unknown) {
    const result = freeze(structuredClone(rawResult));
    await this.db.transaction(async tx => {
      const row = await this.owned(tx, claim);
      await this.validateResult(tx, row, result);
      const changed = await tx.query(`UPDATE qe_matched_studies SET state='finished',owner=NULL,lease_expires_at=NULL,result=$4::jsonb,result_digest=$5
        WHERE study_digest=$1 AND owner=$2 AND fence=$3 AND state='running' AND lease_expires_at>clock_timestamp() RETURNING study_digest`,
      [claim.studyDigest, claim.owner, claim.fence, JSON.stringify(result), digestOf(result)]);
      if (!changed.rows.length) fail('STUDY_FENCED', 'Study claim expired before final publication');
    });
    return result;
  }
}

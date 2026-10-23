import { MATCHED_EXECUTION_POLICY_DIGEST } from '../experiments/matched-revision/prompts.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAuthoredCodexNativeMatchedTransport } from '../src/adapters/matched-revision-codex.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { MatchedStudyStore, MatchedStudyError, matchedStudyDigest, type MatchedStudyManifest } from '../src/storage/matched-studies.js';
import { digestOf } from '../src/core/identity.js';
import { runSdkNativeStudy, sdkNativeStudyDigest, type SdkNativeStudyReport } from '../experiments/matched-revision/sdk-native-study.js';
import { inspectSdkNativeStudy } from '../experiments/matched-revision/sdk-native-status.js';
import { createRecoveryFixture } from './helpers/matched-study-recovery-fixture.js';
const exec = promisify(execFile), clean: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (clean.length) await clean.pop()!().catch(() => {}); });
async function fixture(repetitions = 1, disk = false) {
  const root = await mkdtemp(join(tmpdir(), 'matched-recovery-')); clean.push(() => rm(root, { recursive: true, force: true }));
  const input = await createRecoveryFixture(join(root, 'authored'), repetitions), path = disk ? join(root, 'db') : undefined;
  const db = await openPGliteDatabase(path); clean.push(() => db.close());
  const store = await MatchedStudyStore.initialize(db);
  const transport = createAuthoredCodexNativeMatchedTransport(input.transportOptions);
  const manifest: MatchedStudyManifest = { schemaVersion: 1, kind: 'authored-matched-study-recovery',
    scheduleDigest: input.schedule.digest, configurationDigest: digestOf(input.configuration), blockIds: input.schedule.blocks.map(b => b.blockId),
    input: { executionPolicyDigest: MATCHED_EXECUTION_POLICY_DIGEST, schedule: input.schedule, configuration: input.configuration, blocks: input.blocks } };
  const audit = async () => (await readFile(join(input.transportOptions.workingDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, input, path, db, store, transport, manifest, audit,
    run: () => runSdkNativeStudy({ ...input, transport, store }) };
}
async function expire(db: Database) { await db.query("UPDATE qe_matched_studies SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE state='running'"); }
async function childRun(root: string, input: unknown, path: string) {
  const source = join(root, 'input.json'); await writeFile(source, JSON.stringify(input));
  const code = `
    import {readFile} from 'node:fs/promises';
    import {openPGliteDatabase} from './src/storage/database.ts';
    import {MatchedStudyStore} from './src/storage/matched-studies.ts';
    import {createAuthoredCodexNativeMatchedTransport} from './src/adapters/matched-revision-codex.ts';
    import {runSdkNativeStudy} from './experiments/matched-revision/sdk-native-study.ts';
    const input=JSON.parse(await readFile(${JSON.stringify(source)},'utf8'));
    const db=await openPGliteDatabase(${JSON.stringify(path)});
    try {const store=await MatchedStudyStore.initialize(db);
      const result=await runSdkNativeStudy({...input,store,transport:createAuthoredCodexNativeMatchedTransport(input.transportOptions)});
      process.stdout.write(JSON.stringify(result));} finally {await db.close();}`;
  const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: resolve('.'), timeout: 30_000, maxBuffer: 20_000_000 });
  return JSON.parse(result.stdout) as SdkNativeStudyReport;
}

describe('durable authored study recovery', () => {
  it('isolates historical unversioned recovery from active-state-v2 without rewriting its record', async () => {
    const f = await fixture();
    const old = structuredClone(f.manifest);
    delete (old.input as Record<string, unknown>).executionPolicyDigest;
    const prior = await f.store.claim(old, 10000);
    const current = await f.store.claim(f.manifest, 10000);
    expect(prior.state).toBe('claimed'); expect(current.state).toBe('claimed');
    expect(matchedStudyDigest(old)).not.toBe(matchedStudyDigest(f.manifest));
    expect(sdkNativeStudyDigest(f.input.schedule, f.input.configuration)).toBe(matchedStudyDigest(f.manifest));
    expect((await f.store.inspect(matchedStudyDigest(old)))!.manifest).toEqual(old);
  }, 15_000);
  it('opens status without schema creation or migration', async () => {
    const db = await openPGliteDatabase(); clean.push(() => db.close());
    await expect(MatchedStudyStore.openExisting(db)).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
    expect((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
    await MatchedStudyStore.initialize(db);
    const history = (await db.query('SELECT * FROM qe_schema_migrations ORDER BY id')).rows;
    await MatchedStudyStore.openExisting(db);
    expect((await db.query('SELECT * FROM qe_schema_migrations ORDER BY id')).rows).toEqual(history);
  }, 30_000);

  it('claims atomically, fences stale owners, rejects changed inputs and prevents mutable checkpoints', async () => {
    const f = await fixture(), other = await MatchedStudyStore.initialize(f.db);
    const claims = await Promise.all([f.store.claim(f.manifest, 30_000), other.claim(f.manifest, 30_000)]);
    expect(claims.map(c => c.state).sort()).toEqual(['busy', 'claimed']);
    const first = claims.find(c => c.state === 'claimed')!;
    if (first.state !== 'claimed') throw new Error('claim');
    await f.store.append(first.claim, f.input.blocks[0].blockId, 'block-start', { startedAt: new Date().toISOString() });
    await expect(f.store.claim({ ...f.manifest, input: { ...(f.manifest.input as object), blocks: [null] } }, 30_000)).rejects.toMatchObject({ code: 'STUDY_CONFLICT' });
    await expire(f.db);
    const recovered = await other.claim(f.manifest, 30_000);
    expect(recovered.state).toBe('claimed');
    if (recovered.state !== 'claimed') throw new Error('claim');
    expect(recovered.claim.fence).toBe(2);
    await expect(f.store.append(first.claim, f.input.blocks[0].blockId, 'diagnosis', {})).rejects.toMatchObject({ code: 'STUDY_FENCED' });
    await expect(other.append(recovered.claim, f.input.blocks[0].blockId, 'block-start', { startedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'STUDY_CONFLICT' });
    await expect(other.append(recovered.claim, f.input.blocks[0].blockId, 'block-result', { wrongIdentity: true })).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
    await expect(other.append(recovered.claim, f.input.blocks[0].blockId, `call-intent:${digestOf('wrong')}`,
      { arm: null, callId: digestOf('wrong'), requestDigest: digestOf('request') })).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
    const block = f.input.schedule.blocks[0], invented = digestOf([block.blockId, block.repetition, 'H', 'invented']);
    await expect(other.append(recovered.claim, block.blockId, `call-result:${invented}`,
      { arm: 'H', call: { stage: 'invented', nativeRecord: { callId: invented } } })).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
    await expect(f.db.query("UPDATE qe_matched_study_events SET payload='{}'::jsonb")).rejects.toThrow(/append-only/);
    await expect(f.db.query('DELETE FROM qe_matched_studies')).rejects.toThrow(/cannot be deleted/);
    expect((await inspectSdkNativeStudy(other, matchedStudyDigest(f.manifest)))!.nextAction).toBe('wait_for_current_driver');
  }, 30_000);

  it('commits one shared diagnosis and reuses the byte-identical report after a new process opens the database', async () => {
    const f = await fixture(1, true), finish = f.store.finish.bind(f.store);
    vi.spyOn(f.store, 'finish').mockImplementation(async (claim, raw) => {
      const result = structuredClone(raw) as SdkNativeStudyReport;
      for (const change of [
        { ...result, scheduleDigest: digestOf('substituted') },
        { ...result, blocks: [] },
        { ...result, blocks: result.blocks.map(b => ({ ...b, failure: 'rewritten' })) },
      ]) {
        const { digest: _digest, ...body } = change;
        await expect(finish(claim, { ...body, digest: digestOf(body) })).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
      }
      await expect(f.store.append(claim, result.blocks[0].blockId, 'block-start', { startedAt: new Date().toISOString() }))
        .rejects.toMatchObject({ code: 'STUDY_CONFLICT' });
      return finish(claim, raw);
    });
    const first = await f.run();
    expect(first.execution).toBe('completed');
    if (first.execution !== 'completed') throw new Error('report');
    expect(first.counts).toMatchObject({ completedBlocks: 1, retries: 0 });
    expect(first.blocks[0].diagnosisSlot?.status).toBe('authored_output_locked');
    expect(await f.audit()).toHaveLength(12);
    const studyDigest = first.recovery!.studyDigest;
    expect((await f.store.inspect(studyDigest))!.events.filter(e => e.key === 'diagnosis')).toHaveLength(1);
    await expect(f.db.query("UPDATE qe_matched_studies SET result='{}'::jsonb")).rejects.toThrow(/immutable/);
    await f.db.close();
    const second = await childRun(f.root, f.input, f.path!);
    expect(second).toEqual(first); expect(await f.audit()).toHaveLength(12);
    const cli = await exec(process.execPath, ['--import', 'tsx', 'experiments/matched-revision/replay.ts', '--study-status', studyDigest, '--db', f.path!], { timeout: 20_000 });
    expect(JSON.parse(cli.stdout)).toMatchObject({ state: 'finished', nextAction: 'read_immutable_result', reportDigest: first.digest,
      blocks: [{ diagnosis: 'locked', retainedCallRecords: 12, uncertainCalls: [] }] });
  }, 60_000);

  it('resumes only never-started blocks after a persisted completed block, preserving its exact result', async () => {
    const f = await fixture(2, true), original = f.store.append.bind(f.store);
    let retained: unknown;
    vi.spyOn(f.store, 'append').mockImplementation(async (...args) => {
      await original(...args);
      if (args[2] === 'block-result') { retained = args[3]; throw new MatchedStudyError('STUDY_FENCED', 'Authored driver interruption after durable block result'); }
    });
    await expect(f.run()).rejects.toThrow(/interruption/); expect(await f.audit()).toHaveLength(12);
    await expire(f.db); await f.db.close();
    const report = await childRun(f.root, f.input, f.path!);
    expect(report.counts).toMatchObject({ completedBlocks: 2, retries: 0 });
    expect(report.blocks[0]).toEqual(retained); expect(await f.audit()).toHaveLength(24);
  }, 60_000);

  it('retains an ambiguous diagnosis intent and every target without another process dispatching any call', async () => {
    const f = await fixture(2, true), original = f.store.append.bind(f.store);
    vi.spyOn(f.store, 'append').mockImplementation(async (...args) => {
      await original(...args);
      if (args[2].startsWith('call-intent:')) throw new MatchedStudyError('STUDY_FENCED', 'Authored interruption after dispatch intent');
    });
    await expect(f.run()).rejects.toThrow(/interruption/);
    await expect(f.audit()).rejects.toThrow();
    await expire(f.db);
    const status = await inspectSdkNativeStudy(f.store, matchedStudyDigest(f.manifest));
    expect(status?.nextAction).toBe('recover_roster_without_further_dispatch');
    expect(status!.blocks[0].uncertainCalls).toHaveLength(1);
    await f.db.close();
    const report = await childRun(f.root, f.input, f.path!);
    expect(report.counts).toMatchObject({ plannedBlocks: 2, failedBlocks: 1, missingBlocks: 1, retries: 0 });
    expect(report.blocks[0]).toMatchObject({ interrupted: true, report: null, uncertainCalls: [{ arm: null }] });
    for (const block of report.blocks) {
      expect(block.roster.map(a => a.arm)).toEqual(block.plannedArmOrder);
      expect(block.roster.flatMap(a => a.future)).toHaveLength(12);
    }
    await expect(f.audit()).rejects.toThrow();
  }, 60_000);

  it('retains a completed diagnosis on interruption, never recalls it, and conservatively closes that partial block', async () => {
    const f = await fixture(1, true), original = f.store.append.bind(f.store);
    let diagnosis: unknown;
    vi.spyOn(f.store, 'append').mockImplementation(async (...args) => {
      if (args[2] === 'diagnosis') {
        const modified = structuredClone(args[3]) as { digest: string; call: { output: { diagnoses: { reasoning: string }[] }; outputDigest: string } };
        modified.call.output.diagnoses[0].reasoning = 'Substituted authored answer';
        modified.call.outputDigest = digestOf(modified.call.output);
        const { digest: _digest, ...body } = modified;
        await expect(original(args[0], args[1], args[2], { ...body, digest: digestOf(body) })).rejects.toMatchObject({ code: 'STUDY_INTEGRITY' });
      }
      await original(...args);
      if (args[2] === 'diagnosis') { diagnosis = args[3]; throw new MatchedStudyError('STUDY_FENCED', 'Authored interruption after shared diagnosis'); }
    });
    await expect(f.run()).rejects.toThrow(/interruption/); expect(await f.audit()).toHaveLength(1);
    await expire(f.db); await f.db.close();
    const report = await childRun(f.root, f.input, f.path!);
    expect(report.counts).toMatchObject({ failedBlocks: 1, retries: 0 });
    expect(report.blocks[0].diagnosisSlot!.record).toEqual(diagnosis);
    expect(report.blocks[0].actualCallOrder).toHaveLength(1);
    expect(report.blocks[0].interruptedSharedCallRecords).toHaveLength(1);
    expect(await f.audit()).toHaveLength(1);
  }, 60_000);
  it('recovers interrupted receipt order and consumed proposal slots without favorable rerolls', async () => {
    const f = await fixture(), original = f.store.append.bind(f.store);
    let calls = 0;
    vi.spyOn(f.store, 'append').mockImplementation(async (...args) => {
      await original(...args);
      if (args[2].startsWith('call-result:') && ++calls === 4)
        throw new MatchedStudyError('STUDY_FENCED', 'Authored interruption after multiple call receipts');
    });
    await expect(f.run()).rejects.toThrow(/interruption/);
    const before = (await f.store.inspect(matchedStudyDigest(f.manifest)))!;
    const expected = before.events.filter(e => e.key.startsWith('call-result:'))
      .map(e => (e.payload as { call: { nativeRecord: { callId: string } } }).call.nativeRecord.callId);
    expect(expected).toHaveLength(4);
    vi.restoreAllMocks(); await expire(f.db);
    const report = await f.run();
    if (report.execution !== 'completed') throw new Error('report');
    const block = report.blocks[0];
    expect(block.actualCallOrder.map(c => c.callId)).toEqual(expected);
    for (const { arm, call } of block.interruptedCallRecords!) if (call.stage === 'proposal')
      expect(block.roster.find(a => a.arm === arm)!.proposalSlotsUsed).toBe(1);
    expect(await f.audit()).toHaveLength(4);
  }, 30_000);

});

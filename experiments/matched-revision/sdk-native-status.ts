import type { MatchedStudyStore } from '../../src/storage/matched-studies.js';
import type { SdkNativeStudyReport } from './sdk-native-study.js';
import { validateSdkNativeSchedule } from './sdk-native-schedule.js';
import type { CallRecord } from './runner.js';

/** Recovery inspection never dispatches. The full immutable evidence remains in
 * store.inspect(); this view keeps the next action and fixed roster readable. */
export async function inspectSdkNativeStudy(store: MatchedStudyStore, studyDigest: string) {
  const state = await store.inspect(studyDigest);
  if (!state) return null;
  const result = state.result as SdkNativeStudyReport | null;
  const schedule = validateSdkNativeSchedule((state.manifest.input as { schedule: unknown }).schedule);
  const blocks = state.manifest.blockIds.map(blockId => {
    const planned = schedule.blocks.find(b => b.blockId === blockId)!;
    const events = state.events.filter(e => e.blockId === blockId);
    const results = events.filter(e => e.key.startsWith('call-result:'));
    const uncertainCalls = events.filter(e => e.key.startsWith('call-intent:')
      && !events.some(r => r.key === `call-result:${e.key.slice('call-intent:'.length)}`)).map(e => e.payload);
    const completed = events.find(e => e.key === 'block-result')?.payload as SdkNativeStudyReport['blocks'][number] | undefined;
    const unsafeCleanup = results.some(e => {
      const { call } = e.payload as { call: CallRecord };
      return call.invoked && call.transportEvidence?.cleanup !== 'verified';
    });
    return { blockId, state: completed?.status ?? (events.some(e => e.key === 'block-start') ? 'interrupted_or_running' : 'pending'),
      diagnosis: events.some(e => e.key === 'diagnosis') ? 'locked' : 'not_locked',
      retainedCallRecords: results.length, uncertainCalls, unsafeCleanup,
      plannedArmOrder: planned.armOrder, plannedFutureTargetOrder: planned.futureTargetOrder };
  });
  return { studyDigest, state: state.state, fence: state.fence, leaseExpired: state.leaseExpired,
    leaseExpiresAt: state.leaseExpiresAt,
    nextAction: state.state === 'finished' ? 'read_immutable_result' : !state.leaseExpired ? 'wait_for_current_driver'
      : blocks.some(b => b.uncertainCalls.length || b.unsafeCleanup) ? 'recover_roster_without_further_dispatch'
      : 'recover_unstarted_blocks_only',
    modelExecution: 'not_run', providerModelCalls: 0, retries: 0,
    reportDigest: result?.digest ?? null, counts: result?.counts ?? null, blocks };
}

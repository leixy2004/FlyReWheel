import { join } from 'node:path';
import { createRecoveryFixture } from './evaluation-bridge-fixture.js';
import { createAuthoredCodexNativeMatchedTransport } from '../../src/adapters/matched-revision-codex.js';
import { runSdkNativeStudy } from './sdk-native-study.js';
import type { NativeMacroInput } from './native-macro-report.js';
/** Existing supervised SDK authored executable; no model/backend or acquisition. */
export async function createNativeMacroFixture(root: string): Promise<NativeMacroInput> {
  const fixture = await createRecoveryFixture(join(root, 'authored-study'), 3);
  const transport = createAuthoredCodexNativeMatchedTransport(fixture.transportOptions);
  const study = await runSdkNativeStudy({ ...fixture, transport,
    blocks: fixture.blocks.filter(b => fixture.schedule.blocks.find(s => s.blockId === b.blockId)!.repetition !== 3) });
  if (study.execution !== 'completed') throw new Error('Authored native fixture did not return its planned roster');
  const repository = fixture.blocks[0].packet.episode.revision.snapshots[0].snapshot.repository.id;
  return { configuration: fixture.configuration, sources: fixture.blocks, study,
    clusters: [{ repository, clusterId: 'authored-dependent-cluster',
      lineages: [...new Set(fixture.blocks.flatMap(b => [...b.packet.episode.revisionLineageIds, ...b.packet.episode.gate.map(g => g.input.lineageId), ...b.future.cases.map(c => c.input.lineageId)]))].sort() }] };
}

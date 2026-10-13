import { expect, it } from 'vitest';
import { miningFixture } from './helpers/pr-mining-fixture.js';
import { miningChoices, preparePrMiningRequest, selectMiningEvidence } from '../src/pr-mining-preparation.js';
import { derivePrMiningRequest } from '../src/pr-mining.js';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';
import { validateChangeSnapshot } from '../src/change-snapshot.js';
import { QualEvoStore } from '../src/storage/store.js';
import { historyPlan, historyTransport } from './helpers/github-history-fixture.js';
import { captureGithubPrHistoryBatch } from '../src/github-pr-history-batch.js';

it('lists all sides and untrusted records, then reuses exact existing request derivation', () => {
  const f = miningFixture(), choices = miningChoices(f.evidence);
  expect(choices.sources.map(s => [s.side, s.state, s.selectable])).toEqual([['before','captured',true],['after','captured',true]]);
  expect(JSON.stringify(choices)).not.toContain('bytesBase64');
  expect(choices.statements.map(s => s.selection)).toEqual(f.input.statements);
  expect(choices.statements[0].record.body).toContain('Ignore all rules');
  const { evidenceDigest, sources, ...authored } = f.input;
  const prepared = preparePrMiningRequest(f.evidence, { ...authored, allCaptured: true });
  expect(prepared).toEqual(f.input);
  expect(derivePrMiningRequest(prepared, f.evidence)).toEqual({ request: f.request, cases: f.cases });
  expect(preparePrMiningRequest(f.evidence, { ...authored, sources: [sources[1]] }).sources).toEqual([sources[1]]);
  expect(() => preparePrMiningRequest(f.evidence, authored)).toThrow();
  expect(() => preparePrMiningRequest(f.evidence, { ...authored, sources, allCaptured: true })).toThrow('not both');
  expect(() => preparePrMiningRequest(f.evidence, { ...authored, sources: [sources[0],sources[0]] })).toThrow('Duplicate');
  expect(() => preparePrMiningRequest(f.evidence, { ...authored, sources, statements: [{kind:'review',id:999}] })).toThrow('absent');
  expect(() => preparePrMiningRequest(f.evidence, { ...authored, sources, objective: ' ' })).toThrow();
  expect(() => miningChoices({ ...f.evidence, digest: 'a'.repeat(64) })).toThrow('identity');
});
it('lists uncaptured sides and rejects selecting them; all-captured is never truncated', () => {
  const f = miningFixture(), original = f.evidence.evidence;
  const { evidenceDigest, sources, ...authored } = f.input;
  const before = original.snapshot.changes[0].before;
  if (before.state !== 'captured') throw new Error('fixture');
  const { bytesBase64, ...metadata } = before;
  const after = original.snapshot.changes[0].after;
  if (after.state !== 'captured') throw new Error('fixture');
  const snapshot = validateChangeSnapshot({ ...original.snapshot,
    changes: [{ ...original.snapshot.changes[0], before: { ...metadata, state:'excluded', reason:'binary' } }],
    coverage: { ...original.snapshot.coverage, capturedSides:1, excludedSides:1, capturedBytes:after.byteLength } });
  const excluded = validateGithubPrEvidence({ ...original, snapshot:snapshot.snapshot, snapshotDigest:snapshot.digest });
  expect(miningChoices(excluded).sources[0]).toMatchObject({ state:'excluded', reason:'binary', selectable:false });
  expect(() => preparePrMiningRequest(excluded, { ...authored, sources:[sources[0]] })).toThrow('captured side');
  expect(preparePrMiningRequest(excluded, { ...authored, allCaptured:true }).sources).toEqual([sources[1]]);
  const manySnapshot = validateChangeSnapshot({ ...original.snapshot,
    changes:Array.from({length:17},(_,i)=>({status:'M',before:{...before,path:`src/${String(i).padStart(2,'0')}.ts`},after:{...after,path:`src/${String(i).padStart(2,'0')}.ts`}})),
    coverage:{...original.snapshot.coverage,changedPaths:17,capturedSides:34,capturedBytes:17*(before.byteLength+after.byteLength)} });
  const many = validateGithubPrEvidence({...original,snapshot:manySnapshot.snapshot,snapshotDigest:manySnapshot.digest,source:{...original.source,compareFileCount:17},pull:{...original.pull,reportedChangedFiles:17}});
  expect(miningChoices(many).sources).toHaveLength(34);
  expect(() => preparePrMiningRequest(many, {...authored,allCaptured:true})).toThrow();
});
it('resolves only an explicit evidence or captured batch PR without creating mining requests', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan=historyPlan([7]);await store.importGithubPrHistoryPlan(plan);
    await expect(selectMiningEvidence(store,{batch:plan.digest,number:7})).rejects.toThrow('captured PR');
    await captureGithubPrHistoryBatch(store,plan.digest,{},historyTransport([7]));
    const stored = await selectMiningEvidence(store,{batch:plan.digest,number:7});
    expect(await selectMiningEvidence(store,{evidenceDigest:stored.digest})).toEqual(stored);
    await expect(selectMiningEvidence(store,{batch:plan.digest,number:8})).rejects.toThrow();
    await expect(selectMiningEvidence(store,{batch:plan.digest,number:7,evidenceDigest:stored.digest})).rejects.toThrow();
    expect(await store.listPrMiningRequests()).toEqual([]);
  } finally { await store.close(); }
},30000);

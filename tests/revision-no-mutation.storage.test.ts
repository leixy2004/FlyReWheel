import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { readTrustedRevisionNoMutation, type RevisionWorkspaceModelOutcome, type TrustedRevisionNoMutation,
  type TrustedRevisionCandidate } from '../src/adapters/revision-model.js';
import { generateRuleRevision } from '../src/rule-revision.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { revisionGenerationFixture, revisionConfig, revisionDate } from './helpers/revision-generation-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(db?: Database, unregisteredFeedbackSource = false) {
  const f = await revisionGenerationFixture(db, unregisteredFeedbackSource); cleanup.push(f.cleanup);
  f.runtime.execute = async () => ({ ...f.envelope, value: { ...f.value, result: {
    status: 'no_rule_change', operator: 'request_context', reasoning: 'The selected anchor does not establish the applicable guard context',
    nextStep: 'Request the guard policy and its applicability to this exact finding', missingEvidence: ['Applicable guard policy'], evidenceRefs: [],
    diagnoses: [{ ...f.value.result.diagnoses[0], category: 'context', missingEvidence: ['Applicable guard policy'] }],
  } } });
  return f;
}
function noMutation(result: RevisionWorkspaceModelOutcome) {
  expect(result, JSON.stringify(result)).toMatchObject({ execution: 'succeeded', status: 'no_rule_change' });
  if (result.execution !== 'succeeded' || result.status !== 'no_rule_change') throw new Error('Missing no-mutation outcome');
  return result;
}

it('persists and reopens diagnoses and receipts without creating a rule, candidate or repaired finding', async () => {
  const f = await fixture(), findingBefore = await f.store.getReviewFinding(f.finding.id);
  const generated = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: f.input.candidateId,
    candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
  const result = noMutation(generated);
  if (!('savedOutcome' in generated)) throw new Error('Missing stored outcome');
  const saved = generated.savedOutcome;
  expect(saved.outcome).toMatchObject({ kind: 'rule-revision-no-mutation', source: 'fixture', synthesis: 'not_run',
    result: { status: 'no_rule_change', operator: 'request_context', nextStep: expect.any(String), diagnoses: [{ category: 'context' }] },
    ruleMutation: 'not_performed', reviewRepair: 'not_performed', activation: 'not_performed',
    executionReceipt: { modelExecution: 'not_run', cleanup: 'verified' } });
  expect(saved.outcome).not.toHaveProperty('ruleDigest');
  expect(saved.outcome).not.toHaveProperty('rule');
  expect(await f.store.saveRevisionModelOutcome(result.outcomePersistence)).toEqual(saved);
  expect(await f.store.getRevisionOutcome(saved.digest)).toEqual(saved);
  expect(await f.store.listRevisionOutcomes()).toEqual([saved]);
  expect(await f.store.listRevisionOutcomes(f.request.digest)).toEqual([saved]);
  expect(await f.store.listRevisionOutcomes('f'.repeat(64))).toEqual([]);
  expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect(await f.store.listRuleVersions()).toEqual([f.baseRule]);
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
  expect(await f.store.getReviewFinding(f.finding.id)).toEqual(findingBefore);
  expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
  expect(await f.store.getProblemCase('safe-case')).toEqual(f.cases[1]);
  await f.closeStore();
  const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db'));
  try {
    expect(await reopened.getRevisionOutcome(saved.digest)).toEqual(saved);
    expect(await reopened.listRevisionOutcomes(f.request.digest)).toEqual([saved]);
    expect(await reopened.listRevisionCandidates()).toEqual([]);
    expect(await reopened.listRuleVersions()).toHaveLength(1);
  } finally { await reopened.close(); }
}, 30_000);

it('rejects JSON, copied and wrong-kind capabilities without saving a diagnosis or rule', async () => {
  const f = await fixture(), result = noMutation(await f.adapter().generate(f.input));
  const input = readTrustedRevisionNoMutation(result.outcomePersistence);
  for (const forged of [input, result.outcome, structuredClone(result.outcomePersistence), JSON.parse(JSON.stringify(result.outcomePersistence)), {}, null]) {
    await expect(f.store.saveRevisionModelOutcome(forged as TrustedRevisionNoMutation)).rejects.toThrow('trusted runtime capability');
  }
  await expect(f.store.saveRevisionModelCandidate(result.outcomePersistence as unknown as TrustedRevisionCandidate)).rejects.toThrow('trusted runtime capability');
  expect(() => { input.candidateCreatedAt = '2026-10-03T00:00:00Z'; }).toThrow();
  expect(await f.store.listRevisionOutcomes()).toEqual([]);
  expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect(await f.store.listRuleVersions()).toHaveLength(1);
}, 30_000);

it('keeps outcomes append-only and rejects reuse of an ID with different accepted content', async () => {
  const f = await fixture(), first = noMutation(await f.adapter().generate(f.input));
  const saved = await f.store.saveRevisionModelOutcome(first.outcomePersistence);
  const second = noMutation(await f.adapter().generate({ ...f.input, candidateCreatedAt: '2026-10-02T00:00:01Z' }));
  await expect(f.store.saveRevisionModelOutcome(second.outcomePersistence)).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  await expect(f.db.query('UPDATE qe_revision_outcomes SET payload=$1::jsonb WHERE digest=$2', ['{}', saved.digest])).rejects.toThrow('append-only');
  await expect(f.db.query('DELETE FROM qe_revision_outcomes WHERE digest=$1', [saved.digest])).rejects.toThrow('append-only');
  expect(await f.store.listRevisionOutcomes(f.request.digest)).toEqual([saved]);
  expect(await f.store.listRuleVersions()).toHaveLength(1);
}, 30_000);

it('rederives exact outcome content and rejects tampered receipts even with recomputed digests', async () => {
  const f = await fixture(), result = noMutation(await f.adapter().generate(f.input));
  const saved = await f.store.saveRevisionModelOutcome(result.outcomePersistence);
  await f.db.exec('ALTER TABLE qe_revision_outcomes DISABLE TRIGGER qe_revision_outcomes_immutable');
  const changedDiagnosis = structuredClone(saved.outcome);
  changedDiagnosis.result.reasoning = 'A substituted diagnosis that was never accepted by the runtime';
  const diagnosisDigest = digestOf(changedDiagnosis);
  await f.db.query('UPDATE qe_revision_outcomes SET digest=$1,payload=$2::jsonb WHERE digest=$3',
    [diagnosisDigest, JSON.stringify(changedDiagnosis), saved.digest]);
  await expect(f.store.getRevisionOutcome(diagnosisDigest)).rejects.toThrow('differs from rederived execution');
  const forgedReceipt = structuredClone(saved.outcome); forgedReceipt.executionReceipt.promptDigest = 'f'.repeat(64);
  const receiptDigest = digestOf(forgedReceipt);
  await f.db.query('UPDATE qe_revision_outcomes SET digest=$1,payload=$2::jsonb WHERE digest=$3',
    [receiptDigest, JSON.stringify(forgedReceipt), diagnosisDigest]);
  await expect(f.store.getRevisionOutcome(receiptDigest)).rejects.toThrow('binding mismatch');
  await expect(f.store.listRevisionOutcomes(f.request.digest)).rejects.toThrow('binding mismatch');
}, 30_000);

it('rolls back a failed outcome save and source reservations, then permits retry of the same capability', async () => {
  const db = await openPGliteDatabase(); let fail = true;
  const wrapped: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, params) => {
    if (fail && sql.startsWith('INSERT INTO qe_revision_outcomes(')) throw new Error('Authored outcome write failure');
    return tx.query(sql, params);
  } })) };
  const f = await fixture(wrapped, true), result = noMutation(await f.adapter().generate(f.input));
  const consumedDigest = f.cases[1].sourceDigest;
  expect((await db.query('SELECT digest FROM qe_source_splits WHERE digest=$1', [consumedDigest])).rows).toEqual([]);
  await expect(f.store.saveRevisionModelOutcome(result.outcomePersistence)).rejects.toThrow('Authored outcome write failure');
  expect(await f.store.listRevisionOutcomes()).toEqual([]);
  expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect(await f.store.listRuleVersions()).toHaveLength(1);
  expect((await db.query('SELECT digest FROM qe_source_splits WHERE digest=$1', [consumedDigest])).rows).toEqual([]);
  fail = false;
  const saved = await f.store.saveRevisionModelOutcome(result.outcomePersistence);
  expect(saved.outcome).toEqual(result.outcome);
  expect((await db.query('SELECT split FROM qe_source_splits WHERE digest=$1', [consumedDigest])).rows).toEqual([{ split: 'training' }]);
  expect(await f.store.listRevisionOutcomes()).toEqual([saved]);
}, 30_000);

it('refuses no-mutation persistence when consumed source content was registered as heldout after execution', async () => {
  const f = await fixture(undefined, true), result = noMutation(await f.adapter().generate(f.input));
  await f.store.importProblemCase({ ...f.cases[1], id: 'future-holdout', lineageId: 'future-holdout', split: 'holdout', expected: 'unknown' });
  await expect(f.store.saveRevisionModelOutcome(result.outcomePersistence)).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  expect(await f.store.listRevisionOutcomes()).toEqual([]);
  expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect(await f.store.listRuleVersions()).toHaveLength(1);
}, 30_000);

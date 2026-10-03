import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { miningFixture, miningCandidate } from './helpers/pr-mining-fixture.js';

it('atomically persists requests/cases and supplied v2 candidate links, idempotently and across disk reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mining-store-')), path = join(directory, 'db');
  let store: QualEvoStore | undefined;
  try {
    const fixture = miningFixture(), db = await openPGliteDatabase(path); store = await QualEvoStore.initialize(db);
    await store.importGithubPrEvidence(fixture.evidence.evidence);
    expect(await Promise.all([store.createPrMiningRequest(fixture.input), store.createPrMiningRequest(fixture.input)])).toEqual([fixture.request, fixture.request]);
    for (const value of fixture.cases) expect(await store.getProblemCase(value.id)).toEqual(value);
    const [candidate, repeated] = await Promise.all([store.importPrMiningCandidate(fixture.candidate), store.importPrMiningCandidate(fixture.candidate)]);
    expect(repeated).toEqual(candidate);
    expect((await store.getRuleVersion(candidate.candidate.ruleDigest)).rule).toEqual(fixture.candidate.rule);
    expect(await store.getActive(fixture.candidate.rule.ruleId)).toBeNull();
    expect(await store.listPrMiningRequests()).toEqual([fixture.request]);
    expect(await store.listPrMiningRequests('f'.repeat(64))).toEqual([]);
    expect(await store.listPrMiningCandidates(fixture.request.digest)).toEqual([candidate]);
    expect(await store.listPrMiningCandidates('f'.repeat(64))).toEqual([]);
    expect((await db.query('SELECT * FROM qe_rule_bundles')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM qe_problem_cases')).rows).toHaveLength(2);
    expect((await db.query('SELECT * FROM qe_feedback')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM qe_semantic_review_feedback')).rows).toHaveLength(0);
    for (const table of ['qe_pr_mining_requests', 'qe_pr_mining_candidates']) {
      await expect(db.query(`UPDATE ${table} SET payload='{}'::jsonb`)).rejects.toThrow('append-only');
      await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow('append-only');
    }
    await expect(store.createPrMiningRequest({ ...fixture.input, objective: 'Changed objective' })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    await expect(store.importPrMiningCandidate({ ...fixture.candidate, rule: { ...fixture.candidate.rule, semantics: { ...fixture.candidate.rule.semantics, title: 'Changed meaning' } } })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    const review = await store.runSemanticReview({ ruleDigest: candidate.candidate.ruleDigest, snapshotDigest: fixture.evidence.evidence.snapshotDigest });
    expect(review.findings).toHaveLength(0);
    expect(review.coverage.targets.every(value => value.semantic.state === 'not_run')).toBe(true);
    await store.close(); store = undefined;
    store = await QualEvoStore.openPGlite(path);
    expect(await store.getPrMiningRequest(fixture.request.digest)).toEqual(fixture.request);
    expect(await store.getPrMiningCandidate(candidate.digest)).toEqual(candidate);
    expect(await store.getSemanticReview(review.id)).toEqual(review);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('rolls back every newly inserted case, split and rule on request/candidate persistence failure', async () => {
  const fixture = miningFixture(), db = await openPGliteDatabase();
  let failure = 'qe_pr_mining_requests';
  const wrapped: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, params) => {
    if (failure && sql.startsWith(`INSERT INTO ${failure}(`)) throw new Error('Injected mining write failure');
    return tx.query(sql, params);
  } })) };
  const store = await QualEvoStore.initialize(wrapped);
  try {
    await store.importGithubPrEvidence(fixture.evidence.evidence);
    await expect(store.createPrMiningRequest(fixture.input)).rejects.toThrow('Injected mining write failure');
    for (const table of ['qe_pr_mining_requests', 'qe_problem_cases', 'qe_case_lineages', 'qe_source_splits']) expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    failure = ''; await store.createPrMiningRequest(fixture.input);
    failure = 'qe_pr_mining_candidates';
    await expect(store.importPrMiningCandidate(fixture.candidate)).rejects.toThrow('Injected mining write failure');
    expect(await store.listRuleVersions()).toHaveLength(0);
    expect(await store.listPrMiningCandidates()).toHaveLength(0);
    expect(await store.listPrMiningRequests()).toHaveLength(1);
    failure = ''; const candidate = await store.importPrMiningCandidate(fixture.candidate);
    const nextInput = { ...fixture.input, id: 'next', requestedRule: { ...fixture.input.requestedRule, version: 'draft-2', parentDigest: candidate.candidate.ruleDigest } };
    const request = await store.createPrMiningRequest(nextInput), next = miningCandidate(request); next.id = fixture.candidate.id;
    await expect(store.importPrMiningCandidate(next)).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    expect(await store.listRuleVersions()).toHaveLength(1);
    next.id = 'new-candidate';
    const second = await store.importPrMiningCandidate(next);
    expect((await store.getRuleVersion(second.candidate.ruleDigest)).rule.provenance.parentDigest).toBe(candidate.candidate.ruleDigest);
  } finally { await store.close(); }
}, 30_000);

it('rejects heldout source contamination, nonexistent parents and conflicting parent identities before creating requests', async () => {
  const fixture = miningFixture(), store = await QualEvoStore.openPGlite();
  try {
    await store.importGithubPrEvidence(fixture.evidence.evidence);
    await store.importProblemCase({ ...fixture.cases[1], id: 'heldout-case', lineageId: 'heldout-lineage', split: 'holdout' });
    await expect(store.createPrMiningRequest(fixture.input)).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
    expect(await store.listPrMiningRequests()).toEqual([]);
    await expect(store.getProblemCase(fixture.cases[0].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.createPrMiningRequest({ ...fixture.input, requestedRule: { ...fixture.input.requestedRule, parentDigest: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.listPrMiningCandidates()).toEqual([]);
  } finally { await store.close(); }
}, 30_000);

it('recomputes evidence/case/request/candidate bindings on reads, including tampering with a recomputed digest', async () => {
  const fixture = miningFixture(), db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db);
  try {
    await store.importGithubPrEvidence(fixture.evidence.evidence); await store.createPrMiningRequest(fixture.input);
    const candidate = await store.importPrMiningCandidate(fixture.candidate);
    await db.exec('ALTER TABLE qe_pr_mining_candidates DISABLE TRIGGER qe_pr_mining_candidates_immutable');
    const forged = { ...candidate.candidate, evidenceDigest: 'f'.repeat(64) }, forgedDigest = digestOf(forged);
    await db.query('UPDATE qe_pr_mining_candidates SET payload=$1::jsonb,digest=$2 WHERE digest=$3', [JSON.stringify(forged), forgedDigest, candidate.digest]);
    await expect(store.getPrMiningCandidate(forgedDigest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await db.query('UPDATE qe_pr_mining_candidates SET payload=$1::jsonb,digest=$2 WHERE digest=$3', [JSON.stringify(candidate.candidate), candidate.digest, forgedDigest]);
    await db.exec('ALTER TABLE qe_problem_cases DISABLE TRIGGER qe_problem_cases_immutable');
    const labelled = { ...fixture.cases[0], expected: 'violation', provenance: { ...fixture.cases[0].provenance, reviewedBy: 'forged' } };
    await db.query('UPDATE qe_problem_cases SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(labelled), digestOf(labelled), labelled.id]);
    await expect(store.getPrMiningRequest(fixture.request.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await expect(store.getPrMiningCandidate(candidate.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await db.query('UPDATE qe_problem_cases SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(fixture.cases[0]), digestOf(fixture.cases[0]), labelled.id]);
    await db.exec('ALTER TABLE qe_pr_mining_requests DISABLE TRIGGER qe_pr_mining_requests_immutable');
    const wrong = structuredClone(fixture.request.request); wrong.statementBindings[0].digest = 'f'.repeat(64);
    const wrongDigest = digestOf(wrong);
    // Insert a forged request as a different row to leave existing FK bindings intact.
    wrong.input.id = 'forged-request';
    await db.query('INSERT INTO qe_pr_mining_requests(digest,id,evidence_digest,payload) VALUES($1,$2,$3,$4::jsonb)', [digestOf(wrong), wrong.input.id, fixture.evidence.digest, JSON.stringify(wrong)]);
    await expect(store.getPrMiningRequest(digestOf(wrong))).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    expect(wrongDigest).not.toBe(fixture.request.digest);
    await db.exec('ALTER TABLE qe_github_pr_evidence DISABLE TRIGGER qe_github_pr_evidence_immutable');
    const evidence = structuredClone(fixture.evidence.evidence); evidence.pull.body = 'Tampered';
    await db.query('UPDATE qe_github_pr_evidence SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify(evidence), fixture.evidence.digest]);
    await expect(store.getPrMiningCandidate(candidate.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  } finally { await store.close(); }
}, 30_000);

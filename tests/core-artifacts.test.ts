import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestOf } from '../src/core/index.js';
import { QualEvoStore, openPGliteDatabase, type ArtifactLink, type Database } from '../src/storage/index.js';

const evaluationId = 'artifact-evaluation';
const reference = (content: string) => {
  const digest = digestOf(content);
  return { digest, key: `sha256/${digest}`, size: Buffer.byteLength(content) };
};
const input: ArtifactLink = { evaluationId, kind: 'input', ref: reference('input bytes') };
const output: ArtifactLink = { evaluationId, kind: 'result', ref: reference('result bytes') };
async function seed(store: QualEvoStore) {
  const sourceDigest = digestOf('fixture source');
  await store.importProblemCase({
    id: 'artifact-case', lineageId: 'artifact-lineage', split: 'training', expected: 'unknown',
    title: 'Artifact persistence fixture', repository: 'fixture://artifacts', commit: 'a'.repeat(40), path: 'example.ts', sourceDigest,
    provenance: { kind: 'synthetic', reference: 'fixture:artifacts', reviewedBy: null, derivedFromCaseId: null },
  });
  const { digest } = await store.importBundle({
    schemaVersion: 1, ruleId: 'artifact-rule', version: '1',
    skill: { title: 'Artifact rule fixture', invariant: 'Test immutable links', applicability: ['Synthetic test'], exceptions: [], requiredContext: [] },
    detector: { kind: 'ast-grep', language: 'typescript', pattern: 'example($ARG)' },
    regressionCases: [{ caseId: 'artifact-case', role: 'positive' }],
    provenance: { sourceCaseIds: ['artifact-case'], parentDigest: null, author: 'fixture-author', createdAt: '2026-09-30T00:00:00Z', rationale: 'Persistence test', evidenceRefs: ['fixture:artifacts'] },
  });
  const configDigest = digestOf('offline fixture');
  const run = await store.createRun({ key: 'artifact-run', repository: 'fixture://artifacts', commit: 'a'.repeat(40), bundleDigest: digest, configDigest });
  await store.appendFinding({
    id: 'artifact-finding', runId: run.id, bundleDigest: digest, ruleId: 'artifact-rule', ruleVersion: '1', sourceDigest,
    location: { path: 'example.ts', startLine: 1, endLine: 1 }, candidateState: 'not_recalled',
    execution: { state: 'succeeded', error: null }, adjudication: null, evidenceRefs: [],
  });
  await store.createEvaluation({ id: evaluationId, bundleDigest: digest, datasetVersion: 'fixture-v1', caseIds: ['artifact-case'], configDigest, createdAt: '2026-09-30T00:00:00Z' }, [{ caseId: 'artifact-case', runId: run.id, findingId: 'artifact-finding' }]);
}
let db: Database;
let store: QualEvoStore;
beforeEach(async () => { db = await openPGliteDatabase(); store = await QualEvoStore.initialize(db); await seed(store); });
afterEach(async () => { await store.close(); });

describe('durable evaluation artifact links', () => {
  it('records input/result provenance idempotently without job-runtime state', async () => {
    expect(await store.getArtifactLinks(evaluationId)).toEqual([]);
    expect(await store.recordArtifactLink(output)).toEqual(output);
    expect(await store.recordArtifactLink(input)).toEqual(input);
    expect(await store.recordArtifactLink(input)).toEqual(input);
    expect(await store.getArtifactLinks(evaluationId)).toEqual([input, output]);
    await expect(store.recordArtifactLink({ ...input, ref: reference('changed input') })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    await expect(store.recordArtifactLink({ ...input, ref: { ...input.ref, size: input.ref.size + 1 } })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  });
  it('validates digest, exact key and bounded integer size', async () => {
    const invalid = [
      { ...input.ref, key: '../escape' },
      { ...input.ref, key: `sha256/${'b'.repeat(64)}` },
      { ...input.ref, digest: 'BAD' },
      { ...input.ref, size: -1 },
      { ...input.ref, size: 1.5 },
      { ...input.ref, size: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const ref of invalid) await expect(store.recordArtifactLink({ ...input, ref })).rejects.toThrow();
    expect(await store.getArtifactLinks(evaluationId)).toEqual([]);
  });
  it('requires an existing evaluation with a database foreign key', async () => {
    await expect(store.recordArtifactLink({ ...input, evaluationId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.getArtifactLinks('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(db.query('INSERT INTO qe_artifact_links(evaluation_id,kind,digest,object_key,size_bytes) VALUES($1,$2,$3,$4,$5)', ['missing', input.kind, input.ref.digest, input.ref.key, input.ref.size])).rejects.toThrow('foreign key');
  });
  it('enforces append-only links and key integrity at SQL level', async () => {
    await store.recordArtifactLink(input);
    await expect(db.query('UPDATE qe_artifact_links SET size_bytes=0 WHERE evaluation_id=$1', [evaluationId])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM qe_artifact_links WHERE evaluation_id=$1', [evaluationId])).rejects.toThrow('append-only');
    await expect(db.query('INSERT INTO qe_artifact_links(evaluation_id,kind,digest,object_key,size_bytes) VALUES($1,$2,$3,$4,$5)', [evaluationId, 'result', output.ref.digest, 'arbitrary-key', output.ref.size])).rejects.toThrow('check constraint');
  });
  it('rejects concurrent conflicting mappings rather than overwriting one', async () => {
    const outcomes = await Promise.allSettled([
      store.recordArtifactLink(input),
      store.recordArtifactLink({ ...input, ref: reference('competing bytes') }),
    ]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(value => value.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    expect(await store.getArtifactLinks(evaluationId)).toHaveLength(1);
  });
  it('retains references when the database reopens independently of completed jobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flyrewheel-artifact-db-'));
    let disk: QualEvoStore | undefined;
    try {
      disk = await QualEvoStore.openPGlite(directory);
      await seed(disk);
      await disk.recordArtifactLink(input);
      await disk.recordArtifactLink(output);
      await disk.close(); disk = undefined;
      disk = await QualEvoStore.openPGlite(directory);
      expect(await disk.getArtifactLinks(evaluationId)).toEqual([input, output]);
      expect(await disk.recordArtifactLink(input)).toEqual(input);
    } finally {
      if (disk) await disk.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

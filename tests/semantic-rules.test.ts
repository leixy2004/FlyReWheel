import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import {
  bundleDigest, digestOf, ruleVersionDigest, matchesRuleScope, SemanticRuleVersionSchema,
  RuleVersionSchema, RuleBundleSchema, DEFAULT_PROMOTION_POLICY,
  type SemanticRuleVersion, type RuleBundle, type ProblemCase,
} from '../src/core/index.js';
import { QualEvoStore, openPGliteDatabase, type Database } from '../src/storage/index.js';
import { ownPendingResource, withFreshPGlite, withCleanup, DATABASE_SETUP_TIMEOUT } from './helpers/fresh-pglite.js';
import { demoInputs } from '../src/demo.js';
import { replayDataset } from '../src/pipeline.js';
import { ReplayJobSchema } from '../src/jobs.js';

const example = JSON.parse(await readFile(new URL('../examples/semantic-rule-v2.json', import.meta.url), 'utf8')) as SemanticRuleVersion;
const sourceCase = JSON.parse(await readFile(new URL('../examples/semantic-rule-cases.json', import.meta.url), 'utf8'))[0] as ProblemCase;
const rule = () => structuredClone(example);
function legacy(): RuleBundle {
  return {
    schemaVersion: 1, ruleId: example.ruleId, version: 'legacy-1',
    skill: { title: 'Synthetic legacy rule', invariant: 'Waits need deadlines', applicability: ['Synthetic wait'], exceptions: [], requiredContext: ['caller'] },
    detector: { kind: 'ast-grep', language: 'typescript', pattern: 'waitUntilReady()' },
    regressionCases: [{ caseId: sourceCase.id, role: 'positive' }],
    provenance: { sourceCaseIds: [sourceCase.id], parentDigest: null, author: 'synthetic-author', createdAt: example.provenance.createdAt, rationale: 'Unassessed fixture', evidenceRefs: ['fixture:semantic-rule-example'] },
  };
}

describe('semantic version schema and exact identity', () => {
  it('accepts semantic-only, empty and multiple detector assets without manufacturing a projection', () => {
    expect(SemanticRuleVersionSchema.parse(rule())).not.toHaveProperty('detectionAssets');
    expect(SemanticRuleVersionSchema.parse({ ...rule(), detectionAssets: [] }).detectionAssets).toEqual([]);
    const assets = [
      { id: 'wait-calls', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'waitUntilReady()' } },
      { id: 'python-waits', detector: { kind: 'opengrep', language: 'python', yaml: 'rules: []' } },
    ];
    expect(SemanticRuleVersionSchema.parse({ ...rule(), detectionAssets: assets }).detectionAssets).toEqual(assets);
    expect(() => SemanticRuleVersionSchema.parse({ ...rule(), detectionAssets: [assets[0], assets[0]] })).toThrow('Duplicate detection asset IDs');
    expect(() => SemanticRuleVersionSchema.parse({ ...rule(), detectionAssets: [{ id: 'shell', detector: { kind: 'shell', command: 'run-anything' } }] })).toThrow();
  });
  it('binds semantics, scope, provenance and optional asset content in the immutable digest', () => {
    const original = rule();
    const hash = ruleVersionDigest(original);
    const mutations: SemanticRuleVersion[] = [
      { ...rule(), semantics: { ...rule().semantics, mechanism: 'A different failure mechanism' } },
      { ...rule(), scope: { ...rule().scope, repositories: ['synthetic:another-repository'] } },
      { ...rule(), provenance: { ...rule().provenance, rationale: 'Different provenance rationale' } },
      { ...rule(), detectionAssets: [] },
      { ...rule(), detectionAssets: [{ id: 'wait-calls', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'waitUntilReady()' } }] },
    ];
    for (const value of mutations) expect(ruleVersionDigest(value)).not.toBe(hash);
    expect(ruleVersionDigest(Object.fromEntries(Object.entries(original).reverse()) as SemanticRuleVersion)).toBe(hash);
  });
  it('retains v1 schemas and digests without conversion or schema guessing', () => {
    const v1 = legacy();
    expect(RuleVersionSchema.parse(v1)).toEqual(v1);
    expect(ruleVersionDigest(v1)).toBe(bundleDigest(v1));
    expect(() => RuleBundleSchema.parse(rule())).toThrow();
    expect(() => SemanticRuleVersionSchema.parse(v1)).toThrow();
    expect(() => RuleVersionSchema.parse({ ...rule(), schemaVersion: 3 })).toThrow();
    expect(() => RuleVersionSchema.parse({ ...rule(), detector: v1.detector })).toThrow();
    expect(() => RuleVersionSchema.parse({ ...rule(), semantics: { ...rule().semantics, mechanism: ' ' } })).toThrow();
  });
  it('requires full exact source commits and nonempty unique source provenance', () => {
    const value = rule();
    for (const commit of ['abc1234', 'A'.repeat(40), 'a'.repeat(64), 'HEAD']) {
      value.provenance.sourceCases[0].commit = commit;
      expect(() => SemanticRuleVersionSchema.parse(value)).toThrow('Git SHA-1');
    }
    expect(() => SemanticRuleVersionSchema.parse({ ...rule(), provenance: { ...rule().provenance, sourceCases: [] } })).toThrow();
    const sources = rule().provenance.sourceCases;
    expect(() => SemanticRuleVersionSchema.parse({ ...rule(), provenance: { ...rule().provenance, sourceCases: [...sources, ...sources] } })).toThrow('Duplicate source cases');
  });
  it('matches exact repository identities and literal paths/subtrees with exclusions', () => {
    const scope = rule().scope;
    const repo = scope.repositories[0];
    expect(matchesRuleScope(scope, repo, 'src/worker.ts')).toBe(true);
    expect(matchesRuleScope(scope, repo, 'src/generated/types.ts')).toBe(false);
    expect(matchesRuleScope(scope, repo, 'src-generated/worker.ts')).toBe(false);
    expect(matchesRuleScope(scope, repo + '-fork', 'src/worker.ts')).toBe(false);
    const exact = { ...scope, paths: { include: ['src/worker.ts'], exclude: [] } };
    expect(matchesRuleScope(exact, repo, 'src/worker.ts')).toBe(true);
    expect(matchesRuleScope(exact, repo, 'src/worker.tsx')).toBe(false);
    expect(matchesRuleScope({ ...scope, paths: { include: ['.'], exclude: ['tests'] } }, repo, 'worker.ts')).toBe(true);
  });
  it('rejects unsafe or ambiguous paths, glob syntax, empty scope and padded repository IDs', () => {
    for (const path of ['/src', '../src', 'src/../other', './src', 'src//x', 'src/', 'C:/src', 'src\\x', 'src/**', 'src/[x]', 'src\u0000x', ' src']) {
      expect(() => SemanticRuleVersionSchema.parse({ ...rule(), scope: { ...rule().scope, paths: { include: [path], exclude: [] } } })).toThrow();
      expect(() => matchesRuleScope(rule().scope, sourceCase.repository, path)).toThrow();
    }
    for (const paths of [{ include: [], exclude: [] }, { include: ['src'], exclude: ['.'] }, { include: ['src'], exclude: ['src'] }, { include: ['src', 'src'], exclude: [] }]) {
      expect(() => SemanticRuleVersionSchema.parse({ ...rule(), scope: { ...rule().scope, paths } })).toThrow();
    }
    for (const repositories of [[], ['   '], ['repo', 'repo'], [' repo'], ['repo\n']]) {
      expect(() => SemanticRuleVersionSchema.parse({ ...rule(), scope: { ...rule().scope, repositories } })).toThrow();
    }
  });
});

let db: Database;
let store: QualEvoStore;
describe('semantic versions in the existing append-only store', () => {
  beforeEach(async () => { db = await openPGliteDatabase(); store = await QualEvoStore.initialize(db); });
  afterEach(async () => { await store.close(); });

  it('atomically imports semantic-only rules and sources, then retrieves and lists exact versions', async () => {
    const stored = await store.importRuleVersion(rule(), [sourceCase]);
    expect(stored).toEqual({ digest: ruleVersionDigest(rule()), rule: rule() });
    expect(await store.getRuleVersion(stored.digest)).toEqual(stored);
    expect(await store.importRuleVersion(rule(), [sourceCase])).toEqual(stored);
    expect(await store.listRuleVersions()).toEqual([stored]);
    expect(await store.listRuleVersions(rule().ruleId)).toEqual([stored]);
    expect(await store.listRuleVersions('missing')).toEqual([]);
    expect((await store.getProblemCase(sourceCase.id)).expected).toBe('unknown');
    expect((await store.getProblemCase(sourceCase.id)).provenance.reviewedBy).toBeNull();
    expect(await store.getActive(rule().ruleId)).toBeNull();
    stored.rule.version = 'changed returned object';
    expect((await store.getRuleVersion(stored.digest)).rule.version).toBe(rule().version);
  });
  it('rejects changed semantic, scope or asset content under the same logical version', async () => {
    const stored = await store.importRuleVersion(rule(), [sourceCase]);
    for (const changed of [
      { ...rule(), semantics: { ...rule().semantics, expectedBehavior: 'A different expectation' } },
      { ...rule(), scope: { ...rule().scope, paths: { include: ['lib'], exclude: [] } } },
      { ...rule(), detectionAssets: [] },
    ]) await expect(store.importRuleVersion(changed)).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    await expect(db.query("UPDATE qe_rule_bundles SET payload='{}'::jsonb WHERE digest=$1", [stored.digest])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM qe_rule_bundles WHERE digest=$1', [stored.digest])).rejects.toThrow('append-only');
  });
  it('preserves exact parents and rejects missing, cross-rule, disconnected and self ancestry', async () => {
    const first = await store.importRuleVersion(rule(), [sourceCase]);
    const child = { ...rule(), version: 'draft-2', provenance: { ...rule().provenance, parentDigest: first.digest }, detectionAssets: [] };
    const second = await store.importRuleVersion(child);
    expect((await store.getRuleVersion(second.digest)).rule.provenance.parentDigest).toBe(first.digest);
    expect((await store.getRuleVersion(first.digest)).rule).toEqual(rule());
    await expect(store.importRuleVersion({ ...child, version: 'draft-3', provenance: { ...child.provenance, parentDigest: null } })).rejects.toMatchObject({ code: 'INVALID_LINEAGE' });
    await expect(store.importRuleVersion({ ...child, ruleId: 'another-rule' })).rejects.toMatchObject({ code: 'INVALID_LINEAGE' });
    await expect(store.importRuleVersion({ ...child, provenance: { ...child.provenance, parentDigest: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    await expect(store.importRuleVersion({ ...child, version: 'draft-3', provenance: { ...child.provenance, parentDigest: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Reusing the parent's logical identity with a self-referential payload cannot overwrite it.
    await expect(store.importRuleVersion({ ...rule(), provenance: { ...rule().provenance, parentDigest: first.digest } })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  });
  it('shares one namespace with unchanged v1, permits explicit v1-to-v2 lineage and rejects downgrade', async () => {
    const v1 = legacy();
    const first = await store.importRuleVersion(v1, [sourceCase]);
    expect(await store.getBundle(first.digest)).toEqual({ digest: bundleDigest(v1), bundle: v1 });
    expect(await store.importBundle(v1)).toEqual({ digest: first.digest, bundle: v1 });
    await expect(store.importRuleVersion({ ...rule(), version: v1.version })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    const v2 = { ...rule(), provenance: { ...rule().provenance, parentDigest: first.digest } };
    const second = await store.importRuleVersion(v2);
    await expect(store.getBundle(second.digest)).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
    await expect(store.importBundle({ ...v1, version: 'legacy-2', provenance: { ...v1.provenance, parentDigest: second.digest } })).rejects.toMatchObject({ code: 'INVALID_LINEAGE' });
    expect((await store.listRuleVersions()).map(item => item.rule.schemaVersion).sort()).toEqual([1, 2]);
  });
  it('checks source repository, commit, path and content digest against the stored case', async () => {
    await store.importProblemCase(sourceCase);
    for (const changed of [{ repository: 'synthetic:wrong' }, { commit: 'b'.repeat(40) }, { path: 'src/other.ts' }, { sourceDigest: 'b'.repeat(64) }]) {
      const input = rule(); input.provenance.sourceCases[0] = { ...input.provenance.sourceCases[0], ...changed };
      await expect(store.importRuleVersion(input)).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    }
    const missing = rule(); missing.provenance.sourceCases[0].caseId = 'missing';
    await expect(store.importRuleVersion(missing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.listRuleVersions()).toEqual([]);
  });
  it('rolls back case and lineage imports on rule failure, including a late case conflict', async () => {
    const invalid = rule(); invalid.provenance.sourceCases[0].commit = 'b'.repeat(40);
    await expect(store.importRuleVersion(invalid, [sourceCase])).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    await expect(store.getProblemCase(sourceCase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await db.query('SELECT id FROM qe_case_lineages')).rows).toEqual([]);
    await expect(store.importRuleVersion(rule(), [sourceCase, { ...sourceCase, title: 'conflicting second case' }])).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    await expect(store.getProblemCase(sourceCase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.listRuleVersions()).toEqual([]);
  });
  it('rejects heldout source and regression cases without committing supplied cases', async () => {
    await expect(store.importRuleVersion(rule(), [{ ...sourceCase, split: 'holdout' }])).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
    const heldout = { ...sourceCase, id: 'heldout', lineageId: 'heldout-lineage', sourceDigest: 'c'.repeat(64), split: 'holdout' as const };
    const input = { ...rule(), regressionCases: [{ caseId: heldout.id, role: 'positive' as const }] };
    await expect(store.importRuleVersion(input, [sourceCase, heldout])).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
    await expect(store.getProblemCase(sourceCase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('serializes competing root/version writes instead of replacing content', async () => {
    const results = await Promise.allSettled([
      store.importRuleVersion(rule(), [sourceCase]),
      store.importRuleVersion({ ...rule(), semantics: { ...rule().semantics, title: 'Competing title' } }, [sourceCase]),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await store.listRuleVersions()).toHaveLength(1);
  });
  it('fails closed before replay, queueing, run creation, evaluation or promotion of v2', async () => {
    const saved = await store.importRuleVersion(rule(), [sourceCase]);
    const identity = { key: 'semantic-run', repository: sourceCase.repository, commit: sourceCase.commit, bundleDigest: saved.digest, configDigest: digestOf('test-config') };
    const manifest = { id: 'semantic-evaluation', bundleDigest: saved.digest, datasetVersion: 'test', caseIds: [sourceCase.id], configDigest: identity.configDigest, createdAt: example.provenance.createdAt };
    const proposal = { id: 'semantic-promotion', ruleId: example.ruleId, bundleDigest: saved.digest, evaluationId: manifest.id, expectedActiveDigest: null, policy: DEFAULT_PROMOTION_POLICY };
    await expect(store.createRun(identity)).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
    await expect(store.createEvaluation(manifest, [])).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
    await expect(store.proposePromotion(proposal)).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
    const { dataset } = demoInputs();
    await expect(replayDataset({ store, bundle: rule() as unknown as RuleBundle, dataset, mode: 'offline_fixture' })).rejects.toThrow();
    expect(() => ReplayJobSchema.parse({ bundle: rule(), dataset, mode: 'offline_fixture' })).toThrow();

    // Raw SQL can insert structurally linked future records. Legacy readers must still reject v2.
    await db.query('INSERT INTO qe_runs(id,run_key,bundle_digest,payload) VALUES($1,$2,$3,$4::jsonb)', ['raw-run', identity.key, saved.digest, JSON.stringify(identity)]);
    await db.query('INSERT INTO qe_evaluations(id,bundle_digest,payload_digest,payload) VALUES($1,$2,$3,$4::jsonb)', [manifest.id, saved.digest, digestOf(manifest), JSON.stringify({ manifest, results: [] })]);
    await db.query('INSERT INTO qe_proposals(id,rule_id,bundle_digest,evaluation_id,payload_digest,evidence_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [proposal.id, proposal.ruleId, saved.digest, manifest.id, digestOf(proposal), digestOf('test-evidence'), JSON.stringify({ proposal, report: {} })]);
    await db.query('INSERT INTO qe_active_rules(rule_id,bundle_digest) VALUES($1,$2)', [example.ruleId, saved.digest]);
    for (const read of [
      () => store.getRun('raw-run'), () => store.listFindings('raw-run'),
      () => store.getEvaluation(manifest.id), () => store.evaluate(manifest.id, DEFAULT_PROMOTION_POLICY),
      () => store.getProposal(proposal.id), () => store.approvePromotion({ proposalId: proposal.id, expectedActiveDigest: null, actor: 'synthetic-actor' }),
      () => store.getActive(example.ruleId), () => store.getArtifactLinks(manifest.id),
    ]) await expect(read()).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
  });
  it('rejects a persisted payload whose content digest or logical identity does not match', async () => {
    const input = rule();
    const hash = ruleVersionDigest(input);
    await db.query('INSERT INTO qe_rule_bundles(digest,rule_id,version,payload) VALUES($1,$2,$3,$4::jsonb)', [hash, input.ruleId, input.version, JSON.stringify({ ...input, semantics: { ...input.semantics, title: 'Tampered content' } })]);
    await expect(store.getRuleVersion(hash)).rejects.toMatchObject({ code: 'CORRUPT_RULE_VERSION' });
    await expect(store.listRuleVersions()).rejects.toMatchObject({ code: 'CORRUPT_RULE_VERSION' });
  });
});

// Initial allocation is setup; close/reopen and all identity assertions remain in
// the original behavioral budget. This suite does not allocate the unused memory DB.
describe('disk semantic version recovery', () => {
  interface DiskResource {
    directory: string;
    initial: QualEvoStore;
    disposed: boolean;
    reopening?: ReturnType<typeof ownPendingResource<QualEvoStore>>;
  }
  const resources = new WeakMap<TestContext['task'], DiskResource>();
  aroundEach(async (runTest, context) => {
    const directory = await mkdtemp(join(tmpdir(), 'semantic-rules-db-'));
    await withCleanup(async () => {
      await withFreshPGlite(async ({ store }) => {
        const resource: DiskResource = { directory, initial: store, disposed: false };
        resources.set(context.task, resource);
        try { await runTest(); }
        finally {
          resource.disposed = true;
          resources.delete(context.task);
          // Wait for a pending reopen before closing it or removing its directory.
          await resource.reopening?.close();
        }
      }, directory);
    }, () => rm(directory, { recursive: true, force: true }));
  }, DATABASE_SETUP_TIMEOUT);
  it('reopens a disk database with mixed v1/v2 versions and all exact identities intact', async context => {
    const resource = resources.get(context.task)!;
    let disk = resource.initial;
    const first = await disk.importRuleVersion(legacy(), [sourceCase]);
    const next: SemanticRuleVersion = {
      ...rule(), provenance: { ...rule().provenance, parentDigest: first.digest },
      detectionAssets: [
        { id: 'typescript-waits', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'waitUntilReady()' } },
        { id: 'python-waits', detector: { kind: 'semgrep', language: 'python', yaml: 'rules: []' } },
      ],
    };
    const second = await disk.importRuleVersion(next);
    await disk.close();
    if (resource.disposed) throw new Error('Test ended before disk reopen could start');
    resource.reopening = ownPendingResource(QualEvoStore.openPGlite(resource.directory), reopened => reopened.close());
    disk = await resource.reopening.value();
    expect(await disk.getRuleVersion(first.digest)).toEqual(first);
    expect(await disk.getRuleVersion(second.digest)).toEqual(second);
    expect(await disk.importRuleVersion(next)).toEqual(second);
    expect(await disk.listRuleVersions(example.ruleId)).toHaveLength(2);
  });
});

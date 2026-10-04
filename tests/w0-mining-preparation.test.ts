import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MEMBERS, prepareW0Mining, validateFrozenPackage } from '../scripts/prepare-w0-mining.js';
import { buildPrMiningModelInput } from '../src/adapters/pr-mining-model.js';
import { QualEvoStore } from '../src/storage/store.js';

it('rejects changed package bytes against the frozen capture before import', async () => {
  const bytes = await readFile(new URL('../experiments/temporal-pilot/w0-first-three/proxy-attempt-1/package-3035.json', import.meta.url));
  expect(validateFrozenPackage(bytes, MEMBERS[0]).evidence.evidence.pull.number).toBe(3035);
  expect(() => validateFrozenPackage(Buffer.concat([bytes, Buffer.from('\n')]), MEMBERS[0])).toThrow('FROZEN_PACKAGE_BYTES_CHANGED');
  expect(() => validateFrozenPackage(bytes, MEMBERS[1])).toThrow('FROZEN_PACKAGE_BYTES_CHANGED');
});

it('prepares real W0 packages offline, survives reopen, rejects rebinding and existing stores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'w0-preparation-test-'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NETWORK_FORBIDDEN'); });
  let store: QualEvoStore | undefined;
  try {
    const report = await prepareW0Mining(join(root, 'db'), join(root, 'out'));
    expect(report.counts).toEqual({ qe_github_pr_evidence: 3, qe_pr_mining_requests: 3, qe_problem_cases: 8,
      qe_pr_mining_candidates: 0, qe_rule_bundles: 0, qe_feedback: 0, qe_semantic_review_feedback: 0 });
    expect(report.items.map(item => item.number)).toEqual([3035, 3031, 3036]);
    expect(report.reopenedAndVerified).toBe(true);
    await expect(prepareW0Mining(join(root, 'db'), join(root, 'out'))).rejects.toMatchObject({ code: 'EEXIST' });
    store = await QualEvoStore.openPGlite(join(root, 'db'));
    for (const item of report.items) {
      const request = await store.getPrMiningRequest(item.requestDigest);
      const evidence = await store.getGithubPrEvidence(item.evidenceDigest);
      const raw = { request, evidence, candidateId: 'test-unexecuted', candidateCreatedAt: report.createdAt, context: { kind: 'selected-evidence' as const } };
      const prepared = buildPrMiningModelInput(raw, { model: 'unconfigured-test' });
      expect(prepared.cases.every(c => c.expected === 'unknown')).toBe(true);
      expect(prepared.generation.prompt).toContain('"fullRepositoryAvailable":false');
      expect(request.request.statementBindings.map(b => b.selection)).toEqual([{ kind: 'pull' }]);
      const changed = structuredClone(raw);
      changed.request.request.sourceBindings[0]!.commit = 'f'.repeat(40);
      expect(() => buildPrMiningModelInput(changed, { model: 'unconfigured-test' })).toThrow();
      const exported = JSON.parse(await readFile(join(root, 'out', `generation-template-${item.number}.json`), 'utf8'));
      expect(exported.model).toBeNull();
      expect(exported.executable).toBe(false);
      expect(exported.generationTemplate.model).toBeUndefined();
      expect(exported.generationTemplate.prompt).toBe(prepared.generation.prompt);
      const committed = JSON.parse(await readFile(new URL(`../experiments/temporal-pilot/w0-first-three/mining-preparation/request-${item.number}.json`, import.meta.url), 'utf8'));
      expect(request).toEqual(committed);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { await store?.close(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

it('preserves reopen failures without closing an already released store again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'w0-reopen-failure-'));
  const primary = new Error('REOPEN_FAILURE');
  const initialize = QualEvoStore.initialize.bind(QualEvoStore);
  let closeCalls = 0;
  const init = vi.spyOn(QualEvoStore, 'initialize').mockImplementation(async db => {
    const store = await initialize(db);
    const close = store.close.bind(store);
    vi.spyOn(store, 'close').mockImplementation(async () => {
      if (++closeCalls > 1) throw new Error('SECOND_CLOSE_FAILURE');
      await close();
    });
    return store;
  });
  const reopen = vi.spyOn(QualEvoStore, 'openPGlite').mockRejectedValue(primary);
  try {
    await expect(prepareW0Mining(join(root, 'db'), join(root, 'out'))).rejects.toBe(primary);
    expect(closeCalls).toBe(1);
    await expect(readFile(join(root, 'out', 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    init.mockRestore(); reopen.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('preserves an import failure when cleanup also fails and emits no completion ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'w0-import-failure-'));
  const primary = new Error('IMPORT_FAILURE');
  const initialize = QualEvoStore.initialize.bind(QualEvoStore);
  let closeCalls = 0;
  const init = vi.spyOn(QualEvoStore, 'initialize').mockImplementation(async db => {
    const store = await initialize(db);
    const close = store.close.bind(store);
    vi.spyOn(store, 'importGithubPrEvidence').mockRejectedValue(primary);
    vi.spyOn(store, 'close').mockImplementation(async () => {
      closeCalls++;
      await close();
      throw new Error('CLEANUP_FAILURE');
    });
    return store;
  });
  try {
    await expect(prepareW0Mining(join(root, 'db'), join(root, 'out'))).rejects.toBe(primary);
    expect(closeCalls).toBe(1);
    await expect(readFile(join(root, 'out', 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    init.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('reports cleanup-only failure after successful reopen and emits no completion ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'w0-cleanup-only-'));
  const cleanupFailure = new Error('CLEANUP_ONLY_FAILURE');
  const open = QualEvoStore.openPGlite.bind(QualEvoStore);
  let closeCalls = 0;
  const reopen = vi.spyOn(QualEvoStore, 'openPGlite').mockImplementation(async path => {
    const store = await open(path);
    const close = store.close.bind(store);
    vi.spyOn(store, 'close').mockImplementation(async () => {
      closeCalls++;
      await close();
      throw cleanupFailure;
    });
    return store;
  });
  try {
    await expect(prepareW0Mining(join(root, 'db'), join(root, 'out'))).rejects.toBe(cleanupFailure);
    expect(closeCalls).toBe(1);
    await expect(readFile(join(root, 'out', 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    reopen.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { runLocalClosedLoop } from '../src/local-closed-loop.js';
import { QualEvoStore } from '../src/storage/store.js';
import { sourceDigest } from '../src/adapters/candidates.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const cli = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 60000, maxBuffer: 2_000_000 });
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

it('runs one explicit fixture-only CLI, preserves exact historical provenance, reopens and reruns idempotently, and detects artifact corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'closed-loop-cli-')), outDir = join(directory, 'report'), db = join(directory, 'database');
  try {
    const args = ['closed-loop', 'demo', '--out-dir', outDir, '--db', db];
    const first = JSON.parse((await cli(args)).stdout);
    expect(first).toMatchObject({ status: 'succeeded', stage: 'complete', mode: 'authored-fixture-only', modelExecution: 'not_run', isolation: 'not_verified',
      checks: { reopenedIdentically: true, humanVerdicts: 'Unknown', activation: 'not_performed', futureBytesExcludedFromMiningPrompt: true } });
    expect(first.outcomes.map((item: any) => [item.summary.status, item.localDecision, item.activation])).toEqual([
      ['compatible', 'accept', 'not_performed'], ['regressed', 'reject', 'not_performed'],
    ]);
    expect(first.outcomes[0].summary).toMatchObject({ preserved: 1, corrected: 1, regressed: 0 });
    expect(first.outcomes[1]).toMatchObject({ acceptance: 'blocked-as-expected', summary: { regressed: 1, corrected: 1 } });
    expect(first.artifacts).toHaveLength(33);
    for (const artifact of first.artifacts) {
      const bytes = await readFile(join(outDir, artifact.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
      expect(bytes.length).toBe(artifact.byteLength);
    }
    const historical = await json(join(outDir, 'artifacts/historical-snapshot.json'));
    const target = await json(join(outDir, 'artifacts/target-snapshot.json'));
    expect(historical.snapshot.head).toBe(target.snapshot.baseTip);
    expect(historical.snapshot.head).not.toBe(target.snapshot.head);
    const base = await json(join(outDir, 'artifacts/base-rule.json'));
    expect(base.rule.regressionCases).toEqual([]);
    expect(base.rule.provenance.sourceCases.map((item: any) => item.commit)).toEqual([first.history.base, first.history.historicalFix]);
    for (const side of ['before', 'after']) expect((await json(join(outDir, `artifacts/mining-source-${side}.json`))).expected).toBe('unknown');
    for (const scenario of ['compatible', 'regressed']) {
      const candidate = await json(join(outDir, `artifacts/${scenario}-revision-candidate.json`));
      expect(candidate.candidate).toMatchObject({ source: 'fixture', synthesis: 'not_run', activation: 'not_performed',
        executionReceipt: { modelExecution: 'not_run', cleanup: 'verified', workerResult: { outputContract: 'rule-revision-v2', boundary: 'authored-test-no-isolation', processEvidence: { processGroupStopped: true } } } });
      const revised = await json(join(outDir, `artifacts/${scenario}-rule.json`));
      expect(revised.rule.provenance.sourceCases).toEqual(base.rule.provenance.sourceCases);
      expect(revised.rule.provenance.parentDigest).toBe(base.digest);
      expect((await json(join(outDir, `artifacts/${scenario}-revision-request.json`))).request).toMatchObject({ status: 'pending', synthesis: 'not_run', source: 'fixture' });
    }
    const attemptsBefore = await readdir(join(outDir, 'runtime'));
    expect(JSON.parse((await cli(args)).stdout)).toEqual(first);
    expect(await readdir(join(outDir, 'runtime'))).toEqual(attemptsBefore);
    const shown = JSON.parse((await cli(['rules', 'show', '--digest', first.evidence.baseRuleDigest, '--db', db])).stdout);
    expect(shown).toEqual(base);
    const store = await QualEvoStore.openPGlite(db);
    try {
      expect(await store.listRevisionCandidates()).toHaveLength(2);
      const source = target.snapshot.changes[0].after;
      await expect(store.importProblemCase({ id: 'attempted-heldout-alias', lineageId: 'heldout-alias', split: 'holdout', expected: 'unknown', title: 'Source guard check',
        repository: first.history.repository, commit: first.history.target, path: source.path, sourceDigest: source.sha256,
        provenance: { kind: 'synthetic', reference: 'fixture:holdout-alias', reviewedBy: null, derivedFromCaseId: null } })).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
    } finally { await store.close(); }
    const file = join(outDir, 'artifacts/base-rule.json'), original = await readFile(file);
    await writeFile(file, '{}\n');
    await expect(cli(args)).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Immutable artifact differs') });
    expect(await json(join(outDir, 'report.json'))).toMatchObject({ status: 'failed', stage: 'authored-mining-proposal' });
    await writeFile(file, original);
    expect(JSON.parse((await cli(args)).stdout)).toEqual(first);
    await expect(cli([...args, '--enable-model'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unknown option') });
    expect(await json(join(outDir, 'report.json'))).toEqual(first);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120000);

it('retains an honest failed checkpoint and safely resumes after a local decision write fails without rerunning an accepted generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'closed-loop-resume-')), outDir = join(directory, 'report');
  const original = QualEvoStore.prototype.recordRevisionDecision;
  const spy = vi.spyOn(QualEvoStore.prototype, 'recordRevisionDecision').mockImplementationOnce(async () => { throw new Error('Injected local decision storage failure'); });
  try {
    await expect(runLocalClosedLoop({ outDir })).rejects.toThrow('Injected local decision storage failure');
    expect(await json(join(outDir, 'report.json'))).toMatchObject({ status: 'failed', stage: 'compatible-comparison-and-decision' });
    const candidate = await json(join(outDir, 'artifacts/compatible-revision-candidate.json'));
    expect(await readdir(join(outDir, 'runtime'))).toHaveLength(1);
    spy.mockImplementation(original);
    const report = await runLocalClosedLoop({ outDir });
    expect(report.status).toBe('succeeded');
    expect(await json(join(outDir, 'artifacts/compatible-revision-candidate.json'))).toEqual(candidate);
    expect(await readdir(join(outDir, 'runtime'))).toHaveLength(2);
    expect(await readdir(outDir)).not.toContain('.running');
  } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
}, 60000);

it('keeps a pre-registered heldout target out of generation and never emits a successful partial loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'closed-loop-holdout-')), db = join(directory, 'database'), outDir = join(directory, 'report');
  const source = '// Authored fixture policy: protected reads require isAuthorized().\nexport function positive() { return dangerousRead(); }\n';
  const store = await QualEvoStore.openPGlite(db);
  try {
    await store.importProblemCase({ id: 'preexisting-heldout', lineageId: 'heldout', split: 'holdout', expected: 'unknown', title: 'Heldout source guard', repository: 'fixture:separate',
      commit: 'f'.repeat(40), path: 'elsewhere.ts', sourceDigest: sourceDigest(source), provenance: { kind: 'synthetic', reference: 'fixture:heldout', reviewedBy: null, derivedFromCaseId: null } });
  } finally { await store.close(); }
  try {
    await expect(runLocalClosedLoop({ outDir, db })).rejects.toThrow('registered heldout sources');
    const report = await json(join(outDir, 'report.json'));
    expect(report).toMatchObject({ status: 'failed', stage: 'compatible-revision-generation' });
    expect(report).not.toHaveProperty('checks');
    const reopened = await QualEvoStore.openPGlite(db);
    try { expect(await reopened.listRevisionCandidates()).toHaveLength(0); expect(await reopened.listRevisionDecisions()).toHaveLength(0); }
    finally { await reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);

it('rejects unrelated output contents, overlapping databases, conflicting run ownership and concurrent locks without deleting data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'closed-loop-paths-'));
  try {
    const unrelated = join(directory, 'unrelated'); await mkdir(unrelated); await writeFile(join(unrelated, 'keep'), 'keep');
    await expect(runLocalClosedLoop({ outDir: unrelated })).rejects.toThrow('empty --out-dir');
    expect(await readFile(join(unrelated, 'keep'), 'utf8')).toBe('keep');
    const outDir = join(directory, 'output');
    await expect(runLocalClosedLoop({ outDir, db: outDir })).rejects.toThrow('non-overlapping');
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'local-closed-loop-fixture-v1', database: join(outDir, 'db') }));
    await mkdir(join(outDir, '.running'));
    await expect(runLocalClosedLoop({ outDir })).rejects.toThrow('already running');
    await expect(runLocalClosedLoop({ outDir, db: join(directory, 'another-db') })).rejects.toThrow('different demo/database');
    expect(await readdir(outDir)).toEqual(expect.arrayContaining(['manifest.json', '.running']));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

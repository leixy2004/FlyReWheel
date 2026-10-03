import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { type SemanticRuleVersion } from '../src/core/semantic-rule.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const examplePath = join(root, 'examples/semantic-rule-v2.json');
const casesPath = join(root, 'examples/semantic-rule-cases.json');
// No ambient service credentials are available, and misleading model configuration must be ignored.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|^CODEX_|^OPENAI_|^QE_|^DATABASE_URL$/.test(key)));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
  cwd: root, timeout: 30_000, maxBuffer: 6_000_000,
  env: { ...env, QE_ENABLE_MODEL: 'true', QE_CODEX_AUTH_MODE: 'not-configured', QE_CODEX_MODEL: 'must-not-run' },
});
const parsed = async (args: string[]) => JSON.parse((await run(args)).stdout);
const trust = { identityVerification: 'caller-declared-unverified', eligibility: 'local-experimental-review-only', productionActivation: 'not_performed', certification: 'none' };
const command = (ruleDigest: string, scopeDigest: string, id: string, action: string, expectedHeadDigest: string | null) => ({
  id, namespace: 'local-semantic-review', ruleDigest, scopeDigest, expectedHeadDigest, action,
  actor: 'Synthetic CLI operator; identity unverified', source: 'fixture',
  reason: 'Explicit local selection declaration only.\n  No semantic correctness claim.\n', createdAt: '2026-10-02T00:00:00Z',
});

it('persists the explicit root lifecycle, immutable history and scope-filtered selection across separate CLI processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-governance-cli-')), db = join(directory, 'db');
  try {
    const imported = await parsed(['rules', 'import', '--rule', examplePath, '--cases', casesPath, '--db', db]);
    const rule = imported.rule as SemanticRuleVersion, scopeDigest = digestOf(rule.scope);
    const file = join(directory, 'command.json'), out = join(directory, 'out.json');
    const apply = async (value: Record<string, unknown>) => {
      await writeFile(file, JSON.stringify(value));
      return parsed(['rules', 'governance', 'apply', '--file', file, '--db', db]);
    };
    const show = () => parsed(['rules', 'governance', 'show', '--rule-id', rule.ruleId, '--db', db]);
    const history = () => parsed(['rules', 'governance', 'history', '--rule-id', rule.ruleId, '--db', db]);
    const select = (repository = rule.scope.repositories[0], paths = ['src/worker.ts']) => parsed([
      'rules', 'governance', 'select', '--repository', repository, ...paths.flatMap(path => ['--path', path]), '--db', db,
    ]);
    const registration = command(imported.digest, scopeDigest, 'root-register', 'register', null);
    await writeFile(file, JSON.stringify(registration));
    expect((await run(['rules', 'governance', 'apply', '--file', file, '--db', db, '--out', out])).stdout).toBe('');
    const registered = JSON.parse(await readFile(out, 'utf8'));
    expect(registered.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(registered.event).toMatchObject({ command: registration, evidence: null, trust });
    expect(await show()).toMatchObject({ namespace: 'local-semantic-review', ruleId: rule.ruleId, headDigest: registered.digest,
      sequence: 1, shadowRuleDigest: null, trust, versions: [{ ruleDigest: imported.digest, ruleId: rule.ruleId,
        version: rule.version, scope: rule.scope, scopeDigest, parentDigest: null, status: 'candidate' }] });
    expect(await select()).toMatchObject({ selected: [], excluded: [expect.objectContaining({ ruleDigest: imported.digest, status: 'candidate' })] });
    // Even the first selection must explicitly match the current logical-rule head.
    await expect(apply(command(imported.digest, scopeDigest, 'stale-bootstrap', 'bootstrap-shadow', null))).rejects.toMatchObject({ code: 1 });
    await expect(apply(command(imported.digest, 'f'.repeat(64), 'wrong-scope', 'bootstrap-shadow', registered.digest))).rejects.toMatchObject({ code: 1 });
    expect(await history()).toEqual([registered]);
    const bootstrap = command(imported.digest, scopeDigest, 'root-bootstrap', 'bootstrap-shadow', registered.digest);
    const selected = await apply(bootstrap);
    expect(selected.event).toMatchObject({ command: bootstrap, evidence: { kind: 'unvalidated-root-bootstrap' }, trust });
    const selection = await select(rule.scope.repositories[0], ['src/worker.ts', 'src/another.ts']);
    expect(selection).toMatchObject({ namespace: 'local-semantic-review', repository: rule.scope.repositories[0],
      paths: ['src/worker.ts', 'src/another.ts'], trust, selected: [{ ruleDigest: imported.digest, ruleId: rule.ruleId,
        version: rule.version, scope: rule.scope, scopeDigest, parentDigest: null, status: 'local-shadow', headDigest: selected.digest }], excluded: [] });
    expect(await show()).toMatchObject({ headDigest: selected.digest, sequence: 2, shadowRuleDigest: imported.digest });
    for (const filtered of [await select('synthetic:another-repository'), await select(undefined, ['src/generated/output.ts']), await select(undefined, ['src-other/worker.ts'])]) {
      expect(filtered.selected).toEqual([]);
      expect(filtered.excluded).toEqual([expect.objectContaining({ ruleDigest: imported.digest, status: 'local-shadow', reason: expect.any(String) })]);
    }
    const suspended = await apply(command(imported.digest, scopeDigest, 'root-suspend', 'suspend', selected.digest));
    expect(await show()).toMatchObject({ headDigest: suspended.digest, sequence: 3, shadowRuleDigest: null, versions: [{ status: 'suspended' }] });
    expect((await select()).selected).toEqual([]);
    const resumed = await apply(command(imported.digest, scopeDigest, 'root-resume', 'bootstrap-shadow', suspended.digest));
    expect((await select()).selected).toEqual([expect.objectContaining({ ruleDigest: imported.digest, headDigest: resumed.digest })]);
    const retired = await apply({ ...command(imported.digest, scopeDigest, 'root-retire', 'retire', resumed.digest), source: 'local-human-declared' });
    expect(await show()).toMatchObject({ headDigest: retired.digest, sequence: 5, shadowRuleDigest: null, versions: [{ status: 'retired' }] });
    expect((await select()).selected).toEqual([]);
    await expect(apply(command(imported.digest, scopeDigest, 'root-terminal', 'bootstrap-shadow', retired.digest))).rejects.toMatchObject({ code: 1 });
    // Exact retry returns its original event even after later transitions, without another append.
    expect(await apply(registration)).toEqual(registered);
    expect(await apply(bootstrap)).toEqual(selected);
    await expect(apply({ ...registration, reason: 'Do not rewrite a prior event.' })).rejects.toMatchObject({ code: 1 });
    const events = [registered, selected, suspended, resumed, retired];
    for (const [index, entry] of events.entries()) {
      expect(entry.digest).toBe(digestOf(entry.event));
      expect(entry.event).toMatchObject({ sequence: index + 1, previousEventDigest: index ? events[index - 1].digest : null, trust });
    }
    expect(await history()).toEqual(events);
    expect((await run(['rules', 'governance', 'history', '--rule-id', rule.ruleId, '--db', db, '--out', out])).stdout).toBe('');
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(events);
    expect((await run(['rules', 'governance', 'show', '--rule-id', rule.ruleId, '--db', db, '--out', out])).stdout).toBe('');
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(await show());
    expect((await run(['rules', 'governance', 'select', '--repository', rule.scope.repositories[0], '--path', 'src/worker.ts', '--db', db, '--out', out])).stdout).toBe('');
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(await select());
    expect(await parsed(['rules', 'list', '--db', db])).toEqual([imported]);
    expect((await parsed(['reviews', 'list', '--db', db])).reviews).toEqual([]);
    expect(await parsed(['revisions', 'decisions', '--db', db])).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 150_000);

it('requires revised-candidate evidence and atomically supersedes the prior local selection without creating reviews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-governance-revision-cli-')), db = join(directory, 'db');
  try {
    const demo = await parsed(['revisions', 'demo', '--db', db]);
    const base = await parsed(['rules', 'show', '--digest', demo.baseRuleDigest, '--db', db]);
    const candidate = await parsed(['rules', 'show', '--digest', demo.compatible.candidateRuleDigest, '--db', db]);
    const scopeDigest = digestOf(base.rule.scope), file = join(directory, 'command.json');
    const reviews = await parsed(['reviews', 'list', '--db', db]);
    const apply = async (value: Record<string, unknown>) => {
      await writeFile(file, JSON.stringify(value));
      return parsed(['rules', 'governance', 'apply', '--file', file, '--db', db]);
    };
    const selected = () => parsed(['rules', 'governance', 'select', '--repository', base.rule.scope.repositories[0], '--path', 'src/positive.ts', '--db', db]);
    // An accepted revision decision does not itself register or select a rule.
    expect((await selected()).selected).toEqual([]);
    const registered = await apply(command(base.digest, scopeDigest, 'base-register', 'register', null));
    const bootstrapped = await apply(command(base.digest, scopeDigest, 'base-bootstrap', 'bootstrap-shadow', registered.digest));
    const next = await apply(command(candidate.digest, scopeDigest, 'candidate-register', 'register', bootstrapped.digest));
    await expect(apply(command(candidate.digest, scopeDigest, 'candidate-bootstrap', 'bootstrap-shadow', next.digest))).rejects.toMatchObject({ code: 1 });
    await expect(apply({ ...command(candidate.digest, scopeDigest, 'candidate-select-conflict', 'select-shadow', next.digest), decisionDigest: demo.compatible.decision.digest })).rejects.toMatchObject({ code: 1 });
    const supersede = { ...command(base.digest, scopeDigest, 'base-supersede', 'supersede', next.digest),
      successor: { ruleDigest: candidate.digest, scopeDigest }, decisionDigest: demo.compatible.decision.digest };
    await expect(apply({ ...supersede, id: 'rejected-decision', decisionDigest: demo.regressed.decision.digest })).rejects.toMatchObject({ code: 1 });
    expect((await selected()).selected).toEqual([expect.objectContaining({ ruleDigest: base.digest, headDigest: next.digest })]);
    const superseded = await apply(supersede);
    expect(superseded.event).toMatchObject({ command: supersede, transitions: [
      { ruleDigest: base.digest, from: 'local-shadow', to: 'superseded' },
      { ruleDigest: candidate.digest, from: 'candidate', to: 'local-shadow' },
    ], evidence: { kind: 'accepted-local-comparison', decisionDigest: demo.compatible.decision.digest,
      comparisonDigest: demo.compatible.comparison.digest, baseRuleDigest: base.digest, candidateRuleDigest: candidate.digest,
      comparisonStatus: 'compatible', decisionSource: 'fixture', certification: 'none' }, trust });
    expect((await selected()).selected).toEqual([expect.objectContaining({ ruleDigest: candidate.digest, headDigest: superseded.digest })]);
    const state = await parsed(['rules', 'governance', 'show', '--rule-id', base.rule.ruleId, '--db', db]);
    expect(state).toMatchObject({ headDigest: superseded.digest, sequence: 4, shadowRuleDigest: candidate.digest });
    expect(state.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleDigest: base.digest, status: 'superseded' }),
      expect.objectContaining({ ruleDigest: candidate.digest, status: 'local-shadow', parentDigest: base.digest }),
    ]));
    const suspended = await apply(command(candidate.digest, scopeDigest, 'candidate-suspend', 'suspend', superseded.digest));
    expect((await selected()).selected).toEqual([]);
    await expect(apply(command(candidate.digest, scopeDigest, 'candidate-resume-without-evidence', 'select-shadow', suspended.digest))).rejects.toMatchObject({ code: 1 });
    const resumed = await apply({ ...command(candidate.digest, scopeDigest, 'candidate-resume', 'select-shadow', suspended.digest), decisionDigest: demo.compatible.decision.digest });
    expect((await selected()).selected).toEqual([expect.objectContaining({ ruleDigest: candidate.digest, headDigest: resumed.digest })]);
    expect(await parsed(['rules', 'governance', 'history', '--rule-id', base.rule.ruleId, '--db', db])).toEqual([
      registered, bootstrapped, next, superseded, suspended, resumed,
    ]);
    expect(await parsed(['reviews', 'list', '--db', db])).toEqual(reviews);
    // Governance does not change the legacy exact-digest review path or stored review identity.
    const explicit = await parsed(['reviews', 'run', '--rule-digest', base.digest, '--snapshot-digest', demo.snapshotDigest, '--db', db]);
    expect(explicit.ruleDigest).toBe(base.digest);
    expect(await parsed(['reviews', 'list', '--db', db])).toEqual(reviews);
    expect(await parsed(['revisions', 'decision', '--digest', demo.compatible.decision.digest, '--db', db])).toEqual(demo.compatible.decision);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 150_000);

it('rejects missing or forged governance metadata before creating a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-governance-cli-invalid-')), db = join(directory, 'never-created');
  try {
    const file = join(directory, 'command.json'), input = command('a'.repeat(64), 'b'.repeat(64), 'invalid-test', 'register', null);
    const missing = ['id', 'namespace', 'ruleDigest', 'scopeDigest', 'expectedHeadDigest', 'action', 'actor', 'source', 'reason', 'createdAt'];
    const invalid: Record<string, unknown>[] = missing.map(key => Object.fromEntries(Object.entries(input).filter(([name]) => name !== key)));
    invalid.push(
      { ...input, namespace: 'production' }, { ...input, actor: ' ' }, { ...input, source: 'model' },
      { ...input, expectedHeadDigest: '' }, { ...input, scopeDigest: 'not-a-digest' }, { ...input, action: 'activate' },
      { ...input, reason: '' }, { ...input, createdAt: 'yesterday' }, { ...input, certification: 'approved' },
      { ...input, action: 'select-shadow' }, { ...input, action: 'supersede', decisionDigest: 'c'.repeat(64) },
    );
    for (const value of invalid) {
      await writeFile(file, JSON.stringify(value));
      await expect(run(['rules', 'governance', 'apply', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
      await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await writeFile(file, ' '.repeat(2_000_001));
    await expect(run(['rules', 'governance', 'apply', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('2MB') });
    await writeFile(file, Buffer.from([123, 34, 255, 34, 58, 49, 125]));
    await expect(run(['rules', 'governance', 'apply', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, '{');
    await expect(run(['rules', 'governance', 'apply', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);

it('requires explicit command options and refuses model flags or nonliteral paths before opening storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-governance-cli-options-')), db = join(directory, 'never-created');
  try {
    const file = join(directory, 'command.json');
    await writeFile(file, JSON.stringify(command('a'.repeat(64), 'b'.repeat(64), 'options-test', 'register', null)));
    for (const args of [
      ['apply', '--file', file], ['apply', '--db', db], ['show', '--db', db], ['history', '--rule-id', 'rule'],
      ['select', '--repository', 'synthetic:test', '--db', db], ['select', '--path', 'src/test.ts', '--db', db],
      ['apply', '--file', file, '--db', db, '--enable-model'],
      ['select', '--repository', 'synthetic:test', '--path', '../secret', '--db', db],
      ['select', '--repository', 'synthetic:test', '--path', 'src/*.ts', '--db', db],
      ['select', '--repository', 'synthetic:test', '--path', '/tmp/test.ts', '--db', db],
      ['select', '--repository', ' padded ', '--path', 'src/test.ts', '--db', db],
      ['select', '--repository', 'synthetic:test', '--path', 'src/test.ts', '--path', 'src/test.ts', '--db', db],
    ]) {
      await expect(run(['rules', 'governance', ...args])).rejects.toMatchObject({ code: 1 });
      await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const help = (await run(['rules', 'governance', '--help'])).stdout.replace(/\s+/g, ' ');
    for (const name of ['apply', 'show', 'history', 'select']) expect(help).toContain(name);
    expect(help).toContain('no review, activation, certification or publication');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

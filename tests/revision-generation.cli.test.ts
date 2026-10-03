import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { generateRuleRevision } from '../src/rule-revision.js';
import { revisionGenerationFixture, revisionConfig, revisionDate } from './helpers/revision-generation-fixture.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
function run(args: string[], home: string) {
  return exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 8_000_000,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, DATABASE_URL: 'postgresql://unused.invalid/never-used', QE_ENABLE_MODEL: 'false' } });
}

it('discovers and inspects a persisted contextual generated record across CLI processes without reexecution or verdict changes', async () => {
  const f = await revisionGenerationFixture(undefined, false, true), db = join(f.directory, 'db');
  try {
    const generated = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: f.input.candidateId,
      candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
    if (generated.execution !== 'succeeded' || generated.status !== 'candidate_requires_review') throw new Error(JSON.stringify(generated));
    const saved = generated.saved, calls = [...f.calls], contexts = f.repositoryContexts!.map(value => value.digest);
    await f.closeStore(); await rm(f.repoPath, { recursive: true, force: true });
    const showArgs = ['revisions', 'candidate', '--db', db, '--digest', saved.digest];
    const first = await run(showArgs, f.directory), shown = JSON.parse(first.stdout);
    expect(shown.candidate).toEqual(saved.candidate); expect(shown.digest).toBe(saved.digest);
    expect(shown.inspection).toMatchObject({ source: 'fixture', modelExecution: 'not_run', operator: 'boundary_update', certification: 'none',
      selectedFeedback: [{ source: 'fixture', label: 'FP', selectedVerdict: 'Unknown' }],
      request: { status: 'pending', synthesis: 'not_run' }, trust: { identityVerification: 'caller-declared-unverified', verdictScope: 'frozen-selected-feedback-only' } });
    expect(shown.inspection.links.repositoryContexts).toEqual(contexts.map(digest => ['contexts', 'show', '--digest', digest]));
    expect(shown.inspection.links.comparisons).toEqual(['revisions', 'comparisons', '--request-digest', f.request.digest, '--candidate-rule-digest', saved.candidate.ruleDigest]);
    expect((await run(showArgs, f.directory)).stdout).toBe(first.stdout);
    const out = join(f.directory, 'shown.json');
    expect((await run([...showArgs, '--out', out], f.directory)).stdout).toBe('');
    expect(await readFile(out, 'utf8')).toBe(first.stdout);
    const listArgs = ['revisions', 'candidates', '--db', db, '--request-digest', f.request.digest, '--id', saved.candidate.id, '--rule-digest', saved.candidate.ruleDigest, '--limit', '1'];
    const page = JSON.parse((await run(listArgs, f.directory)).stdout);
    expect(page).toMatchObject({ schemaVersion: 1, kind: 'revision-candidate-list', candidates: [{ digest: saved.digest }], nextAfter: saved.digest, limit: 1 });
    expect(JSON.parse((await run([...listArgs, '--after', saved.digest], f.directory)).stdout)).toMatchObject({ candidates: [], nextAfter: null });
    expect(JSON.parse((await run(['revisions', 'outcomes', '--db', db], f.directory)).stdout)).toMatchObject({ outcomes: [], nextAfter: null });
    expect(JSON.parse((await run([...shown.inspection.links.comparisons, '--db', db], f.directory)).stdout)).toMatchObject({ comparisons: [], nextAfter: null });
    expect(f.calls).toEqual(calls);
    const verdict = JSON.parse((await run(['reviews', 'finding', '--db', db, '--id', f.finding.id], f.directory)).stdout);
    expect(verdict.verdict).toBe('Unknown');
    await expect(run(['revisions', 'outcome', '--db', db, '--digest', saved.digest], f.directory)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown revision outcome') });
    await expect(run(['revisions', 'candidate', '--db', db, '--digest', 'f'.repeat(64)], f.directory)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown revision candidate') });
    const invalidDb = join(f.directory, 'not-opened');
    for (const args of [
      ['candidate', '--digest', 'bad'], ['outcome', '--digest', 'bad'], ['candidates', '--after', 'bad'],
      ['outcomes', '--request-digest', 'bad'], ['candidates', '--rule-digest', 'bad'], ['candidates', '--id', ''],
      ...['0', '-1', '1.5', 'NaN', '101'].map(limit => ['outcomes', '--limit', limit]),
    ]) await expect(run(['revisions', ...args, '--db', invalidDb], f.directory)).rejects.toMatchObject({ code: 1, stdout: '' });
    await expect(stat(invalidDb)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.cleanup(); }
}, 150_000);

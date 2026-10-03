import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 6_000_000 });
const parsed = async (args: string[]) => JSON.parse((await run(args)).stdout);

it('persists both fixture-only comparison outcomes, reruns deterministically and reopens records through separate CLI processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revision-comparison-cli-')), db = join(directory, 'db');
  try {
    const demoFile = join(directory, 'demo.json');
    expect((await run(['revisions', 'demo', '--db', db, '--out', demoFile])).stdout).toBe('');
    const demo = JSON.parse(await readFile(demoFile, 'utf8'));
    expect(demo.mode).toBe('synthetic_offline_revision_demo');
    expect(demo.compatible.comparison.comparison.summary).toMatchObject({ status: 'compatible', preserved: 2, corrected: 2, regressed: 0, stillFailing: 0, inconclusive: 0 });
    expect(demo.regressed.comparison.comparison.summary).toMatchObject({ status: 'regressed', preserved: 0, corrected: 2, regressed: 2, stillFailing: 0, inconclusive: 0 });
    expect(demo.compatible.comparison.comparison.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: 'revision-demo-positive', expected: 'violation', outcome: 'preserved' }),
      expect.objectContaining({ caseId: 'revision-demo-negative', expected: 'safe', outcome: 'corrected' }),
    ]));
    expect(demo.regressed.comparison.comparison.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: 'revision-demo-positive', outcome: 'regressed', candidate: { state: 'safe', reason: 'explicit_semantic_judgment' } }),
    ]));
    expect(demo.findingVerdicts).toHaveLength(2);
    for (const finding of demo.findingVerdicts) expect(finding.verdict).toBe('Unknown');
    for (const item of [demo.compatible, demo.regressed]) {
      expect(item.request.request).toMatchObject({ status: 'pending', synthesis: 'not_run', source: 'fixture', baseRuleDigest: demo.baseRuleDigest });
      expect(item.comparison.comparison).toMatchObject({ synthesis: 'not_run', activation: 'not_performed', trust: { certification: 'none', semanticEvidence: 'offline-fixture-declarations' } });
      expect(item.decision.decision).toMatchObject({ source: 'fixture', identityVerification: 'caller-declared-unverified', activation: 'not_performed', certification: 'none' });
      expect(await parsed(['revisions', 'comparison', '--digest', item.comparison.digest, '--db', db])).toEqual(item.comparison);
      expect(await parsed(['revisions', 'decision', '--digest', item.decision.digest, '--db', db])).toEqual(item.decision);
      expect(await parsed(['revisions', 'comparisons', '--request-digest', item.request.digest, '--db', db])).toEqual([item.comparison]);
      expect(await parsed(['revisions', 'decisions', '--comparison-digest', item.comparison.digest, '--db', db])).toEqual([item.decision]);
      const request = await parsed(['revisions', 'show', '--digest', item.request.digest, '--db', db]);
      expect(request).toEqual(item.request);
    }
    expect(demo.compatible.decision.decision.choice).toBe('accept');
    expect(demo.regressed.decision.decision.choice).toBe('reject');
    expect(demo.compatible.request.digest).not.toBe(demo.regressed.request.digest);
    expect(demo.compatible.candidateRuleDigest).not.toBe(demo.regressed.candidateRuleDigest);
    const compareFile = join(directory, 'compare.json');
    await writeFile(compareFile, JSON.stringify(demo.compatible.comparison.comparison.input));
    expect(await parsed(['revisions', 'compare', '--file', compareFile, '--db', db])).toEqual(demo.compatible.comparison);
    expect(await parsed(['revisions', 'demo', '--db', db])).toEqual(demo);
    expect(await parsed(['revisions', 'comparisons', '--db', db])).toHaveLength(2);
    expect(await parsed(['revisions', 'decisions', '--db', db])).toHaveLength(2);
    expect(await parsed(['rules', 'list', '--db', db])).toHaveLength(3);
    const review = await parsed(['reviews', 'show', '--id', demo.compatible.candidateReviewId, '--db', db]);
    expect(review.occurrences).toHaveLength(2);
    expect(review.coverage.targets.map((target: { scans: unknown[] }) => target.scans)).toEqual([
      [{ assetId: 'protected-read-hint', engine: 'ast-grep', state: 'scanned', candidateCount: 1, reason: null }],
      [{ assetId: 'protected-read-hint', engine: 'ast-grep', state: 'scanned', candidateCount: 1, reason: null }],
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

it('requires explicit declared decisions, permits defer on regression and refuses unsafe acceptance or changed immutable IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revision-decision-cli-')), db = join(directory, 'db');
  try {
    const demo = await parsed(['revisions', 'demo', '--db', db]), file = join(directory, 'decision.json');
    const input = { id: 'explicit-local-defer', comparisonDigest: demo.regressed.comparison.digest, choice: 'defer',
      source: 'local-human-declared', actor: 'Local declaration; identity unverified', reason: 'Keep the lost-positive result open.\n  Preserve exact authored text.\n', createdAt: '2026-10-01T00:00:00Z' };
    await writeFile(file, JSON.stringify(input));
    const stored = await parsed(['revisions', 'decide', '--file', file, '--db', db]);
    expect(stored.decision).toMatchObject({ ...input, comparisonStatus: 'regressed', activation: 'not_performed', identityVerification: 'caller-declared-unverified' });
    expect(await parsed(['revisions', 'decide', '--file', file, '--db', db])).toEqual(stored);
    await writeFile(file, JSON.stringify({ ...input, id: 'unsafe-local-accept', choice: 'accept' }));
    await expect(run(['revisions', 'decide', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    const comparisonFile = join(directory, 'inconclusive.json');
    await writeFile(comparisonFile, JSON.stringify({ ...demo.compatible.comparison.comparison.input, id: 'missing-case-bindings', caseBindings: [] }));
    const inconclusive = await parsed(['revisions', 'compare', '--file', comparisonFile, '--db', db]);
    expect(inconclusive.comparison.summary.status).toBe('inconclusive');
    expect(inconclusive.comparison.cases.every((value: { outcome: string }) => value.outcome === 'inconclusive')).toBe(true);
    await writeFile(file, JSON.stringify({ ...input, id: 'inconclusive-local-accept', comparisonDigest: inconclusive.digest, choice: 'accept' }));
    await expect(run(['revisions', 'decide', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, JSON.stringify({ ...input, reason: 'Attempt to rewrite the existing decision.' }));
    await expect(run(['revisions', 'decide', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    const { source: ignored, ...withoutSource } = input;
    await writeFile(file, JSON.stringify({ ...withoutSource, id: 'missing-source' }));
    await expect(run(['revisions', 'decide', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, JSON.stringify({ ...input, id: 'forged-activation', activation: 'performed' }));
    await expect(run(['revisions', 'decide', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    expect(await parsed(['revisions', 'decisions', '--db', db])).toHaveLength(3);
    expect(await parsed(['revisions', 'show', '--digest', demo.regressed.request.digest, '--db', db])).toEqual(demo.regressed.request);
    expect((await parsed(['reviews', 'finding', '--id', demo.feedback[0].findingId, '--db', db])).verdict).toBe('Unknown');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);

it('rejects stale comparison bindings, caller-provided results, malformed input, missing storage and model flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revision-comparison-cli-errors-')), db = join(directory, 'db');
  try {
    await expect(run(['revisions', 'demo'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--db') });
    const demo = await parsed(['revisions', 'demo', '--db', db]), file = join(directory, 'comparison.json');
    const input = demo.compatible.comparison.comparison.input;
    await writeFile(file, JSON.stringify({ ...input, id: 'forged-result', summary: { status: 'compatible' } }));
    await expect(run(['revisions', 'compare', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, JSON.stringify({ ...input, id: 'stale-review', reviewPairs: [{ baseReviewId: demo.baseReviewId, candidateReviewId: demo.regressed.candidateReviewId }] }));
    await expect(run(['revisions', 'compare', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, JSON.stringify({ ...input, id: 'wrong-candidate-version', candidateRuleDigest: demo.regressed.candidateRuleDigest }));
    await expect(run(['revisions', 'compare', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, JSON.stringify({ ...input, caseBindings: [] }));
    await expect(run(['revisions', 'compare', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(run(['revisions', 'demo', '--db', db, '--enable-model'])).rejects.toMatchObject({ code: 1 });
    await expect(run(['revisions', 'comparisons', '--db', db, '--request-digest', 'invalid'])).rejects.toMatchObject({ code: 1 });
    await expect(run(['revisions', 'decision', '--db', db, '--digest', 'invalid'])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, ' '.repeat(2_000_001));
    await expect(run(['revisions', 'compare', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Input exceeds 2MB') });
    await writeFile(file, Buffer.from([123, 34, 255, 34, 58, 49, 125]));
    await expect(run(['revisions', 'compare', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    expect(await parsed(['revisions', 'comparisons', '--db', db])).toHaveLength(2);
    expect(await parsed(['revisions', 'decisions', '--db', db])).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);

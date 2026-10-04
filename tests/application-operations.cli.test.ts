import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase } from '../src/storage/database.js';
import { readAsset, semanticInputs } from './helpers/semantic-review-fixture.js';

const exec = promisify(execFile);
const fixtures = 'experiments/temporal-pilot/w0-first-three';
const run = async (...args: string[]) => JSON.parse((await exec(process.execPath,
  ['--import', 'tsx', 'src/cli.ts', 'application-jobs', ...args], { timeout: 25_000, maxBuffer: 200_000 })).stdout);

it('prepares all three real W0 requests through the CLI, reopens, and explains each blocked job without execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'w0-operations-cli-')), db = join(root, 'db');
  try {
    const store = await QualEvoStore.openPGlite(db);
    try {
      for (const number of [3035, 3031, 3036]) {
        const pkg = JSON.parse(await readFile(`${fixtures}/proxy-attempt-1/package-${number}.json`, 'utf8'));
        await store.importGithubPrEvidence(pkg.evidence.evidence);
      }
    } finally { await store.close(); }
    for (const number of [3035, 3031, 3036]) {
      const file = join(root, `job-${number}.json`);
      const args = ['prepare-mining', '--db', db, '--request', `${fixtures}/mining-preparation/request-input-${number}.json`,
        '--workspace-id', `httpx-w0-${number}`, '--candidate-created-at', '2026-10-03T23:00:00Z', '--job-out', file];
      const prepared = await run(...args);
      expect(prepared).toMatchObject({ requestPersistence: 'stored', jobPersistence: 'not_enqueued', execution: 'not_run' });
      const job = JSON.parse(await readFile(file, 'utf8'));
      expect(job).toEqual(prepared.job);
      expect(await run(...args)).toEqual(prepared);
      const preflight = await run('preflight', '--db', db, '--file', file);
      expect(preflight).toMatchObject({ status: 'blocked', execution: 'not_run', modelExecution: 'not_run',
        workspace: { workspaceId: `httpx-w0-${number}`, repository: 'github:encode/httpx' }, jobStateChecked: false });
      expect(preflight.issues.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining([
        'disabled', 'lifecycle_authority_required', 'workspace_resolver_required',
      ]));
      expect(preflight.workspace.expectedSha).toBe(preflight.workspace.baseSha);
      const recovery = await run('recovery', '--db', db, '--file', file);
      expect(recovery).toMatchObject({ state: 'not_started', attempts: 0,
        recovery: { action: 'preflight_then_enqueue', automaticRetryAllowed: false } });
    }
    const reopened = await QualEvoStore.openPGlite(db);
    try {
      expect(await reopened.listPrMiningRequests()).toHaveLength(3);
      expect(await reopened.listPrMiningCandidates()).toEqual([]);
    } finally { await reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

it('keeps repeated revision CLI preflight read-only and rejects a subsequently registered holdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revision-preflight-cli-')), dbPath = join(root, 'db');
  const file = join(root, 'revision-job.json'), date = '2026-10-02T00:00:00Z';
  const input = semanticInputs({ assets: [readAsset] });
  const source = input.snapshot.snapshot.changes[0].after;
  if (source.state !== 'captured') throw new Error('Expected captured authored source');
  const preflight = async () => JSON.parse((await exec(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'application-jobs', 'preflight', '--db', dbPath, '--file', file],
    { timeout: 30_000, maxBuffer: 200_000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C.UTF-8' } })).stdout);
  try {
    const setupDb = await openPGliteDatabase(dbPath), setup = await QualEvoStore.initialize(setupDb);
    let findingId: string, requestDigest: string;
    try {
      const rule = await setup.importRuleVersion(input.rule.rule, [input.problemCase]);
      const snapshot = await setup.importChangeSnapshot(input.snapshot.snapshot);
      const review = await setup.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest });
      findingId = review.findings[0].id;
      for (const label of ['Unknown', 'Disputed'] as const) await setup.appendReviewFeedback({
        id: `selected-${label}`, findingId, reviewId: review.id, ruleDigest: rule.digest, ruleVersion: rule.rule.version,
        source: 'local-human-declared', actor: 'unverified-authored-actor', kind: 'label', label,
        reason: 'Authored unresolved declaration, not independent human validation', createdAt: date,
      });
      const request = await setup.createRevisionRequest({ id: 'user-revision', baseRuleDigest: rule.digest,
        requestedRuleVersion: 'next', feedbackIds: ['selected-Unknown', 'selected-Disputed'],
        requestedChange: 'Inspect unresolved feedback without claiming a mutation', source: 'fixture', actor: 'authored', createdAt: date });
      requestDigest = request.digest;
      await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'revision-generation', workspaceId: 'authored-workspace',
        requestDigest, snapshotDigest: snapshot.digest, candidateCreatedAt: date }));
      expect((await setupDb.query('SELECT split FROM qe_source_splits WHERE digest=$1', [source.sha256])).rows).toEqual([]);
    } finally { await setup.close(); }

    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await preflight();
      expect(report).toMatchObject({ status: 'blocked', execution: 'not_run', modelExecution: 'not_run', jobStateChecked: false });
      expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining(['disabled', 'workspace_resolver_required']));
      expect(report.issues.map((issue: { code: string }) => issue.code)).not.toContain('domain_contract_rejected');
    }
    const db = await openPGliteDatabase(dbPath), reopened = await QualEvoStore.initialize(db);
    try {
      expect((await db.query('SELECT split FROM qe_source_splits WHERE digest=$1', [source.sha256])).rows).toEqual([]);
      expect((await reopened.getRevisionRequest(requestDigest)).request.feedbackIds).toEqual(['selected-Unknown', 'selected-Disputed']);
      const finding = await reopened.getReviewFinding(findingId);
      expect(finding.verdict).toBe('Disputed');
      expect(finding.feedback.map(value => value.label).sort()).toEqual(['Disputed', 'Unknown']);
      expect(finding.feedback.every(value => value.findingId === findingId && value.source === 'local-human-declared')).toBe(true);
      await reopened.importProblemCase({ ...input.problemCase, id: 'later-holdout', lineageId: 'later-holdout', split: 'holdout',
        commit: input.snapshot.snapshot.head, path: source.path, sourceDigest: source.sha256 });
      expect((await db.query('SELECT split FROM qe_source_splits WHERE digest=$1', [source.sha256])).rows).toEqual([{ split: 'holdout' }]);
    } finally { await reopened.close(); }
    const rejected = await preflight();
    expect(rejected).toMatchObject({ status: 'blocked', workspace: null, execution: 'not_run', modelExecution: 'not_run' });
    expect(rejected.issues.map((issue: { code: string }) => issue.code)).toContain('domain_contract_rejected');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

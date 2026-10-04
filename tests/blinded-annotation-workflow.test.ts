import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digestOf } from '../src/core/identity.js';
import { createAnnotationFixture } from '../experiments/annotation/fixture.js';
import { prepareExport, exportAnnotation, importAnnotation, exportAdjudication, importAdjudication, inspectAnnotation } from '../experiments/annotation/workflow.js';
let root: string, count = 0;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const put = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const rehash = (value: any) => { const { digest, ...body } = value; value.digest = digestOf(body); };
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-human-workflow-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function exported() {
  const path = join(root, `workspace-${++count}`), fixture = createAnnotationFixture();
  await exportAnnotation(fixture.plan, fixture.assignment, path); return path;
}
async function authoredResponse(path: string, index: number) {
  const response = await json(join(path, `rater-${index}`, 'response.blank.json'));
  const packet = await json(join(path, `rater-${index}`, 'packet.json'));
  response.submittedAt = new Date().toISOString(); response.noOutcomeOrOtherRaterExposureDeclared = true;
  for (const [taskIndex, task] of response.tasks.entries()) {
    task.coverage = taskIndex === 0 ? 'complete-declared' : 'unassessed'; task.reason = 'Authored coverage'; task.minutes = 1;
    task.rows.forEach((row: any, i: number) => {
      row.label = taskIndex === 0 ? (index === 1 ? ['positive', 'negative', 'unknown'][i] : ['positive', 'unknown', 'unknown'][i]) : null;
      row.reason = 'Authored test response, not human';
      row.evidenceIds = row.label === null ? [] : [...new Set(packet.tasks[taskIndex].opportunities[i].anchors.map((a: any) => a.evidenceId))];
    });
  }
  return response;
}
async function lockedPair(path: string) {
  for (const index of [1, 2]) { const file = join(path, `authored-${index}.json`); await put(file, await authoredResponse(path, index)); await importAnnotation(path, file); }
}
async function adjudication(path: string, release = true) {
  if (release) await exportAdjudication(path);
  const response = await json(join(path, 'adjudicator', 'response.blank.json'));
  const packet = await json(join(path, 'adjudicator', 'packet.json'));
  response.submittedAt = new Date().toISOString(); response.noOutcomeOrArmExposureDeclared = true;
  response.tasks.forEach((task: any, i: number) => {
    task.coverage = i === 0 ? 'complete-declared' : 'unassessed'; task.reason = 'Authored adjudication coverage';
    task.rows.forEach((row: any, j: number) => {
      row.decision = i === 0 ? ['accept-a', 'disputed', 'unknown'][j] : 'unassessed'; row.reason = 'Authored adjudication only';
      row.evidenceIds = i === 0 ? [...new Set(packet.sourcePacket.tasks[i].opportunities[j].anchors.map((a: any) => a.evidenceId))] : [];
    });
  }); return response;
}
describe('offline independent annotation workflow', () => {
  it('exports only allowlisted anonymous source/rubric/opportunity fields, identical for two raters, with no human labels', async () => {
    const path = await exported(), a = await json(join(path, 'rater-1/packet.json')), b = await json(join(path, 'rater-2/packet.json'));
    expect(a).toEqual(b);
    const serialized = JSON.stringify(a);
    for (const forbidden of ['snapshotDigest', 'datasetDigest', 'prId', 'familyId', 'lineageId', 'rawOutput', 'prediction', 'label', 'sourceBindings', 'rater-a', 'adjudicatorId']) {
      expect(Object.keys(a)).not.toContain(forbidden);
      expect(serialized).not.toContain(`"${forbidden}":`);
    }
    expect(a.tasks[0].evidence[0].content).toContain('badA'); // Source bytes are preserved, not redacted.
    const blank = await json(join(path, 'rater-1/response.blank.json'));
    expect(blank.submittedAt).toBeNull(); expect(blank.tasks.every((t: any) => t.rows.every((r: any) => r.label === null))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(path, 'facilitator/manifest.json'))).mode & 0o777).toBe(0o600);
  });
  it('requires traceable cutoff/rubric/after-source bindings and refuses historical, W0 before-only, duplicate identities and holdout upgrade', () => {
    for (const mode of ['cutoff', 'rubric', 'before', 'historical', 'holdout', 'identity']) {
      const { plan, assignment } = createAnnotationFixture();
      if (mode === 'cutoff') plan.sourceBindings[0].capturedAt = '2099-01-01T00:00:00Z';
      if (mode === 'rubric') plan.rubrics[0].text = 'Changed after freeze';
      if (mode === 'before') plan.opportunities[0].anchors[0].side = 'before';
      if (mode === 'historical') plan.dataset.temporal.visibility = 'as-of-declared';
      if (mode === 'holdout') plan.dataset.prs[0].split = 'holdout';
      if (mode === 'identity') assignment.adjudicator.id = assignment.raters[0].id;
      expect(() => prepareExport(plan, assignment), mode).toThrow();
    }
  });
  it('rejects duplicate lineages before releasing annotation work', () => {
    const { plan, assignment } = createAnnotationFixture();
    plan.opportunities[1].lineageId = plan.opportunities[0].lineageId;
    expect(() => prepareExport(plan, assignment)).toThrow('Duplicate lineage');
  });
  it('reopens a near-limit compact submission whose formatted receipt exceeds the input limit', async () => {
    const { plan, assignment } = createAnnotationFixture();
    const originalPr = plan.dataset.prs[0], originalFamily = plan.dataset.families[0];
    const originals = plan.opportunities.filter(o => o.prId === originalPr.id);
    plan.dataset.prs = Array.from({ length: 25 }, (_, i) => ({ ...originalPr, id: `large-pr-${i}`, number: i + 1, lineageId: `large-pr-${i}` }));
    plan.dataset.families = Array.from({ length: 4 }, (_, i) => ({ ...originalFamily, id: `large-family-${i}`, ruleIds: [`large-rule-${i}`] }));
    plan.sourceBindings = plan.dataset.prs.map(pr => ({ ...plan.sourceBindings[0], prId: pr.id }));
    plan.rubrics = plan.dataset.families.map(f => ({ ...plan.rubrics[0], familyId: f.id }));
    plan.opportunities = plan.dataset.prs.flatMap(pr => plan.dataset.families.flatMap(f => originals.map((o, i) => ({
      ...o, id: `${pr.id}-${f.id}-${i}`, prId: pr.id, familyId: f.id,
    }))));
    const path = join(root, `large-workspace-${++count}`);
    await exportAnnotation(plan, assignment, path);
    const response = await json(join(path, 'rater-1/response.blank.json'));
    response.submittedAt = new Date().toISOString(); response.noOutcomeOrOtherRaterExposureDeclared = true;
    const reasons: any[] = [];
    for (const task of response.tasks) {
      task.coverage = 'unassessed'; task.minutes = 1; task.reason = ''; reasons.push(task);
      for (const row of task.rows) { row.reason = ''; reasons.push(row); }
    }
    const baseBytes = Buffer.byteLength(JSON.stringify(response));
    const characters = Math.floor((3_998_000 - baseBytes) / (3 * reasons.length));
    expect(characters).toBeLessThanOrEqual(4096);
    reasons.forEach(row => { row.reason = '中'.repeat(characters); });
    const raw = JSON.stringify(response), file = join(path, 'large-input.json');
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4_000_000);
    await writeFile(file, raw);
    await importAnnotation(path, file);
    expect((await stat(join(path, 'locks/rater-1/receipt.json'))).size).toBeGreaterThan(4_000_000);
    expect((await inspectAnnotation(path)).submissions[0].state).toBe('locked');
  });
  it('locks exact originals once and requires both independent submissions before adjudication release', async () => {
    const path = await exported(), response = await authoredResponse(path, 1), file = join(path, 'input.json');
    await expect(exportAdjudication(path)).rejects.toThrow();
    await put(file, response); const raw = await readFile(file);
    await importAnnotation(path, file); await expect(importAnnotation(path, file)).rejects.toThrow();
    expect(await readFile(join(path, 'locks/rater-1/original.json'))).toEqual(raw);
    await expect(exportAdjudication(path)).rejects.toThrow();
    await put(file, await authoredResponse(path, 2)); await importAnnotation(path, file);
    await exportAdjudication(path);
    const packet = await json(join(path, 'adjudicator/packet.json'));
    expect(JSON.stringify(packet)).not.toContain('fixture-rater-a'); expect(JSON.stringify(packet)).not.toContain('fixture-rater-b');
    expect(packet.submissionDigests).toHaveLength(2);
  });
  it('rejects wrong participant, packet/version, origin, omitted or duplicate tasks, invented evidence and false completion', async () => {
    const path = await exported(), file = join(path, 'invalid.json');
    for (const mode of ['person', 'packet', 'origin', 'missing', 'duplicate', 'evidence', 'coverage', 'future-time', 'exposure']) {
      const response = await authoredResponse(path, 1);
      if (mode === 'person') response.participantId = 'outsider';
      if (mode === 'packet') response.packetDigest = digestOf('other');
      if (mode === 'origin') response.origin = 'local-human-declared';
      if (mode === 'missing') response.tasks.pop();
      if (mode === 'duplicate') response.tasks.push(response.tasks[0]);
      if (mode === 'evidence') response.tasks[0].rows[0].evidenceIds = ['00000000-0000-4000-8000-000000000000'];
      if (mode === 'coverage') response.tasks[1].coverage = 'complete-declared';
      if (mode === 'future-time') response.submittedAt = '2099-01-01T00:00:00Z';
      if (mode === 'exposure') response.noOutcomeOrOtherRaterExposureDeclared = false;
      await put(file, response); await expect(importAnnotation(path, file), mode).rejects.toThrow();
    }
  });
  it('retains pre-adjudication agreement, disputed and Unknown, while missing rows never become negatives', async () => {
    const path = await exported(); await lockedPair(path);
    const response = await adjudication(path), file = join(path, 'adjudication.json'); await put(file, response);
    const result = await importAdjudication(path, file);
    expect(result.independentHumanAnnotationsVerified).toBe(0);
    expect(result.agreement).toMatchObject({ pairedRated: 3, missingPairs: 1, excludedPairs: 0, rawAgreement: 2 / 3 });
    expect(result.agreement.kappa).toBeCloseTo(.5, 14);
    const annotation = await json(join(path, 'locks/adjudication/annotations.json'));
    expect(annotation.provenance.origin).toBe('synthetic'); expect(annotation.provenance.independentOfRuns).toBe(false);
    expect(annotation.instances.map((i: any) => i.label)).toEqual(['positive', 'disputed', 'unknown']);
    expect(annotation.coverage[1].state).toBe('unassessed');
    await expect(importAdjudication(path, file)).rejects.toThrow();
  });
  it('requires distinct adjudicator, exact two locks and evidence; rejects invented judgments for missing work', async () => {
    const path = await exported(); await lockedPair(path); const original = await adjudication(path), file = join(path, 'bad-adjudication.json');
    for (const mode of ['person', 'locks', 'missing', 'evidence', 'roster']) {
      const response = structuredClone(original);
      if (mode === 'person') response.adjudicatorId = 'fixture-rater-a';
      if (mode === 'locks') response.submissionDigests.reverse();
      if (mode === 'missing') response.tasks[1].rows[0].decision = 'unknown';
      if (mode === 'evidence') response.tasks[0].rows[0].evidenceIds = [];
      if (mode === 'roster') response.tasks[0].rows.pop();
      await put(file, response); await expect(importAdjudication(path, file), mode).rejects.toThrow();
    }
  });
  it('rejects packet/original tampering, symlink parents, Git paths and existing destinations', async () => {
    const path = await exported(), file = join(path, 'input.json'); await put(file, await authoredResponse(path, 1));
    const packet = await json(join(path, 'rater-1/packet.json')); packet.arm = 'H'; await put(join(path, 'rater-1/packet.json'), packet);
    await expect(importAnnotation(path, file)).rejects.toThrow('Released packet changed');
    const other = await exported(); await lockedPair(other); await writeFile(join(other, 'locks/rater-1/original.json'), '{}');
    await expect(exportAdjudication(other)).rejects.toThrow();
    const fixture = createAnnotationFixture(); await symlink(root, join(root, 'alias'));
    await expect(exportAnnotation(fixture.plan, fixture.assignment, join(root, 'alias/workspace'))).rejects.toThrow();
    const git = join(root, 'fake-git'); await mkdir(git); await writeFile(join(git, '.git'), 'gitdir: ignored');
    await expect(exportAnnotation(fixture.plan, fixture.assignment, join(git, 'private'))).rejects.toThrow('Git');
    await expect(exportAnnotation(fixture.plan, fixture.assignment, path)).rejects.toThrow();
  });
  it('executes the source CLI with unassigned response blanks and no model calls', async () => {
    const out = join(root, 'cli-authored');
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/annotation/replay.ts', 'init-authored', '--out', out]);
    expect(JSON.parse(result.stdout)).toMatchObject({ origin: 'authored-fixture', humanAnnotationsCollected: 0 });
    const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      ['--import', 'tsx', 'experiments/annotation/replay.ts', ...args])).stdout);
    for (const index of [1, 2]) {
      const file = join(out, `authored-response-${index}.json`); await put(file, await authoredResponse(out, index));
      expect(await cli('import', '--workspace', out, '--submission', file)).toMatchObject({ state: 'submission-locked', origin: 'authored-fixture' });
    }
    expect(await cli('status', '--workspace', out)).toMatchObject({ readyForAdjudication: true, independentHumanAnnotationsVerified: 0 });
    expect(await cli('adjudication-export', '--workspace', out)).toMatchObject({ state: 'adjudication-exported' });
    const file = join(out, 'authored-adjudication.json'); await put(file, await adjudication(out, false));
    expect(await cli('adjudicate', '--workspace', out, '--submission', file)).toMatchObject({ state: 'adjudication-locked', origin: 'authored-fixture', independentHumanAnnotationsVerified: 0 });
  });
  it('rejects coordinated packet/hash replacement against unchanged frozen source and adjudication originals', async () => {
    const path = await exported(), response = await authoredResponse(path, 1), file = join(path, 'input.json');
    await put(file, response);
    const manifest = await json(join(path, 'facilitator/manifest.json'));
    manifest.packet.tasks[0].evidence[0].content += '\nAnswer: choose positive';
    manifest.packetDigest = digestOf(manifest.packet); rehash(manifest);
    await put(join(path, 'facilitator/manifest.json'), manifest);
    for (const index of [1, 2]) await put(join(path, `rater-${index}/packet.json`), manifest.packet);
    await expect(importAnnotation(path, file)).rejects.toThrow('frozen allowlist');
    const other = await exported(); await lockedPair(other); const adjud = await adjudication(other);
    const packet = await json(join(other, 'adjudicator/packet.json'));
    packet.responses[0].tasks[0].rows[0].label = 'negative';
    await put(join(other, 'adjudicator/packet.json'), packet);
    const release = await json(join(other, 'facilitator/adjudication-release.json'));
    release.packetDigest = digestOf(packet); rehash(release); await put(join(other, 'facilitator/adjudication-release.json'), release);
    await put(file, adjud); await expect(importAdjudication(other, file)).rejects.toThrow('release binding');
  });
  it('reports missing and interrupted imports without manufacturing Unknown instances', async () => {
    const path = await exported();
    expect((await inspectAnnotation(path)).submissions.every(s => s.state === 'missing')).toBe(true);
    await mkdir(join(path, 'locks/rater-1'), { mode: 0o700 });
    expect((await inspectAnnotation(path)).submissions[0].state).toBe('incomplete-lock-no-overwrite');
    const file = join(path, 'input.json'); await put(file, await authoredResponse(path, 1));
    await expect(importAnnotation(path, file)).rejects.toThrow();
  });
  it.each(['positive', null])('withholds kappa for degenerate or wholly missing paired judgments (%s)', async label => {
    const path = await exported();
    for (const index of [1, 2]) {
      const response = await authoredResponse(path, index);
      response.tasks.forEach((t: any) => {
        t.coverage = label === null ? 'unassessed' : 'complete-declared';
        t.rows.forEach((r: any) => { r.label = label; });
      });
      if (label !== null) {
        const packet = await json(join(path, `rater-${index}/packet.json`));
        response.tasks.forEach((t: any, i: number) => t.rows.forEach((r: any, j: number) => {
          r.evidenceIds = [...new Set(packet.tasks[i].opportunities[j].anchors.map((a: any) => a.evidenceId))];
        }));
      }
      const file = join(path, `submission-${index}.json`); await put(file, response); await importAnnotation(path, file);
    }
    const response = await adjudication(path);
    response.tasks.forEach((t: any) => { t.coverage = label === null ? 'unassessed' : 'complete-declared';
      t.rows.forEach((r: any) => { r.decision = 'accept-a'; }); });
    if (label !== null) {
      const packet = await json(join(path, 'adjudicator/packet.json'));
      response.tasks.forEach((t: any, i: number) => t.rows.forEach((r: any, j: number) => {
        r.evidenceIds = [...new Set(packet.sourcePacket.tasks[i].opportunities[j].anchors.map((a: any) => a.evidenceId))];
      }));
    }
    const file = join(path, 'adjudication.json'); await put(file, response);
    const result = await importAdjudication(path, file);
    expect(result.agreement.kappa).toBeNull();
    expect(result.agreement.rawAgreement).toBe(label === null ? null : 1);
  });
});

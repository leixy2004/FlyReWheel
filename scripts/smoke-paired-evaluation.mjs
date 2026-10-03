import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'paired-evaluation-compiled-'));
const cli = async args => JSON.parse((await exec(process.execPath, ['dist/cli.js', ...args], { timeout: 30_000, maxBuffer: 4_000_000 })).stdout);
try {
  const directory = join(root, 'demo');
  const demo = await cli(['evaluation', 'demo', '--directory', directory]);
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  // Frozen v1 authored identity: intentional semantic/contract changes require explicit versioning.
  assert.equal(report.id, 'paired_evaluation_b4ef714a908c1fca5cd43ef3ea0d60158a688cd0e452223df7ed7415dcd81f5f');
  const replayPath = join(root, 'replayed.json');
  const scoreArgs = ['evaluation', 'score', '--dataset', join(directory, 'dataset.json'), '--annotations', join(directory, 'annotations.json'), '--runs', join(directory, 'runs.json'), '--out', replayPath];
  const replay = await cli(scoreArgs);
  assert.equal(replay.reportId, demo.reportId);
  assert.deepEqual(JSON.parse(await readFile(replayPath, 'utf8')), report);
  await assert.rejects(cli(scoreArgs), error => error.code === 1 && error.stderr.includes('EEXIST'));
  assert.equal(report.arms[0].counts.usefulInstances, 2);
  assert.equal(report.arms[0].counts.redundantPositiveAlertAnchors, 1);
  assert.equal(report.arms[0].counts.unmatchedAlertAnchors, 1);
  assert.equal(report.arms[1].counts.falseAlertInstances, 0);
  assert.equal(report.arms[1].counts.missedPositiveInstances, 3);
  assert.equal(report.comparisons[0].transitions.positivesLost, 1);
  assert.equal(report.comparisons[0].transitions.positivesGained, 1);
  assert.equal(report.inputBindings.annotations.provenance.origin, 'synthetic');
  assert.equal(report.inputBindings.annotations.provenance.independentOfRuns, false);
  assert.ok(report.arms.every(a => a.conditions.model.execution === 'authored-fixture'));
  process.stdout.write(JSON.stringify({
    status: 'passed', scope: 'compiled CLI authored-synthetic counting/binding oracle; no model or human annotation',
    scorer: report.scorer, reportId: report.id, inputBindings: report.inputBindings,
    counts: report.arms.map(a => ({ id: a.id, counts: a.counts })), comparisons: report.comparisons,
    checks: ['fresh-process compiled demo', 'separate frozen-manifest compiled replay', 'frozen v1 identity', 'same report byte values', 'existing-output rejection', 'positive deduplication', 'retained misses', 'gained/lost-positive transitions', 'unmatched/unknown/disputed/excluded visibility'],
    limitations: ['Synthetic fixtures verify scorer structure, not review efficacy or generalization.', 'Input provenance and declared comparability remain unauthenticated.', 'No API/model call, deployment, publication or upload occurred.'],
  }, null, 2) + '\n');
} finally { await rm(root, { recursive: true, force: true }); }

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { runContractScenario, type ContractScenario, type ScenarioResult } from './helpers/sandcastle-fixture.js';

// Every scenario uses the real @ai-hero/sandcastle public API in an authored,
// clean-environment worker. The transport is local test code, NOT isolation.
async function check(scenario: ContractScenario, verify: (result: ScenarioResult['observed']) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-sandcastle-contract-'));
  try {
    expect(relative(process.cwd(), root).startsWith('..')).toBe(true);
    const result = await runContractScenario(scenario, root);
    expect(result.scenario).toBe(scenario);
    expect(result.root).toBe(root);
    await verify(result.observed);
    expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(result);
  } finally {
    // Only this case's mkdtemp fixture is removed, after evidence checks/teardown.
    await rm(root, { recursive: true, force: true });
  }
}

test('raw Sandcastle reuses a dirty managed branch and ignores a new base', async () => {
  await check('reuse', async result => {
    expect(result.reusedPath).toBe(result.originalPath);
    expect(result.actualHead).toBe(result.expectedHead);
    expect(result.actualHead).not.toBe(result.requestedNewBase);
    expect(result.preservedWorktreePath).toBe(result.originalPath);
    expect(await readFile(result.evidencePath as string, 'utf8')).toBe('retain dirty evidence\n');
  });
}, 35_000);

test('pre-aborted Worktree.run rejects with the exact reason before provider setup', async () => {
  await check('preabort', result => {
    expect(result).toEqual({ sameReason: true, created: 0, worktreePreserved: true });
  });
}, 35_000);

test('public provider transfers a complete-history bundle and supports cwd, stdin, live lines, and nonzero exit', async () => {
  await check('bundle', result => {
    expect(result.head).toBe(result.expectedHead);
    expect(result.shallow).toBe('false');
    expect(result.objectTypes).toEqual(['commit', 'commit', 'commit']);
    expect(result.laterVersion).toBe('version-3');
    expect(result.bundleCopied).toBe(true);
    expect(result.lines).toEqual(['first', 'second']);
    expect(result.streamedBeforeExit).toBe(true);
    expect(result.exitCode).toBe(7);
    expect(result.stdin).toBe('stdin proof\n');
    expect(result.cwd).toBe(result.transportWorktreePath);
    expect(result.environmentKeys).toEqual(result.expectedEnvironmentKeys);
    expect(result.closed).toBe(true);
    expect(result.activeProcesses).toBe(0);
    expect(result.hostWorktreePreserved).toBe(true);
  });
}, 35_000);

test('mid-run cancellation stops the authored process, retains evidence, and permits another run', async () => {
  await check('cancel', async result => {
    expect(result.sameReason).toBe(true);
    expect(result.closed).toBe(true);
    expect(result.activeProcesses).toBe(0);
    expect(result.processStopped).toBe(true);
    expect(result.hostWorktreePreserved).toBe(true);
    expect(await readFile(result.evidencePath as string, 'utf8')).toBe('partial result\n');
    expect(await readFile(result.eventsPath as string, 'utf8')).toContain('FIXTURE_STARTED');
    expect(await readFile(result.logPath as string, 'utf8')).toContain('FIXTURE_STARTED');
    expect(result.resumedOutput).toContain('resumed fixture');
    expect(result.handlesCreated).toBe(2);
    expect(result.allHandlesClosed).toBe(true);
    // Remote uncommitted bytes are evidence; abort does not promise host sync.
    expect(typeof result.partialSyncedToHost).toBe('boolean');
  });
}, 35_000);

test('failed authored agent retains stderr, output bytes, and transport logs until evidence is checked', async () => {
  await check('failure', async result => {
    expect(result.rejected).toBe(true);
    expect(result.failure).toContain('DELIBERATE_FIXTURE_FAILURE');
    expect(result.closed).toBe(true);
    expect(result.activeProcesses).toBe(0);
    expect(result.hostWorktreePreserved).toBe(true);
    expect(await readFile(result.evidencePath as string, 'utf8')).toBe('failed output\n');
    expect(await readFile(result.failurePath as string, 'utf8')).toContain('DELIBERATE_FIXTURE_FAILURE');
    const events = JSON.parse(await readFile(result.eventsPath as string, 'utf8')) as { type: string; stderr?: string; exitCode?: number }[];
    expect(events.some(event => event.type === 'exit' && event.exitCode === 23 && event.stderr?.includes('DELIBERATE_FIXTURE_FAILURE'))).toBe(true);
    expect((await readFile(result.logPath as string, 'utf8')).length).toBeGreaterThan(0);
  });
}, 35_000);

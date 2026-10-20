import { expect, test } from 'vitest';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { boundedProcessBytes } from '../src/workspace/process.js';

test('pre-aborted process never starts', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(boundedProcessBytes('/nonexistent-command', [], '/tmp', 1024, true, 1000, undefined, controller.signal)).rejects.toThrow(/before spawn/);
});

test('abort terminates an owned real child and same-group descendant before rejecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-process-cancel-'));
  const ready = join(root, 'ready');
  const controller = new AbortController();
  const grandchild = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000);`;
  const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1]],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const result = boundedProcessBytes(process.execPath, ['-e', child, ready], root, 4096, true, 5000, undefined, controller.signal)
    .then(() => null, error => error);
  try {
    for (let i = 0; i < 200 && !await access(ready).then(() => true, () => false); i++) await delay(10);
    const pid = Number(await readFile(ready, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect(String(await result)).toMatch(/cancelled/);
    // A zombie is terminated but awaits its parent/init reaper; PID existence
    // alone must not be interpreted as a still-running process.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat) expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
  } finally { controller.abort(); await result; await rm(root, { recursive: true, force: true }); }
});


test('pre-aborted runnable command creates no marker; failed spawn removes abort listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-preabort-'));
  try {
    const controller = new AbortController(); controller.abort();
    const marker = join(root, 'must-not-exist');
    await expect(boundedProcessBytes(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],'started')", marker], root,
      4096, true, 1000, undefined, controller.signal)).rejects.toThrow(/before spawn/);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const failed = new AbortController();
    await expect(boundedProcessBytes(join(root, 'missing-executable'), [], root, 4096, true, 1000, undefined, failed.signal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getEventListeners(failed.signal, 'abort')).toHaveLength(0);
    failed.abort();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('post-close cancellation has no listener and does not change an accepted result', async () => {
  const controller = new AbortController();
  const result = await boundedProcessBytes(process.execPath, ['-e', "process.stdout.write('finished')"], tmpdir(), 4096, true, 1000, undefined, controller.signal);
  expect(result.toString()).toBe('finished');
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  controller.abort();
  expect(result.toString()).toBe('finished');
});

test('owned direct child cancels with detached=false without signalling the parent process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-direct-cancel-'));
  const ready = join(root, 'ready'), controller = new AbortController();
  const result = boundedProcessBytes(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)", ready], root,
    4096, false, 3000, undefined, controller.signal).then(() => null, error => error);
  try {
    for (let i = 0; i < 200 && !await access(ready).then(() => true, () => false); i++) await delay(10);
    expect(await readFile(ready, 'utf8')).toBe('ready');
    controller.abort();
    expect(String(await result)).toMatch(/cancelled/);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally { controller.abort(); await result; await rm(root, { recursive: true, force: true }); }
});

test('real child exit racing cancellation settles with no residual abort listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-exit-race-'));
  try {
    for (let i = 0; i < 8; i++) {
      const ready = join(root, String(i)), controller = new AbortController();
      const result = boundedProcessBytes(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],'ready');setTimeout(()=>process.stdout.write('finished'),2)", ready], root,
        4096, true, 3000, undefined, controller.signal).then(value => ({ value }), error => ({ error }));
      try {
        for (let n = 0; n < 200 && !await access(ready).then(() => true, () => false); n++) await delay(1);
        await access(ready);
        if (i % 2) await delay(3);
        controller.abort();
        const outcome = await result;
        if ('error' in outcome) expect(String(outcome.error)).toMatch(/cancelled/);
        else expect(outcome.value.toString()).toBe('finished');
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally { controller.abort(); await result; }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

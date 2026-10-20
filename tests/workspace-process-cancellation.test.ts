import { expect, test } from 'vitest';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (stat) expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
  } finally { controller.abort(); await result; await rm(root, { recursive: true, force: true }); }
});

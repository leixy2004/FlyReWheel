import { fork } from 'node:child_process';
import { lstat, mkdtemp, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExecResult } from '@ai-hero/sandcastle';
import { withWorkspaceTransferGuard, type WorkspaceRecord } from './index.js';
import { workspaceEnvironment } from './process.js';

export interface SandcastleTransferTarget {
  exec(command: string, cwd?: string): Promise<ExecResult>;
  upload(path: string, data: AsyncIterable<Uint8Array>): Promise<void>;
}
/** Sandcastle owns bundle creation/clone; host Git runs with an explicit safe env.
 * Trusted store disk quota remains a deployment requirement: upstream creates
 * the bundle on disk before copyIn. No unbounded file is read into parent memory.
 */
export async function transferSandcastleWorkspace(workspace: Readonly<WorkspaceRecord>, target: SandcastleTransferTarget,
  options: { maxBundleBytes: number; signal: AbortSignal }): Promise<void> {
  return withWorkspaceTransferGuard(workspace, () => transferOwned(workspace, target, options));
}

async function transferOwned(workspace: Readonly<WorkspaceRecord>, target: SandcastleTransferTarget,
  options: { maxBundleBytes: number; signal: AbortSignal }): Promise<void> {
  if (!Number.isSafeInteger(options.maxBundleBytes) || options.maxBundleBytes < 1 || options.maxBundleBytes > 1_073_741_824) throw new Error('Invalid Sandcastle bundle bound');
  options.signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-transfer-'));
  await mkdir(join(root, 'tmp'));
  const source = fileURLToPath(new URL('./sandcastle-transfer-process.js', import.meta.url));
  const script = import.meta.url.endsWith('.ts') ? source.replace(/\.js$/, '.ts') : source;
  const child = fork(script, [workspace.repoPath, workspace.branch, workspace.baseSha, workspace.worktreePath, '/workspace/repo'], {
    cwd: workspace.repoPath, detached: true, silent: true,
    execArgv: script.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [],
    env: { ...workspaceEnvironment(), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: join(root, 'tmp') },
  });
  let failure: Error | undefined, complete = false, outputBytes = 0, operations = 0;
  const pending = new Set<Promise<void>>();
  const fail = () => {
    failure ??= new Error('Sandcastle transfer failed, exceeded bounds, or was cancelled');
    if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = new Error('Sandcastle transfer termination failed'); }
  };
  options.signal.addEventListener('abort', fail, { once: true });
  if (options.signal.aborted) fail();
  const timer = setTimeout(fail, 300_000);
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > 65_536) fail(); });
  child.on('message', (message: { id?: number; operation?: string; args?: unknown[] }) => {
    if (failure) return;
    if (message.operation === 'complete') { complete = true; return; }
    if (!Number.isSafeInteger(message.id) || ++operations > 32 || pending.size) { fail(); return; }
    const operation = (async () => {
      options.signal.throwIfAborted();
      const args = message.args;
      if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== 'string'
        || (args[1] !== null && args[1] !== undefined && typeof args[1] !== 'string')) throw new Error('Invalid transfer request');
      let value: unknown;
      if (message.operation === 'exec') {
        if (Buffer.byteLength(args[0]) > 4096 || (args[1] && args[1] !== '/workspace/repo')) throw new Error('Invalid transfer command');
        value = await target.exec(args[0], typeof args[1] === 'string' ? args[1] : undefined);
      } else if (message.operation === 'upload') {
        const source = args[0], destination = args[1] as string;
        const rel = relative(join(root, 'tmp'), source);
        if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || await realpath(source) !== source
          || !/^\/tmp\/sandcastle-[a-zA-Z0-9]+\/repo\.bundle$/.test(destination)) throw new Error('Invalid bundle transfer path');
        const handle = await open(source, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile() || (await lstat(source)).isSymbolicLink() || info.size > options.maxBundleBytes) throw new Error('Invalid/oversized Sandcastle bundle');
          async function* chunks() {
            const buffer = Buffer.alloc(65_536); let total = 0;
            for (;;) {
              options.signal.throwIfAborted();
              const { bytesRead } = await handle.read(buffer);
              if (!bytesRead) return;
              total += bytesRead; if (total > options.maxBundleBytes) throw new Error('Sandcastle bundle exceeds limit');
              yield Uint8Array.from(buffer.subarray(0, bytesRead));
            }
          }
          await target.upload(destination, chunks());
        } finally { await handle.close(); }
      } else throw new Error('Unsupported transfer operation');
      if (!failure && !options.signal.aborted && child.connected) child.send({ id: message.id, value });
    })().catch(fail);
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => { fail(); reject(failure); });
      child.once('close', code => { if (code !== 0 || !complete || failure) reject(failure ?? new Error('Sandcastle transfer did not complete')); else resolve(); });
    });
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', fail);
    // Preserve local partial bundle on a failed transfer for bounded manual recovery.
    if (!failure && complete) await rm(root, { recursive: true, force: true });
    await Promise.all(pending);
  }
}

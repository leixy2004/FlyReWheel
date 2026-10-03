// Trusted, clean-environment child. Only public Sandcastle APIs; no agent, hooks,
// config, copy paths, sync-back, credential forwarding, or host repo execution.
import { createWorktree, createIsolatedSandboxProvider, type ExecResult } from '@ai-hero/sandcastle';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const [repoPath, branch, sha, worktreePath, remotePath] = process.argv.slice(2);
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
process.on('message', (message: { id: number; value?: unknown; error?: string }) => {
  const task = pending.get(message.id); if (!task) return;
  pending.delete(message.id);
  if (message.error) task.reject(new Error('OpenSandbox transfer operation failed')); else task.resolve(message.value);
});
function rpc(operation: string, args: unknown[]): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.send!({ id, operation, args }); });
}
try {
  if (!/^attempt\/[a-z0-9-]+--[a-z0-9-]+$/.test(branch) || !/^[a-f0-9]{40}$/.test(sha)
    || remotePath !== '/workspace/repo') throw new Error('Invalid transfer identity');
  for (const path of [repoPath, worktreePath]) {
    await lstat(join(path, '.sandcastle', '.env')).then(() => { throw new Error('Sandcastle env forwarding is forbidden'); }, error => { if (error.code !== 'ENOENT') throw error; });
  }
  const worktree = await createWorktree({ cwd: repoPath, branchStrategy: { type: 'branch', branch, baseBranch: sha } });
  if (await realpath(worktree.worktreePath) !== worktreePath) throw new Error('Sandcastle transfer identity mismatch');
  const provider = createIsolatedSandboxProvider({ name: 'flyrewheel-opensandbox', create: async ({ env }) => {
    if (Object.keys(env).length) throw new Error('Sandcastle attempted environment forwarding');
    return {
      worktreePath: remotePath,
      exec: async (command, options) => {
        if (options?.stdin !== undefined || options?.sudo || options?.onLine) throw new Error('Unsupported transfer command');
        return await rpc('exec', [command, options?.cwd]) as ExecResult;
      },
      copyIn: async (source, destination) => { await rpc('upload', [source, destination]); },
      copyFileOut: async () => { throw new Error('Workspace sync-back is forbidden'); },
      close: async () => { /* Runtime lifecycle belongs exclusively to the parent. */ },
    };
  } });
  const sandbox = await worktree.createSandbox({ sandbox: provider });
  await sandbox.close(); // Does not close/remove the existing host worktree.
  process.send!({ operation: 'complete' });
  process.disconnect?.();
} catch {
  process.send?.({ operation: 'failed' }); process.exitCode = 1; process.disconnect?.();
}

// Private process bridge, not a sandbox or an agent runner. Only real public Sandcastle APIs.
import { createWorktree } from '@ai-hero/sandcastle';
import { realpath } from 'node:fs/promises';
import { boundedProcess, workspaceIndexFlags } from './process.js';

// Stay in the bridge's process group so the coordinator also terminates these children.
const workspaceGit = (cwd: string, ...args: string[]) => boundedProcess('git', args, cwd, 8_000_000, false);

const [operation, repoPath, branch, baseSha, expectedPath, expectedHead] = process.argv.slice(2);
try {
  if (!['prepare', 'cleanup'].includes(operation) || !/^attempt\/[a-z0-9-]+--[a-z0-9-]+$/.test(branch)
    || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('Invalid internal workspace request');
  const worktree = await createWorktree({ cwd: repoPath, branchStrategy: { type: 'branch', branch, baseBranch: baseSha } });
  if (await realpath(worktree.worktreePath) !== expectedPath
    || (await workspaceGit(expectedPath, 'rev-parse', 'HEAD')).trim() !== expectedHead
    || (await workspaceGit(expectedPath, 'branch', '--show-current')).trim() !== branch) {
    throw new Error('Sandcastle identity mismatch; worktree retained for investigation');
  }
  if (operation === 'cleanup') {
    // Upstream ignores ignored files and can swallow removal failures. Fail closed here.
    if ((await workspaceGit(expectedPath, 'status', '--porcelain=v1', '--untracked-files=all')).trim()
      || (await workspaceGit(expectedPath, 'ls-files', '--others', '-z')).length) {
      throw new Error('Worktree changed during cleanup; retained');
    }
    const indexFlags = await workspaceIndexFlags(expectedPath, workspaceGit);
    if (indexFlags.assumeUnchangedPaths.length || indexFlags.skipWorktreePaths.length) {
      throw new Error('Git index assume-unchanged or skip-worktree flags prevent verifying tracked-file cleanliness; worktree retained');
    }
    await worktree.close();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

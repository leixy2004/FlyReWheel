import type { Command } from 'commander';
import { createLocalDevelopmentWorkspace, inspectLocalDevelopmentWorkspace, cleanupLocalDevelopmentWorkspace,
  readLocalDevelopmentEvidence, StoredLocalDevelopmentWorkspaceSchema } from './local-development-workspace.js';
export function registerLocalDevelopmentWorkspaceCommands(workspace: Command, json: (path: string) => Promise<unknown>, output: (value: unknown, path?: string) => Promise<void>) {
  const local = workspace.command('local').description('Development-only managed Git worktrees and verifiable evidence; no model or production sandbox authority');
  local.command('create').requiredOption('--file <file>', 'Strict {repoPath,selection}; exact existing application workspace selection')
    .option('--out <file>').action(async options => { await output(await createLocalDevelopmentWorkspace(await json(options.file) as Parameters<typeof createLocalDevelopmentWorkspace>[0]), options.out); });
  for (const action of ['status', 'cleanup', 'evidence'] as const) {
    const command = local.command(action).requiredOption('--file <file>', 'Exact receipt returned by local create').option('--out <file>');
    if (action === 'evidence') command.requiredOption('--digest <sha256>');
    command.action(async options => {
      const receipt = StoredLocalDevelopmentWorkspaceSchema.parse(await json(options.file));
      const result = action === 'status' ? await inspectLocalDevelopmentWorkspace(receipt)
        : action === 'cleanup' ? await cleanupLocalDevelopmentWorkspace(receipt) : await readLocalDevelopmentEvidence(receipt, options.digest);
      await output(result, options.out);
      if (action === 'cleanup' && 'cleanup' in result && result.cleanup === 'retained') process.exitCode = 2;
    });
  }
}

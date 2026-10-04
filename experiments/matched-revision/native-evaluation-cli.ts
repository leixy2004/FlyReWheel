import { Command } from 'commander';
import { registerEvaluationWorkspaceCommands } from '../../src/cli-evaluation-workspace.js';

// Same command chain as the main evaluation CLI; usable before shared registration lands.
const cli = new Command('evaluation');
registerEvaluationWorkspaceCommands(cli);
await cli.parseAsync().catch(error => {
  process.stderr.write(`FlyReWheel: ${error instanceof Error ? error.message : 'Evaluation command failed'}\n`);
  process.exitCode = 1;
});

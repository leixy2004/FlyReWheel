import type { Command } from 'commander';
import { databaseCommand, storeFor } from './cli-database.js';
import { miningChoices, preparePrMiningRequest, selectMiningEvidence } from './pr-mining-preparation.js';
import { MiningStatementSelectionSchema } from './core/pr-mining.js';

function selectionOptions(command: Command) {
  return command.option('--evidence-digest <sha256>', 'Exact stored PR evidence, exclusive with batch/number')
    .option('--batch <sha256>', 'Exact stored history batch; requires --number').option('--number <number>', 'Captured PR number in selected batch')
    .option('--out <file>');
}
function selection(options: { evidenceDigest?: string; batch?: string; number?: string }) {
  return { ...(options.evidenceDigest !== undefined ? { evidenceDigest: options.evidenceDigest } : {}),
    ...(options.batch !== undefined ? { batch: options.batch } : {}),
    ...(options.number !== undefined ? { number: Number(options.number) } : {}) };
}
function statement(value: string) {
  if (value === 'pull') return MiningStatementSelectionSchema.parse({ kind: 'pull' });
  const match = /^(issue-comment|review|review-comment):([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error('Statement must be pull, issue-comment:<id>, review:<id>, or review-comment:<id>');
  return MiningStatementSelectionSchema.parse({ kind: match[1], id: Number(match[2]) });
}
export function registerPrMiningPreparationCommands(parent: Command, output: (value: unknown, path?: string) => Promise<void>) {
  selectionOptions(databaseCommand(parent, 'choices').description('List every changed side and discussion record in selected PR evidence; no mining'))
    .action(async options => {
      const store = await storeFor(options);
      try { await output(miningChoices(await selectMiningEvidence(store, selection(options))), options.out); }
      finally { await store.close(); }
    });
  selectionOptions(databaseCommand(parent, 'prepare').description('Prepare existing request input for inspection; does not freeze, mine, or activate'))
    .requiredOption('--id <id>').requiredOption('--rule-id <id>').requiredOption('--rule-version <version>')
    .option('--parent-digest <sha256>', 'Existing parent rule; omitted for a new root')
    .requiredOption('--objective <text>').requiredOption('--actor <text>').requiredOption('--source <source>', 'fixture or supplied; caller-declared provenance')
    .requiredOption('--created-at <iso-time>')
    .option('--before <paths...>', 'Exact before-side paths').option('--after <paths...>', 'Exact after-side paths')
    .option('--all-captured', 'Explicitly select every captured side; exceeding 32 fails, never truncates')
    .requiredOption('--statement <selections...>', 'Explicit pull / issue-comment:<id> / review:<id> / review-comment:<id>')
    .action(async options => {
      const statements = options.statement.map(statement);
      const sources = options.before || options.after ? [
        ...(options.before ?? []).map((path: string) => ({ side: 'before' as const, path })),
        ...(options.after ?? []).map((path: string) => ({ side: 'after' as const, path })) ] : undefined;
      const store = await storeFor(options);
      try {
        const evidence = await selectMiningEvidence(store, selection(options));
        await output(preparePrMiningRequest(evidence, { id: options.id, requestedRule: { ruleId: options.ruleId, version: options.ruleVersion, parentDigest: options.parentDigest ?? null },
          objective: options.objective, actor: options.actor, source: options.source, createdAt: options.createdAt,
          statements, sources, ...(options.allCaptured ? { allCaptured: true } : {}) }), options.out);
      } finally { await store.close(); }
    });
}

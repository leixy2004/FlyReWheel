import type { Command } from 'commander';
import { z } from 'zod';
import { readEvaluationJson, writeEvaluationJson } from './paired-evaluation.js';
import { createPreparedEvaluationWorkspaceResolver, PreparedEvaluationWorkspaceResolverConfigSchema } from './prepared-evaluation-workspace-resolver.js';
import { digestOf } from './core/identity.js';

const Selection = PreparedEvaluationWorkspaceResolverConfigSchema.shape.entries.element.shape.selection;
const Deadline = z.coerce.number().int().min(1).max(300_000);

/** Read-only CLI composition. This does not load a transport or enter a study. */
export function registerEvaluationWorkspaceCommands(evaluation: Command) {
  evaluation.command('workspace').description('Verify an existing prepared evaluation workspace; no model, runtime, or study dispatch')
    .command('resolve')
    .requiredOption('--registry <file>', 'Trusted offline-study registry JSON, at most 2 MB')
    .requiredOption('--selection <file>', 'Exact job/export selection JSON, at most 16 KB')
    .option('--timeout-ms <milliseconds>', 'Result acceptance deadline; active Git checks retain their own process bounds', '30000')
    .option('--out <new-file>', 'Write a new immutable inspection report; never overwrite')
    .action(async options => {
      const timeoutMs = Deadline.parse(options.timeoutMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Evaluation resolution deadline exceeded')), timeoutMs);
      try {
        const registry = PreparedEvaluationWorkspaceResolverConfigSchema.parse(await readEvaluationJson(options.registry, 2_000_000));
        const selection = Selection.parse(await readEvaluationJson(options.selection, 16_384));
        controller.signal.throwIfAborted();
        const resolution = await createPreparedEvaluationWorkspaceResolver(registry)(selection, controller.signal);
        controller.signal.throwIfAborted();
        const result = { schemaVersion: 1, kind: 'prepared-evaluation-workspace-inspection',
          purpose: registry.purpose, registryDigest: digestOf(registry), selectionDigest: digestOf(selection),
          selection, resolution, modelExecution: 'not_run', runtimeExecution: 'not_run',
          nativeStudyExecution: 'not_run', limits: { inputRegistryBytes: 2_000_000, inputSelectionBytes: 16_384, timeoutMs },
          nextActions: [
            'Application execution requires separately configured model settings, resource limits and verified lifecycle authority.',
            'Native matched study requires frozen packet/future inputs and an evaluation-aware request/checkpoint contract; this lookup does not supply that bridge.',
          ] };
        if (options.out) await writeEvaluationJson(options.out, result);
        else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally { clearTimeout(timer); }
    });
}

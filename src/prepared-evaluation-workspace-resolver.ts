import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { ApplicationDispatcherDependencies } from './application-dispatcher.js';
import { digestOf } from './core/identity.js';
import { inspectWorkspace, WorkspaceShaSchema } from './workspace/index.js';
import { verifyEvaluationWorkspace } from './workspace/evaluation-checkout.js';
import { EvaluationWorkspaceBindingSchema } from './workspace/history-policy.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Selection = z.object({
  workspaceId: z.string().min(1).max(200), jobDigest: Digest,
  repository: z.string().min(1).max(300),
  kind: z.enum(['pr-mining', 'semantic-review', 'revision-generation']),
  baseSha: WorkspaceShaSchema, headSha: WorkspaceShaSchema, expectedSha: WorkspaceShaSchema,
  evaluationExportId: EvaluationWorkspaceBindingSchema.shape.exportId,
}).strict();

/** Trusted administrator configuration for an explicitly selected offline study.
 * Queued jobs cannot supply this configuration, paths, purpose, or visibility policy.
 */
export const PreparedEvaluationWorkspaceResolverConfigSchema = z.object({
  schemaVersion: z.literal(1), purpose: z.literal('offline-study'),
  entries: z.array(z.object({
    selection: Selection,
    workspace: z.object({
      repoPath: z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path,
        'Use an absolute canonical repository path'), runId: Id, attemptId: Id,
    }).strict(),
    manifestDigest: Digest,
    evaluation: EvaluationWorkspaceBindingSchema,
  }).strict()).max(1000),
}).strict();
export type PreparedEvaluationWorkspaceResolverConfig = z.infer<typeof PreparedEvaluationWorkspaceResolverConfigSchema>;

/** Reopen an existing prepared evaluation workspace, preserving its complete binding.
 * This performs read-only verification; it never prepares, widens, leases or executes a workspace.
 */
export function createPreparedEvaluationWorkspaceResolver(raw: unknown): NonNullable<ApplicationDispatcherDependencies['resolveWorkspace']> {
  const config = PreparedEvaluationWorkspaceResolverConfigSchema.parse(raw);
  const entries = new Map<string, typeof config.entries[number]>();
  for (const entry of config.entries) {
    if (entry.selection.evaluationExportId !== entry.evaluation.exportId
      || entry.selection.repository !== entry.evaluation.repositoryId
      || entry.selection.expectedSha !== entry.evaluation.checkoutSha) {
      throw new Error('Evaluation registry selection/binding mismatch');
    }
    const key = digestOf(entry.selection);
    if (entries.has(key)) throw new Error('Duplicate prepared evaluation workspace selection');
    entries.set(key, entry);
  }
  return async (selection, signal) => {
    signal.throwIfAborted();
    const selected = Selection.parse(selection);
    const entry = entries.get(digestOf(selected));
    if (!entry) throw new Error('Prepared evaluation workspace selection is not authorized');
    const canonical = await realpath(entry.workspace.repoPath);
    signal.throwIfAborted();
    if (canonical !== entry.workspace.repoPath) throw new Error('Prepared evaluation repository path is not canonical');
    const { record, observation } = await inspectWorkspace(entry.workspace);
    signal.throwIfAborted();
    // The shared verifier intentionally accepts ordinary workspaces; require provenance here.
    if (!record.evaluation) throw new Error('Prepared evaluation workspace binding is required');
    if (digestOf(record) !== entry.manifestDigest) throw new Error('Prepared evaluation workspace manifest digest changed');
    if (digestOf(record.evaluation.binding) !== digestOf(entry.evaluation)) {
      throw new Error('Prepared evaluation workspace binding changed');
    }
    if (record.status !== 'ready' || !observation.worktreeExists || !observation.identityValid
      || !observation.cleanlinessVerified || observation.currentHeadSha !== selected.expectedSha
      || record.baseSha !== selected.expectedSha || record.initialHeadSha !== selected.expectedSha) {
      throw new Error('Prepared evaluation workspace is not ready, clean and at the exact authorized SHA');
    }
    // Reinspect the immutable baseline and exact derived object/ref closure, not just JSON hashes.
    await verifyEvaluationWorkspace(record);
    signal.throwIfAborted();
    return { workspace: { ...entry.workspace }, evaluation: structuredClone(entry.evaluation) };
  };
}

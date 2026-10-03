import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { ApplicationDispatcherDependencies } from './application-dispatcher.js';
import { digestOf } from './core/identity.js';
import { inspectWorkspace, WorkspaceShaSchema } from './workspace/index.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Selection = z.object({
  workspaceId: z.string().min(1).max(200), jobDigest: Digest,
  repository: z.string().min(1).max(500),
  kind: z.enum(['pr-mining', 'semantic-review', 'revision-generation']),
  baseSha: WorkspaceShaSchema, headSha: WorkspaceShaSchema, expectedSha: WorkspaceShaSchema,
}).strict();
/** Administrator-owned configuration, never loaded from a queued job. Evaluation is intentionally unsupported. */
export const PreparedWorkspaceResolverConfigSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(z.object({
    selection: Selection,
    workspace: z.object({ repoPath: z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path,
      'Use an absolute canonical repository path'), runId: Id, attemptId: Id }).strict(),
    manifestDigest: Digest,
  }).strict()).max(1000),
}).strict();
export type PreparedWorkspaceResolverConfig = z.infer<typeof PreparedWorkspaceResolverConfigSchema>;

/** Resolve an exact authorized selection against a freshly inspected, already prepared workspace.
 * No preparation, checkout, network request, lease acquisition or recovery is performed here.
 */
export function createPreparedWorkspaceResolver(raw: unknown): NonNullable<ApplicationDispatcherDependencies['resolveWorkspace']> {
  const config = PreparedWorkspaceResolverConfigSchema.parse(raw); // Parse copies caller-owned JSON.
  const entries = new Map<string, typeof config.entries[number]>();
  for (const entry of config.entries) {
    const key = digestOf(entry.selection);
    if (entries.has(key)) throw new Error('Duplicate prepared workspace selection');
    entries.set(key, entry);
  }
  return async (selection, signal) => {
    signal.throwIfAborted();
    if (selection.evaluationExportId !== undefined) throw new Error('Prepared workspace resolver does not support evaluation exports');
    const selected = Selection.parse(selection);
    const entry = entries.get(digestOf(selected));
    if (!entry) throw new Error('Prepared workspace selection is not authorized');
    const canonical = await realpath(entry.workspace.repoPath);
    signal.throwIfAborted();
    if (canonical !== entry.workspace.repoPath) throw new Error('Prepared repository path is not canonical');
    const { record, observation } = await inspectWorkspace(entry.workspace);
    signal.throwIfAborted();
    if (record.evaluation !== undefined) throw new Error('Prepared workspace resolver does not support evaluation workspaces');
    if (digestOf(record) !== entry.manifestDigest) throw new Error('Prepared workspace manifest digest changed');
    if (record.status !== 'ready' || !observation.worktreeExists || !observation.identityValid
      || !observation.cleanlinessVerified || observation.currentHeadSha !== selected.expectedSha
      || record.baseSha !== selected.expectedSha || record.initialHeadSha !== selected.expectedSha) {
      throw new Error('Prepared workspace is not ready, clean and at the exact authorized SHA');
    }
    return { ...entry.workspace };
  };
}

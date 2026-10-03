import { deriveEvaluationRepository, evaluationWorkspaceBinding, inspectEvaluationCheckout, type EvaluationVisibilityManifest } from './evaluation-checkout.js';
import { prepareWorkspace, type WorkspaceIdentity } from './index.js';

/** Trusted local bootstrap only. Queue jobs select logical exports through a resolver.
 * The immutable export is never passed to Sandcastle as its mutable repository.
 */
export async function prepareEvaluationWorkspace(input: WorkspaceIdentity & {
  exportId: string; storePath: string; manifest: EvaluationVisibilityManifest; headSha?: string;
}) {
  const baseline = await inspectEvaluationCheckout(input);
  const binding = evaluationWorkspaceBinding(input.exportId, baseline);
  const evaluation = await deriveEvaluationRepository({ repoPath: input.repoPath, storePath: input.storePath,
    manifest: input.manifest, binding });
  const prepared = await prepareWorkspace({ repoPath: input.repoPath, runId: input.runId, attemptId: input.attemptId,
    baseSha: binding.checkoutSha, ...(input.headSha ? { headSha: input.headSha } : {}), evaluation });
  return { ...prepared, evaluation: binding };
}

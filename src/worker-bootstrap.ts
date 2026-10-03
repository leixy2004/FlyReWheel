import { z } from 'zod';
import { IdSchema } from './core/model.js';
import { PrMiningModelLimitsSchema } from './core/pr-mining-model.js';
import { CodexWorkspaceLimits, CodexWorkspaceRequestSchema } from './workspace/codex-runner.js';
import { createOpenSandboxWorkspaceBackend, type OpenSandboxWorkspaceDependencies } from './adapters/opensandbox-workspace.js';
import type { ApplicationDispatcherDependencies } from './application-dispatcher.js';
import { startWorkerService, type WorkerServiceOptions } from './worker-service.js';

const Endpoint = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Expected a credential-free HTTPS endpoint');
const Runtime = z.object({
  id: IdSchema,
  backend: z.literal('opensandbox'),
  endpoint: Endpoint,
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  cpu: z.string().regex(/^[1-9][0-9]*m?$|^0\.[0-9]+$/),
  memory: z.string().regex(/^[1-9][0-9]*(Mi|Gi)$/),
  maxBundleBytes: z.number().int().min(1).max(1_073_741_824),
  workerExecutable: z.string().regex(/^\/opt\/flyrewheel\/[a-zA-Z0-9/._-]+$/)
    .refine(value => !value.split('/').includes('..')),
  gatewayHost: z.string().regex(/^(?!.*\.\.)(?!.*[\/:*])[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
  limits: CodexWorkspaceLimits,
}).strict();

/** Deployment configuration, never a queue payload. No executable module or secret value is accepted. */
export const WorkerBootstrapConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  model: CodexWorkspaceRequestSchema.shape.model.optional(),
  generationLimits: PrMiningModelLimitsSchema.optional(),
  runtime: Runtime.optional(),
}).strict();
export type WorkerBootstrapConfig = z.input<typeof WorkerBootstrapConfigSchema>;
export interface WorkerBootstrapDependencies extends OpenSandboxWorkspaceDependencies {
  /** Only the explicitly named key is consulted; values are never included in inspection output. */
  environment?: Readonly<Record<string, string | undefined>>;
  resolveWorkspace?: ApplicationDispatcherDependencies['resolveWorkspace'];
}
export type WorkerBootstrapIssueCode = 'invalid_configuration' | 'disabled' | 'model_required'
  | 'generation_limits_required' | 'runtime_required' | 'workspace_limits_exceed_generation'
  | 'lifecycle_authority_required' | 'workspace_resolver_required' | 'api_key_required';
export interface WorkerBootstrapIssue { code: WorkerBootstrapIssueCode; nextAction: string }
export interface WorkerBootstrapInspection {
  status: 'disabled' | 'blocked' | 'configured';
  issues: WorkerBootstrapIssue[];
  nextActions: string[];
  liveVerification: 'not_run';
}
const actions: Record<WorkerBootstrapIssueCode, string> = {
  invalid_configuration: 'Supply strict schemaVersion 1 worker configuration: only OpenSandbox, an HTTPS endpoint without credentials/query/fragment, a digest-pinned image, apiKeyEnv, and bounded limits. Do not include secrets or executable modules.',
  disabled: 'Explicitly enable the reviewed worker configuration before composing application execution.',
  model_required: 'Select an explicit model in the deployment configuration.',
  generation_limits_required: 'Supply explicit generation input/output byte limits and timeoutMs.',
  runtime_required: 'Supply the fixed OpenSandbox deployment settings and workspace limits.',
  workspace_limits_exceed_generation: 'Keep workspace maxOutputBytes and timeoutMs within the corresponding generation limits.',
  lifecycle_authority_required: 'Inject deployment code implementing preflight, stopAndVerify, collectFrozen, and destroyAndVerify; a JSON declaration cannot establish lifecycle authority.',
  workspace_resolver_required: 'Inject a trusted resolver for already prepared, authorized workspace identities and exact evaluation bindings.',
  api_key_required: 'Provision the nonempty credential in the environment variable explicitly named by runtime.apiKeyEnv.',
};
const report = (codes: WorkerBootstrapIssueCode[], disabled = false): WorkerBootstrapInspection => ({
  status: codes.length ? disabled ? 'disabled' : 'blocked' : 'configured',
  issues: codes.map(code => ({ code, nextAction: actions[code] })), nextActions: codes.map(code => actions[code]),
  liveVerification: 'not_run',
});
function authorityPresent(authority: WorkerBootstrapDependencies['authority']): boolean {
  return !!authority && ['preflight', 'stopAndVerify', 'collectFrozen', 'destroyAndVerify']
    .every(method => typeof authority[method as keyof typeof authority] === 'function');
}

/** Pure wiring inspection. Does not invoke resolver, authority, SDK, preflight or reserve.
 * Configured means dependencies are present, not that deployment checks have passed.
 */
export function inspectWorkerBootstrap(raw: unknown = undefined, deps: WorkerBootstrapDependencies = {}): WorkerBootstrapInspection {
  const parsed = WorkerBootstrapConfigSchema.safeParse(raw === undefined ? {} : raw);
  if (!parsed.success) return report(['invalid_configuration']);
  const config = parsed.data;
  const issues: WorkerBootstrapIssueCode[] = [];
  if (!config.enabled) issues.push('disabled');
  if (!config.model) issues.push('model_required');
  if (!config.generationLimits) issues.push('generation_limits_required');
  if (!config.runtime) issues.push('runtime_required');
  if (!authorityPresent(deps.authority)) issues.push('lifecycle_authority_required');
  if (typeof deps.resolveWorkspace !== 'function') issues.push('workspace_resolver_required');
  if (config.runtime) {
    const key = (deps.environment ?? process.env)[config.runtime.apiKeyEnv];
    if (typeof key !== 'string' || !key.trim()) issues.push('api_key_required');
    if (config.generationLimits && (config.runtime.limits.maxOutputBytes > config.generationLimits.maxOutputBytes
      || config.runtime.limits.timeoutMs > config.generationLimits.timeoutMs)) issues.push('workspace_limits_exceed_generation');
  }
  return report(issues, !config.enabled);
}

export class WorkerBootstrapBlockedError extends Error {
  readonly code = 'WORKER_BOOTSTRAP_BLOCKED';
  constructor(readonly inspection: WorkerBootstrapInspection) {
    super(`Worker bootstrap blocked: ${inspection.issues.map(issue => issue.code).join(', ')}`);
    this.name = 'WorkerBootstrapBlockedError';
  }
}

/** Compose the existing dispatcher runtime. Its mining/review/revision adapters
 * use createCodexWorkspaceRunner; this function never starts or reserves it.
 * Test SDK/transfer implementations are trusted code dependencies only.
 */
export function composeWorkerApplication(raw: unknown, deps: WorkerBootstrapDependencies = {}): NonNullable<WorkerServiceOptions['application']> {
  const inspection = inspectWorkerBootstrap(raw, deps);
  if (inspection.status !== 'configured') throw new WorkerBootstrapBlockedError(inspection);
  const config = WorkerBootstrapConfigSchema.parse(raw), runtime = config.runtime!;
  const { id, backend: _backend, apiKeyEnv, limits, ...settings } = runtime;
  const backend = createOpenSandboxWorkspaceBackend({ ...settings, apiKey: (deps.environment ?? process.env)[apiKeyEnv]! }, {
    authority: deps.authority, createSandbox: deps.createSandbox, transfer: deps.transfer,
  });
  return Object.freeze({
    config: Object.freeze({ enabled: true, model: config.model!, limits: Object.freeze(config.generationLimits!) }),
    runtime: Object.freeze({ id, backend, limits: Object.freeze(limits) }),
    resolveWorkspace: deps.resolveWorkspace!,
  });
}

/** Trusted deployment code supplies authority and workspace resolution explicitly.
 * Composition must pass before the existing service can open health/queue work.
 */
export function startConfiguredWorkerService(raw: unknown, deps: WorkerBootstrapDependencies,
  serviceOptions: Omit<WorkerServiceOptions, 'application'>) {
  const application = composeWorkerApplication(raw, deps);
  return startWorkerService({ ...serviceOptions, application });
}

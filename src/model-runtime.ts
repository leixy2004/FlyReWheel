import { createCodexAgentAdapter } from './adapters/index.js';
import { z } from 'zod';
import { digestOf } from './core/index.js';
import { AgentDecisionSchema, SEMANTIC_SYSTEM } from './adapters/model-contract.js';

/** Bump the explicit revisions when adapter/tool-policy or prompt construction changes. */
export const CodexExecutionConfigSchema = z.object({
  adapter: z.literal('codex_sdk'),
  adapterRevision: z.literal('codex-sdk-adapter-v1'),
  sdkVersion: z.literal('0.159.2'),
  promptDigest: z.literal(digestOf({ system: SEMANTIC_SYSTEM, task: 'independent_candidate_adjudication', revision: 'semantic-v1', outputSchema: z.toJSONSchema(AgentDecisionSchema) })),
  toolPolicyRevision: z.literal('isolated-readonly-no-tools-v1'),
  reasoningEffort: z.literal('low'),
  model: z.string().trim().min(1), authMode: z.enum(['account', 'api']),
  timeoutMs: z.number().int().positive().max(300_000),
  maxReportedTokens: z.number().int().positive().max(1_000_000),
  maxInputBytes: z.number().int().positive().max(2_097_152),
}).strict();
export type CodexExecutionConfig = z.infer<typeof CodexExecutionConfigSchema>;

/** Safe to persist in a job: no credentials, credential digests, home paths or ambient secrets. */
export function resolveCodexExecutionConfig(env: NodeJS.ProcessEnv): CodexExecutionConfig {
  if (env.QE_ENABLE_MODEL !== 'true') throw new Error('Set QE_ENABLE_MODEL=true explicitly to permit external Codex inference');
  if (!env.QE_CODEX_MODEL) throw new Error('Set an explicit QE_CODEX_MODEL supported by your account');
  if (env.QE_CODEX_AUTH_MODE !== 'account' && env.QE_CODEX_AUTH_MODE !== 'api') throw new Error('Choose QE_CODEX_AUTH_MODE=account or api explicitly; there is no automatic billing fallback');
  return CodexExecutionConfigSchema.parse({
    adapter: 'codex_sdk', adapterRevision: 'codex-sdk-adapter-v1', sdkVersion: '0.159.2',
    promptDigest: CodexExecutionConfigSchema.shape.promptDigest.value,
    toolPolicyRevision: 'isolated-readonly-no-tools-v1', reasoningEffort: 'low',
    model: env.QE_CODEX_MODEL, authMode: env.QE_CODEX_AUTH_MODE,
    timeoutMs: Number(env.QE_MODEL_TIMEOUT_MS ?? 120000),
    maxReportedTokens: Number(env.QE_MODEL_TOKEN_ACCEPTANCE_LIMIT ?? 30000),
    maxInputBytes: Number(env.QE_MODEL_MAX_INPUT_BYTES ?? 262144),
  });
}

/** Only invoked by an explicit --enable-model command or a deliberately enabled worker. */
export function configuredCodex(env: NodeJS.ProcessEnv, expectedConfig?: CodexExecutionConfig) {
  const executionConfig = resolveCodexExecutionConfig(env);
  if (expectedConfig && digestOf(CodexExecutionConfigSchema.parse(expectedConfig)) !== digestOf(executionConfig)) throw new Error('Worker model configuration differs from the frozen job configuration; use a matching worker or enqueue an explicit new job');
  const common = { enabled: true, model: executionConfig.model, timeoutMs: executionConfig.timeoutMs, maxReportedTokens: executionConfig.maxReportedTokens, maxInputBytes: executionConfig.maxInputBytes };
  if (executionConfig.authMode === 'account') {
    if (!env.QE_CODEX_HOME) throw new Error('Account mode requires a user-authorized dedicated QE_CODEX_HOME');
    return { ...createCodexAgentAdapter({ ...common, auth: { mode: 'dedicated_login', codexHome: env.QE_CODEX_HOME } }), executionConfig };
  }
  if (!env.QE_CODEX_API_KEY) throw new Error('Explicit API mode requires QE_CODEX_API_KEY; this uses separate API billing');
  return { ...createCodexAgentAdapter({ ...common, auth: { mode: 'api_key', apiKey: env.QE_CODEX_API_KEY } }), executionConfig };
}

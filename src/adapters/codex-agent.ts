import { Codex, type CodexOptions, type ThreadItem, type Usage } from '@openai/codex-sdk';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AgentDecisionSchema, SynthesisResponseSchema, SEMANTIC_SYSTEM, synthesisPrompt, validateSynthesisInput, type SynthesisInput, type SynthesisOutcome } from './model-contract.js';
import { validateDecisionEvidence, validateSynthesisDraft } from './model-validation.js';
import { checkAdjudicationInput, failedOutcome, missingEvidenceOutcome, type AdjudicationInput, type SemanticOutcome } from './semantic.js';

const ConfigSchema = z.object({
  enabled: z.boolean(), model: z.string().min(1), timeoutMs: z.number().int().positive().max(300_000), maxInputBytes: z.number().int().positive().max(2_097_152).default(262_144),
  /** Postflight acceptance ceiling, not a provider-side token/spending cap. */
  maxReportedTokens: z.number().int().positive().max(1_000_000),
  auth: z.discriminatedUnion('mode', [z.object({ mode: z.literal('api_key'), apiKey: z.string().min(1) }).strict(), z.object({ mode: z.literal('dedicated_login'), codexHome: z.string().refine(isAbsolute, 'CODEX_HOME must be absolute') }).strict()]),
}).strict();
export type CodexAgentConfig = z.input<typeof ConfigSchema>;
const FORBIDDEN_ITEMS = new Set<ThreadItem['type']>(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/** Official SDK, one independent thread/turn per request. No CLI transcript parser or ambient credentials. */
export function createCodexAgentAdapter(rawConfig: CodexAgentConfig) {
  const config = ConfigSchema.parse(rawConfig);
  async function runStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<{ value: T; sessionId: string; usage: Usage }> {
    if (!config.enabled) throw new Error('Live Codex SDK use is disabled; opt in explicitly');
    if (Buffer.byteLength(prompt, 'utf8') > config.maxInputBytes) throw new Error('Semantic input exceeds configured byte limit');
    const directory = await mkdtemp(join(tmpdir(), 'flyrewheel-codex-'));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = join(directory, 'work'), freshHome = join(directory, 'home');
      await mkdir(work); await mkdir(freshHome);
      let codexHome = join(directory, 'codex');
      if (config.auth.mode === 'dedicated_login') {
        codexHome = config.auth.codexHome;
        // Inspect names only. Never read, copy, parse, or log auth.json / tokens.
        // A dedicated login home avoids inheriting plugins, MCP servers, hooks or user configuration.
        const entries = await readdir(codexHome);
        const allowed = /^(auth\.json|version\.json|models_cache\.json|sessions|log|logs|tmp|state_\d+\.sqlite(?:-shm|-wal)?|history\.jsonl|\.installation_id)$/;
        if (!entries.includes('auth.json')) throw new Error('Dedicated login home must be explicitly provisioned by the user with file-backed Codex login');
        if (entries.some(entry => !allowed.test(entry))) throw new Error('Dedicated login home contains configuration or unrecognized files; use an isolated login-only CODEX_HOME');
      } else await mkdir(codexHome);
      const options: CodexOptions = {
        ...(config.auth.mode === 'api_key' ? { apiKey: config.auth.apiKey } : {}),
        env: { HOME: freshHome, CODEX_HOME: codexHome, PATH: dirname(process.execPath) },
        config: {
          features: { shell_tool: false, unified_exec: false, shell_snapshot: false, hooks: false, multi_agent: false, apps: false, memories: false, goals: false, skill_mcp_dependency_install: false },
          tools: { view_image: false }, web_search: 'disabled', project_doc_max_bytes: 0, project_doc_fallback_filenames: [],
          shell_environment_policy: { inherit: 'none' }, history: { persistence: 'none' }, analytics: { enabled: false },
        },
      };
      const thread = new Codex(options).startThread({ model: config.model, sandboxMode: 'read-only', workingDirectory: work, skipGitRepoCheck: true, modelReasoningEffort: 'low', networkAccessEnabled: false, webSearchMode: 'disabled', approvalPolicy: 'never', additionalDirectories: [] });
      const execute = async () => {
        const stream = await thread.runStreamed(`${SEMANTIC_SYSTEM}\n\n${prompt}`, { outputSchema: z.toJSONSchema(schema), signal: controller.signal });
        let response: string | undefined, usage: Usage | undefined;
        for await (const event of stream.events) {
          if (event.type === 'error') throw new Error(`Codex SDK error: ${event.message}`);
          if (event.type === 'turn.failed') throw new Error(`Codex SDK turn failed: ${event.error.message}`);
          if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
            if (FORBIDDEN_ITEMS.has(event.item.type)) { controller.abort(); throw new Error(`Unexpected tool activity: ${event.item.type}`); }
            if (event.item.type === 'error') throw new Error(`Codex SDK item error: ${event.item.message}`);
            if (event.type === 'item.completed' && event.item.type === 'agent_message') response = event.item.text;
          }
          if (event.type === 'turn.completed') usage = event.usage;
        }
        if (!response || !usage) throw new Error('Codex SDK stream ended without a completed structured result and usage');
        if (![usage.input_tokens, usage.output_tokens].every(value => Number.isFinite(value) && value >= 0) || usage.input_tokens + usage.output_tokens > config.maxReportedTokens) throw new Error('Codex usage exceeds the postflight token acceptance limit');
        return { value: schema.parse(JSON.parse(response)), sessionId: thread.id ?? 'unreported', usage };
      };
      return await Promise.race([execute(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Codex SDK call timed out')); }, config.timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); await rm(directory, { recursive: true, force: true }); }
  }
  return {
    async adjudicate(input: AdjudicationInput): Promise<SemanticOutcome> {
      try {
        const missing = checkAdjudicationInput(input);
        if (missing.length) return missingEvidenceOutcome('codex_sdk', input, missing, config.model);
        const result = await runStructured(JSON.stringify({ task: 'independent_candidate_adjudication', candidate: input.candidate, source: input.source, skill: input.skill, evidence: input.evidence }), AgentDecisionSchema);
        validateDecisionEvidence(input, result.value);
        return { execution: 'succeeded', adjudication: { ...result.value, source: 'agent' }, missingEvidence: [], error: null, metadata: { mode: 'codex_sdk', origin: 'model', model: config.model, sessionId: result.sessionId, costUsd: null, usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } } };
      } catch (error) { return failedOutcome('codex_sdk', error instanceof Error ? error.message : 'Codex adjudication failed', config.model); }
    },
    async synthesize(input: SynthesisInput): Promise<SynthesisOutcome> {
      try {
        validateSynthesisInput(input);
        const result = await runStructured(synthesisPrompt(input), SynthesisResponseSchema);
        const synthesis = result.value.result;
        const metadata = { mode: 'codex_sdk' as const, model: config.model, sessionId: result.sessionId, costUsd: null };
        if (synthesis.status === 'insufficient_evidence') return { execution: 'succeeded', status: 'no_rule', draft: null, reasoning: synthesis.reasoning, missingEvidence: synthesis.missingEvidence, validations: [], metadata };
        const validations = validateSynthesisDraft(input, synthesis);
        return { execution: 'succeeded', draft: synthesis, validations, metadata, status: 'draft_requires_review' };
      } catch (error) { return { execution: 'failed', error: error instanceof Error ? error.message : 'Codex synthesis failed' }; }
    },
  };
}

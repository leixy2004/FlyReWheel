import OpenAI from 'openai';
import { z } from 'zod';
import { AgentDecisionSchema, SynthesisResponseSchema, SEMANTIC_SYSTEM, synthesisPrompt, validateSynthesisInput, type SynthesisInput, type SynthesisOutcome } from './model-contract.js';
import { validateDecisionEvidence, validateSynthesisDraft } from './model-validation.js';
import { checkAdjudicationInput, failedOutcome, missingEvidenceOutcome, type AdjudicationInput, type SemanticOutcome } from './semantic.js';

const ConfigSchema = z.object({
  enabled: z.boolean(), baseURL: z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, 'Use an explicit HTTP(S) API endpoint without embedded credentials'),
  apiKey: z.string().min(1), model: z.string().min(1), timeoutMs: z.number().int().positive().max(300_000),
  maxOutputTokens: z.number().int().positive().max(32_768), maxInputBytes: z.number().int().positive().max(2_097_152).default(262_144),
  /** JSON-only compatibility is an explicit weaker option; never silently downgrade schema support. */
  responseFormat: z.enum(['json_schema', 'json_object']),
}).strict();
export type OpenAICompatibleConfig = z.input<typeof ConfigSchema>;

/** Optional self-hosted vLLM/Ollama-compatible inference via the official OpenAI SDK. No agent/tool loop. */
export function createOpenAICompatibleAdapter(rawConfig: OpenAICompatibleConfig) {
  const config = ConfigSchema.parse(rawConfig);
  async function runStructured<T>(prompt: string, schema: z.ZodType<T>) {
    if (!config.enabled) throw new Error('Live compatible-model use is disabled; opt in explicitly');
    if (Buffer.byteLength(prompt, 'utf8') > config.maxInputBytes) throw new Error('Semantic input exceeds configured byte limit');
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0 });
    const jsonSchema = z.toJSONSchema(schema);
    const response = await client.chat.completions.create({
      model: config.model, messages: [{ role: 'system', content: SEMANTIC_SYSTEM }, { role: 'user', content: config.responseFormat === 'json_object' ? `${prompt}\nReturn a JSON object conforming to this schema: ${JSON.stringify(jsonSchema)}` : prompt }],
      response_format: config.responseFormat === 'json_schema' ? { type: 'json_schema', json_schema: { name: 'qual_evo_evidence_result', strict: true, schema: jsonSchema } } : { type: 'json_object' },
      max_completion_tokens: config.maxOutputTokens, tools: [], store: false,
    });
    const choice = response.choices[0];
    if (!choice || choice.finish_reason !== 'stop' || choice.message.refusal || choice.message.tool_calls?.length || !choice.message.content) throw new Error('Compatible model did not return a complete, non-refused JSON answer');
    return { value: schema.parse(JSON.parse(choice.message.content)), sessionId: response.id, usage: response.usage };
  }
  return {
    async adjudicate(input: AdjudicationInput): Promise<SemanticOutcome> {
      try {
        const missing = checkAdjudicationInput(input);
        if (missing.length) return missingEvidenceOutcome('openai_compatible', input, missing, config.model);
        const result = await runStructured(JSON.stringify({ task: 'independent_candidate_adjudication', candidate: input.candidate, source: input.source, skill: input.skill, evidence: input.evidence }), AgentDecisionSchema);
        validateDecisionEvidence(input, result.value);
        return { execution: 'succeeded', adjudication: { ...result.value, source: 'agent' }, missingEvidence: [], error: null, metadata: { mode: 'openai_compatible', origin: 'model', model: config.model, sessionId: result.sessionId, costUsd: null, ...(result.usage ? { usage: { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens } } : {}) } };
      } catch (error) { return failedOutcome('openai_compatible', error instanceof Error ? error.message : 'Compatible model adjudication failed', config.model); }
    },
    async synthesize(input: SynthesisInput): Promise<SynthesisOutcome> {
      try {
        validateSynthesisInput(input);
        const result = await runStructured(synthesisPrompt(input), SynthesisResponseSchema);
        const synthesis = result.value.result;
        const metadata = { mode: 'openai_compatible' as const, model: config.model, sessionId: result.sessionId, costUsd: null };
        if (synthesis.status === 'insufficient_evidence') return { execution: 'succeeded', status: 'no_rule', draft: null, reasoning: synthesis.reasoning, missingEvidence: synthesis.missingEvidence, validations: [], metadata };
        const validations = validateSynthesisDraft(input, synthesis);
        return { execution: 'succeeded', draft: synthesis, validations, metadata, status: 'draft_requires_review' };
      } catch (error) { return { execution: 'failed', error: error instanceof Error ? error.message : 'Compatible rule synthesis failed' }; }
    },
  };
}

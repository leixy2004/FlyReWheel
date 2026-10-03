import { z } from 'zod';

/** Evidence is the installed SDK 0.159.2 ThreadOptions/TurnOptions, not guessed
 * CLI configuration keys. Observed usage and prompt wording are not controls. */
export const MATCHED_CODEX_CAPABILITIES = Object.freeze({
  sdk: '@openai/codex-sdk', version: '0.159.2',
  temperature: 'unsupported', seed: 'unsupported', maxOutputTokens: 'unsupported',
  modelTokenizer: 'unavailable', costMicros: 'unreported',
  outputBytes: 'supervised', wallClock: 'supervised', tokenUsage: 'reported-postflight',
  tools: 'selected-evidence-no-tools-v1', isolation: 'requires-external-runtime',
} as const);

export const MatchedRequiredControlsSchema = z.object({
  sampler: z.object({ temperature: z.number().min(0).max(2),
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const MatchedCodexExecutionSchema = z.discriminatedUnion('kind', [
  MatchedRequiredControlsSchema.extend({ kind: z.literal('enforce-frozen-controls') }).strict(),
  // Accepted only with the explicitly authored executable boundary. This is
  // never an operational study configuration or a production fallback.
  z.object({ kind: z.literal('authored-script-controls-not-enforced') }).strict(),
  z.object({ kind: z.literal('authored-sdk-native-no-model') }).strict(),
]);
export type MatchedCodexExecution = z.infer<typeof MatchedCodexExecutionSchema>;

export function preflightMatchedCodexControls(controls: z.input<typeof MatchedRequiredControlsSchema>) {
  const required = MatchedRequiredControlsSchema.parse(controls);
  return { supported: false as const, capabilities: MATCHED_CODEX_CAPABILITIES,
    required, unsupportedControls: ['sampler.temperature', 'sampler.seed', 'maxOutputTokens'] as const };
}

export function enforceMatchedCodexExecution(execution: MatchedCodexExecution, boundary: string | undefined) {
  if (execution.kind === 'enforce-frozen-controls') {
    const result = preflightMatchedCodexControls({ sampler: execution.sampler, maxOutputTokens: execution.maxOutputTokens });
    throw new Error(`Codex matched controls unsupported before dispatch: ${result.unsupportedControls.join(', ')}`);
  }
  if (boundary !== 'authored-test-no-isolation') throw new Error('Authored matched control exception requires an authored executable boundary');
}

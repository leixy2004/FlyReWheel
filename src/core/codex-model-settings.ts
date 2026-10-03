import type { ModelReasoningEffort } from '@openai/codex-sdk';
import { z } from 'zod';

/** Pinned SDK 0.159.2 ThreadOptions, not guessed CLI keys or a model default.
 * Keep optional fields optional at every boundary: omission means unspecified.
 */
export const CODEX_MODEL_REASONING_EFFORTS = [
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent',
] as const satisfies readonly ModelReasoningEffort[];
export const CodexModelReasoningEffortSchema = z.enum(CODEX_MODEL_REASONING_EFFORTS);

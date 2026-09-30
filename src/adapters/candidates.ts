import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PositionSchema = z.object({ line: z.number().int().positive(), column: z.number().int().positive(), offset: z.number().int().nonnegative() }).strict();
export const SpanSchema = z.object({ start: PositionSchema, end: PositionSchema }).strict();
export type SourceSpan = z.infer<typeof SpanSchema>;
export const CandidateSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), ruleId: z.string().min(1), ruleVersion: z.string().min(1), bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1), language: z.string().min(1), engine: z.enum(['ast-grep', 'semgrep', 'opengrep']),
  span: SpanSchema, matchedText: z.string().min(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), scanScope: z.literal('full_file'),
}).strict();
export type Candidate = z.infer<typeof CandidateSchema>;
export interface RuleIdentity { ruleId: string; ruleVersion: string; bundleDigest: string }
export function sourceDigest(source: string): string { return createHash('sha256').update(source, 'utf8').digest('hex'); }

/** Positions use 1-based lines/columns and 0-based UTF-16 offsets, end-exclusive. */
export function sourcePosition(source: string, offset: number): z.infer<typeof PositionSchema> {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) throw new Error('Source offset out of bounds');
  const prefix = source.slice(0, offset);
  return { line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n'), offset };
}
export function makeCandidate(input: RuleIdentity & { source: string; path: string; language: string; engine: Candidate['engine']; start: number; end: number }): Candidate {
  if (input.end <= input.start) throw new Error('Candidate span must be nonempty');
  const span = { start: sourcePosition(input.source, input.start), end: sourcePosition(input.source, input.end) };
  const digest = sourceDigest(input.source);
  const id = sourceDigest(JSON.stringify([input.ruleId, input.ruleVersion, input.bundleDigest, input.path, digest, span, input.engine]));
  return CandidateSchema.parse({ id, ruleId: input.ruleId, ruleVersion: input.ruleVersion, bundleDigest: input.bundleDigest, path: input.path, language: input.language, engine: input.engine, span, matchedText: input.source.slice(input.start, input.end), sourceDigest: digest, scanScope: 'full_file' });
}
export function validateCandidateAnchor(candidate: Candidate, source: string): void {
  CandidateSchema.parse(candidate);
  if (sourceDigest(source) !== candidate.sourceDigest) throw new Error('Candidate source digest mismatch');
  if (candidate.span.end.offset <= candidate.span.start.offset) throw new Error('Invalid candidate span');
  for (const side of ['start', 'end'] as const) {
    const expected = sourcePosition(source, candidate.span[side].offset);
    if (expected.line !== candidate.span[side].line || expected.column !== candidate.span[side].column) throw new Error('Candidate position does not match source offset');
  }
  if (source.slice(candidate.span.start.offset, candidate.span.end.offset) !== candidate.matchedText) throw new Error('Candidate anchor does not match source');
  const expectedId = makeCandidate({ ...candidate, source, start: candidate.span.start.offset, end: candidate.span.end.offset }).id;
  if (candidate.id !== expectedId) throw new Error('Candidate identity does not bind to its rule, source, and span');
}
/** Scanner CLI offsets are UTF-8 bytes. Reject offsets inside a multibyte code point. */
export function utf8ByteOffsetToUtf16(source: string, byteOffset: number): number {
  const bytes = Buffer.from(source, 'utf8');
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > bytes.length) throw new Error('Invalid UTF-8 source offset');
  const prefix = bytes.subarray(0, byteOffset).toString('utf8');
  if (!Buffer.from(prefix, 'utf8').equals(bytes.subarray(0, byteOffset))) throw new Error('Source offset splits a UTF-8 character');
  return prefix.length;
}

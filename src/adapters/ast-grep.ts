import { Lang, parse, registerDynamicLanguage } from '@ast-grep/napi';
import langPython from '@ast-grep/lang-python';
import { makeCandidate, utf8ByteOffsetToUtf16, validateCandidateAnchor, type Candidate, type RuleIdentity } from './candidates.js';

// Official prebuilt grammar; one central dynamic-language registration per module/process.
// Do not register repository-provided parsers or execute target Python code.
registerDynamicLanguage({ python: langPython });

const languages: Record<string, Lang | string> = { python: 'python', py: 'python', typescript: Lang.TypeScript, ts: Lang.TypeScript, javascript: Lang.JavaScript, js: Lang.JavaScript, tsx: Lang.Tsx, jsx: Lang.Tsx };
export interface AstGrepInput extends RuleIdentity { source: string; path: string; language: string; pattern: string; maxSourceBytes?: number; maxCandidates?: number }
export class DetectorError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'DetectorError'; } }

/** Real native ast-grep matching across the entire supplied file; no changed-line filtering. */
export function detectAstGrep(input: AstGrepInput): Candidate[] {
  const language = languages[input.language.toLowerCase()];
  if (!language) throw new DetectorError('unsupported_language', `Unsupported registered ast-grep language: ${input.language}`);
  if (!input.pattern.trim() || input.pattern.length > 16_384) throw new DetectorError('invalid_pattern', 'Pattern must be nonempty and at most 16 KiB');
  const maxBytes = Math.min(input.maxSourceBytes ?? 1_048_576, 8_388_608);
  const maxCandidates = Math.min(input.maxCandidates ?? 1_000, 10_000);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxCandidates) || maxCandidates <= 0) throw new DetectorError('invalid_limits', 'Detector limits must be positive integers');
  if (Buffer.byteLength(input.source, 'utf8') > maxBytes) throw new DetectorError('source_limit', 'Source exceeds configured detector limit');
  try {
    const root = parse(language, input.source).root();
    if (root.find({ rule: { kind: 'ERROR' } })) throw new DetectorError('parse_error', 'Source contains a parser error; coverage is unverified');
    if (language === 'python') {
      // The pinned napi API exposes neither hasError nor isMissing. Tree-sitter
      // recovery can insert zero-width delimiters/blocks without an ERROR node.
      // Conservatively reject any zero-width descendant (an empty module is OK).
      const remaining = [...root.children()];
      while (remaining.length) {
        const node = remaining.pop()!;
        const range = node.range();
        if (range.start.index === range.end.index) throw new DetectorError('parse_error', 'Python syntax contains a missing or empty recovery node; coverage is unverified');
        remaining.push(...node.children());
      }
    }
    const matches = root.findAll({ rule: { pattern: input.pattern } });
    if (matches.length > maxCandidates) throw new DetectorError('candidate_limit', 'Candidate limit exceeded; results are not silently truncated');
    return matches.map(node => {
      const range = node.range();
      let start = range.start.index, end = range.end.index;
      // Native 0.45.x returns JS string offsets despite older typings describing byte offsets.
      if (input.source.slice(start, end) !== node.text()) {
        start = utf8ByteOffsetToUtf16(input.source, start); end = utf8ByteOffsetToUtf16(input.source, end);
      }
      const candidate = makeCandidate({ ...input, engine: 'ast-grep', start, end });
      if (candidate.matchedText !== node.text()) throw new DetectorError('invalid_anchor', 'Native scanner match does not agree with source');
      validateCandidateAnchor(candidate, input.source);
      return candidate;
    });
  } catch (error) {
    if (error instanceof DetectorError) throw error;
    throw new DetectorError('scanner_error', error instanceof Error ? error.message : 'Native scanner failed');
  }
}

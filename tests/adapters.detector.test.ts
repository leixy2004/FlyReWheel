import { describe, expect, it } from 'vitest';
import { detectAstGrep, DetectorError } from '../src/adapters/ast-grep.js';
import { sourceDigest, validateCandidateAnchor } from '../src/adapters/candidates.js';
import { parseSemgrepJson } from '../src/adapters/semgrep.js';
import { adjudicateOfflineFixture } from '../src/adapters/semantic.js';

const base = { path: 'src/input.ts', language: 'typescript', pattern: 'eval($ARG)', ruleId: 'avoid-global-eval', ruleVersion: '1.0.0', bundleDigest: 'a'.repeat(64) };
const skill = { title: 'Avoid dynamic code execution', invariant: 'Do not execute untrusted input with global eval', applicability: ['Calls to global eval'], exceptions: ['A local function binding called eval does not execute code'], requiredContext: ['binding-resolution'] };

describe('native ast-grep detector', () => {
  it('recalls a real pre-fix AST match and stays silent after the fix', () => {
    expect(detectAstGrep({ ...base, source: 'export const parse = (input: string) => eval(input);' })).toHaveLength(1);
    expect(detectAstGrep({ ...base, source: 'export const parse = (input: string) => JSON.parse(input);' })).toHaveLength(0);
  });
  it('does not scan strings/comments with regex, and matches calls with whitespace', () => {
    const source = '// eval(unsafe)\nconst s = "eval(unsafe)";\neval (\n input\n);';
    const matches = detectAstGrep({ ...base, source });
    expect(matches).toHaveLength(1);
    expect(matches[0].span.start.line).toBe(3);
  });
  it('scans the full file, including matches outside a changed line', () => {
    const source = 'const unchanged = eval(input);\n// This is the only changed line';
    expect(detectAstGrep({ ...base, source })[0].span.start.line).toBe(1);
  });
  it('validates Unicode anchors and stable candidate identity', () => {
    const source = '// 😀 中文\nconst text = "😀"; const y = eval(input);';
    const candidate = detectAstGrep({ ...base, source })[0];
    expect(candidate.span.start.offset).toBe(source.indexOf('eval'));
    expect(candidate.matchedText).toBe('eval(input)');
    expect(() => validateCandidateAnchor(candidate, source)).not.toThrow();
    expect(detectAstGrep({ ...base, source })[0].id).toBe(candidate.id);
    expect(() => validateCandidateAnchor(candidate, source + '\n')).toThrow('digest');
    expect(() => validateCandidateAnchor({ ...candidate, matchedText: 'wrong' }, source)).toThrow('anchor');
    expect(() => validateCandidateAnchor({ ...candidate, ruleVersion: 'other-version' }, source)).toThrow('identity');
  });
  it('does not hide parser errors, unsupported languages, or truncated coverage', () => {
    expect(() => detectAstGrep({ ...base, source: 'const x = {' })).toThrow(DetectorError);
    expect(() => detectAstGrep({ ...base, source: 'eval(x)', language: 'not-a-registered-language' })).toThrow('Unsupported');
    expect(() => detectAstGrep({ ...base, source: 'eval(x); eval(y)', maxCandidates: 1 })).toThrow('not silently truncated');
  });
});

describe('explicit offline fixture adjudication', () => {
  const source = 'function demo(eval: (s: string) => string) { return eval(input); }';
  const candidate = detectAstGrep({ ...base, source })[0];
  const evidence = [{ id: 'binding-1', kind: 'binding-resolution', content: 'The eval symbol resolves to the local function parameter, a string formatter.' }];
  const fixture = { fixtureId: 'hard-negative-local-binding', candidateId: candidate.id, candidateSourceDigest: sourceDigest(source), matchedText: candidate.matchedText, decision: 'safe' as const, reasoning: 'The local binding is a string formatter, not global code execution.', evidenceRefs: ['binding-1'] };
  it('keeps the hard negative as an AST candidate and rejects only with required context', () => {
    const result = adjudicateOfflineFixture({ candidate, source, skill, evidence }, fixture);
    expect(result.execution).toBe('succeeded');
    expect(result.adjudication?.decision).toBe('safe');
    expect(result.adjudication?.source).toBe('fixture');
    expect(result.metadata.mode).toBe('offline_fixture');
  });
  it('abstains on missing context instead of accepting a fixture verdict', () => {
    const result = adjudicateOfflineFixture({ candidate, source, skill, evidence: [] }, fixture);
    expect(result.adjudication?.decision).toBe('unknown');
    expect(result.missingEvidence).toEqual(['binding-resolution']);
    expect(result.metadata.origin).toBe('evidence_gate');
  });
  it('rejects stale source, fabricated references, and forged anchors', () => {
    expect(adjudicateOfflineFixture({ candidate, source: source + '\n', skill, evidence }, fixture).execution).toBe('failed');
    expect(adjudicateOfflineFixture({ candidate, source, skill, evidence }, { ...fixture, evidenceRefs: ['invented'] }).execution).toBe('failed');
    const badEvidence = [{ ...evidence[0], anchor: { path: base.path, sourceDigest: candidate.sourceDigest, span: candidate.span } }];
    expect(adjudicateOfflineFixture({ candidate, source, skill, evidence: badEvidence }, fixture).execution).toBe('failed');
  });
});

describe('Semgrep/OpenGrep JSON importer', () => {
  const source = '// 😀\neval(input);';
  const offset = Buffer.byteLength(source.slice(0, source.indexOf('eval')));
  const output = { results: [{ check_id: 'rule.eval', path: base.path, start: { line: 2, col: 1, offset }, end: { line: 2, col: 12, offset: offset + 11 }, extra: { message: 'Avoid eval', severity: 'WARNING', lines: 'eval(input);' } }], errors: [], paths: { scanned: [base.path] } };
  const options = { ...base, engine: 'opengrep' as const, sources: { [base.path]: source }, scanScope: 'full_file' as const, checkId: 'rule.eval' };
  it('normalizes authentic CLI-format byte offsets against supplied source', () => {
    const result = parseSemgrepJson(JSON.stringify(output), options);
    expect(result.complete).toBe(true);
    expect(result.scopeProvenance).toBe('caller_attested');
    expect(result.candidates[0].matchedText).toBe('eval(input)');
    expect(result.candidates[0].span.start.offset).toBe(source.indexOf('eval'));
  });
  it('preserves scanner errors and missing/stale source as incomplete coverage', () => {
    expect(parseSemgrepJson({ ...output, errors: [{ type: 'ParseError', message: 'Syntax error' }] }, options).complete).toBe(false);
    expect(parseSemgrepJson(output, { ...options, sources: {} }).errors[0]).toContain('Missing source');
    const malformed = structuredClone(output); malformed.results[0].start.line = 1;
    expect(parseSemgrepJson(malformed, options).complete).toBe(false);
    expect(parseSemgrepJson({ ...output, paths: { scanned: [] } }, options).errors).toContain(`No scanner coverage attestation for source: ${base.path}`);
  });
});


describe('official native Python grammar', () => {
  const pythonBase = { ...base, language: 'python', path: 'vllm/example.py', pattern: 'unsafe_load($ARG)' };
  it('recalls a Python pre-fix call and stays silent on its fixed version', () => {
    const before = 'def parse_input(text):\n    return unsafe_load(text)\n';
    const after = 'def parse_input(text):\n    return safe_load(text)\n';
    expect(detectAstGrep({ ...pythonBase, source: before })).toHaveLength(1);
    expect(detectAstGrep({ ...pythonBase, source: after })).toHaveLength(0);
    expect(detectAstGrep({ ...pythonBase, language: 'py', source: before })).toHaveLength(1);
  });
  it('validates Python Unicode offsets and ignores text inside strings/comments', () => {
    const source = '# 😀 中文 unsafe_load(comment)\nlabel = "unsafe_load(string)"\ntext = "😀"; value = unsafe_load(text)\n';
    const candidates = detectAstGrep({ ...pythonBase, source });
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate.span.start.offset).toBe(source.lastIndexOf('unsafe_load'));
    expect(candidate.span.start.line).toBe(3);
    expect(candidate.matchedText).toBe('unsafe_load(text)');
    expect(() => validateCandidateAnchor(candidate, source)).not.toThrow();
  });
  it('fails closed on ERROR nodes, missing delimiters, and invalid indentation', () => {
    for (const source of ['value = unsafe_load(\n', 'def broken(:\n    return unsafe_load(text)\n', 'def broken():\nvalue = unsafe_load(text)\n']) {
      expect(() => detectAstGrep({ ...pythonBase, source })).toThrow(DetectorError);
    }
    expect(detectAstGrep({ ...pythonBase, source: '' })).toEqual([]);
  });
});

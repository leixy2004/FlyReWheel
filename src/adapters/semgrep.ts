import { z } from 'zod';
import { makeCandidate, utf8ByteOffsetToUtf16, type Candidate, type RuleIdentity } from './candidates.js';

const CliPosition = z.object({ line: z.number().int().positive(), col: z.number().int().positive(), offset: z.number().int().nonnegative() }).passthrough();
const CliOutput = z.object({
  results: z.array(z.object({ check_id: z.string(), path: z.string(), start: CliPosition, end: CliPosition, extra: z.record(z.string(), z.unknown()).optional() }).passthrough()),
  errors: z.array(z.object({ message: z.string().optional(), type: z.string().optional() }).passthrough()).default([]),
  paths: z.object({ scanned: z.array(z.string()).optional() }).passthrough().optional(),
}).passthrough();
export interface SemgrepImportOptions extends RuleIdentity {
  engine: 'semgrep' | 'opengrep'; language: string; sources: Readonly<Record<string, string>>;
  /** The caller must attest that the CLI scanned full files (not a diff-only scan). */
  scanScope: 'full_file'; checkId: string;
}
export interface SemgrepImportResult { candidates: Candidate[]; errors: string[]; complete: boolean; scopeProvenance: 'caller_attested'; scannedPaths: string[] }

/** Import genuine `semgrep --json` / `opengrep --json` output; never execute project scripts or plugins. */
export function parseSemgrepJson(output: string | unknown, options: SemgrepImportOptions): SemgrepImportResult {
  if (options.scanScope !== 'full_file') throw new Error('Full-file scanner scope must be explicitly attested');
  if (typeof output === 'string' && Buffer.byteLength(output) > 16_777_216) throw new Error('Scanner JSON exceeds 16 MiB limit');
  const parsed = CliOutput.parse(typeof output === 'string' ? JSON.parse(output) : output);
  const errors = parsed.errors.map(error => error.message ?? error.type ?? 'Unspecified scanner error');
  const scannedPaths = parsed.paths?.scanned ?? [];
  for (const path of Object.keys(options.sources)) {
    if (!scannedPaths.includes(path)) errors.push(`No scanner coverage attestation for source: ${path}`);
  }
  const candidates: Candidate[] = [];
  for (const result of parsed.results.filter(match => match.check_id === options.checkId)) {
    const source = options.sources[result.path];
    if (typeof source !== 'string') { errors.push(`Missing source for scanner match: ${result.path}`); continue; }
    try {
      const start = utf8ByteOffsetToUtf16(source, result.start.offset), end = utf8ByteOffsetToUtf16(source, result.end.offset);
      const candidate = makeCandidate({ ...options, source, path: result.path, start, end });
      // Semgrep columns are byte columns; compare in its coordinate system before normalizing.
      for (const [side, position] of [['start', result.start], ['end', result.end]] as const) {
        const normalized = candidate.span[side];
        const prefix = source.slice(0, normalized.offset);
        const byteColumn = Buffer.byteLength(prefix.slice(prefix.lastIndexOf('\n') + 1), 'utf8') + 1;
        if (normalized.line !== position.line || byteColumn !== position.col) throw new Error('Scanner line/column disagrees with source offset');
      }
      candidates.push(candidate);
    } catch (error) { errors.push(`${result.path}: ${error instanceof Error ? error.message : 'Invalid scanner anchor'}`); }
  }
  return { candidates, errors, complete: errors.length === 0, scopeProvenance: 'caller_attested', scannedPaths };
}

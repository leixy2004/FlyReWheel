import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { detectAstGrep, sourceDigest } from '../../src/adapters/index.js';
import { digestOf } from '../../src/core/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const CaseSchema = z.object({
  id: z.string(), prUrl: z.string().url(), mergedAt: z.string(), baseSha: z.string(), headSha: z.string(),
  path: z.string(), beforeFile: z.string(), afterFile: z.string(), pattern: z.string(), rationale: z.string(),
  expectedCounts: z.object({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative() }),
}).passthrough();
const ManifestSchema = z.object({ schemaVersion: z.literal(1), repository: z.string(), cases: z.array(CaseSchema).min(1) }).passthrough();
const manifest = ManifestSchema.parse(JSON.parse(await readFile(resolve(root, 'cases.json'), 'utf8')));
async function source(relative: string) {
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) throw new Error('Fixture path escapes experiment directory');
  const bytes = await readFile(path);
  if (bytes.length > 1_000_000) throw new Error('Fixture exceeds scanner size bound');
  return bytes.toString('utf8');
}
const results = [];
for (const c of manifest.cases) {
  try {
    const before = await source(c.beforeFile), after = await source(c.afterFile);
    const bundleDigest = digestOf({ pattern: c.pattern, base: c.baseSha, head: c.headSha, path: c.path, origin: 'source-backed-retrospective-seed', engine: '@ast-grep/napi@0.45.3', grammar: '@ast-grep/lang-python@0.0.6' });
    const scan = (text: string) => detectAstGrep({ source: text, path: c.path, language: 'python', pattern: c.pattern, ruleId: c.id, ruleVersion: 'seed-1', bundleDigest });
    const beforeMatches = scan(before), afterMatches = scan(after);
    const commentOnlyBefore = scan('# FlyReWheel: inert replay comment\n' + before);
    const countsMatch = beforeMatches.length === c.expectedCounts.before && afterMatches.length === c.expectedCounts.after;
    results.push({
      id: c.id, prUrl: c.prUrl, mergedAt: c.mergedAt, baseSha: c.baseSha, headSha: c.headSha, path: c.path,
      pattern: c.pattern, rationale: c.rationale, execution: 'succeeded',
      sourceDigests: { before: sourceDigest(before), after: sourceDigest(after) }, bundleDigest,
      counts: { before: beforeMatches.length, after: afterMatches.length, expected: c.expectedCounts },
      detectorExpectationMatched: countsMatch,
      staticSeparationObserved: beforeMatches.length > 0 && afterMatches.length === 0,
      fixedCodeStillCandidate: afterMatches.length > 0,
      inertCommentPreservesMatches: commentOnlyBefore.length === beforeMatches.length,
      beforeAnchors: beforeMatches.map(m => ({ span: m.span, matchedText: m.matchedText })),
      afterAnchors: afterMatches.map(m => ({ span: m.span, matchedText: m.matchedText })),
      semanticStatus: 'not_verified', publication: 'disabled',
    });
  } catch (error) {
    results.push({ id: c.id, prUrl: c.prUrl, execution: 'failed', error: error instanceof Error ? error.message : 'Unknown scan failure', semanticStatus: 'not_verified', publication: 'disabled' });
  }
}
const report = {
  schemaVersion: 1, repository: manifest.repository,
  experiment: 'retrospective-static-seed-replay', engine: '@ast-grep/napi@0.45.3', grammar: '@ast-grep/lang-python@0.0.6',
  manifestDigest: digestOf(manifest), mode: 'real_native_static_detection',
  ruleAuthor: 'assistant-authored from public fix evidence; not generated through the application Codex adapter',
  summary: { cases: results.length, executionErrors: results.filter(r => r.execution === 'failed').length, detectorExpectationsMatched: results.filter(r => 'detectorExpectationMatched' in r && r.detectorExpectationMatched).length, staticSeparationCases: results.filter(r => 'staticSeparationObserved' in r && r.staticSeparationObserved).length, fixedCodeStillCandidateCases: results.filter(r => 'fixedCodeStillCandidate' in r && r.fixedCodeStillCandidate).length },
  limitations: [
    'Rules were authored with knowledge of these fixes. Their own before/after snapshots are training regressions, not heldout generalization.',
    'No application Codex inference, GPU workload, project test suite, or semantic adjudication was executed.',
    'A disappearing structural match is not proof of program correctness, rule precision, or bug recall.',
    'All results stay local. No GitHub comments, issues, pull requests, or statuses are published.',
  ], results,
};
await writeFile(resolve(root, 'static-replay-report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report.summary) + '\n');
if (report.summary.executionErrors || report.summary.detectorExpectationsMatched !== report.summary.cases) process.exitCode = 2;

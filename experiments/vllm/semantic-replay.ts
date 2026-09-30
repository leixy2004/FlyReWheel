import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredCodex } from '../../src/model-runtime.js';
import { detectAstGrep, sourceDigest, sourcePosition } from '../../src/adapters/index.js';
import { digestOf } from '../../src/core/index.js';

// This executable is deliberately separate from the default static experiment.
if (!process.argv.includes('--enable-model')) throw new Error('No inference performed. Explicit --enable-model and Codex authorization are required.');
const adapter = configuredCodex(process.env);
const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'cases.json'), 'utf8'));
const attemptIndex = process.argv.indexOf('--attempt');
const attempt = attemptIndex >= 0 ? process.argv[attemptIndex + 1] : 'initial';
if (!attempt) throw new Error('--attempt requires an identifier');
const selected = new Set(['vllm-pr-2664', 'vllm-pr-9034']);
const invariants: Record<string, string> = {
  'vllm-pr-2664': 'When engine_use_ray is true, a Ray actor method must be invoked with .remote(). Direct method invocation is valid in a branch where engine_use_ray is false.',
  'vllm-pr-9034': 'When delta extraction has zero new tokens, return an empty sequence. A slice using -num_new_tokens is safe only if zero is excluded before that path.',
};
const identity = { executionConfig: adapter.executionConfig, manifestDigest: digestOf(manifest), invariants, revision: 'vllm-semantic-seed-v1', attempt };
const runDigest = digestOf(identity);
const outDir = resolve(process.cwd(), '.flyrewheel/vllm-semantic', runDigest);
await mkdir(outDir, { recursive: true, mode: 0o700 });
const results: unknown[] = [];
for (const c of manifest.cases as Array<Record<string, string>>) {
  if (!selected.has(c.id!)) continue;
  // Serialized calls are intentional for one personal-account executor.
  for (const snapshot of ['before', 'after'] as const) {
    const fixturePath = resolve(root, c[`${snapshot}File`]!);
    if (!fixturePath.startsWith(root + sep)) throw new Error('Fixture path escapes experiment directory');
    const source = await readFile(fixturePath, 'utf8');
    const bundleDigest = digestOf({ invariant: invariants[c.id!], pattern: c.pattern, revision: 'seed-1' });
    const candidates = detectAstGrep({ source, path: c.path!, language: 'python', pattern: c.pattern!, ruleId: c.id!, ruleVersion: 'seed-1', bundleDigest });
    for (const candidate of candidates) {
      const callIdentity = digestOf({ runDigest, candidateId: candidate.id });
      const file = resolve(outDir, `${callIdentity}.json`);
      try {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (cached.callIdentity !== callIdentity) throw new Error('Cached semantic identity mismatch');
        results.push(cached); continue;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // No PR title, fix diff, expected labels, snapshot name or opposite-side source goes to Codex.
      const outcome = await adapter.adjudicate({
        candidate, source,
        skill: { title: 'Context-sensitive correctness check', invariant: invariants[c.id!]!, applicability: ['The selected call or slice in its enclosing control flow'], exceptions: ['A dominating branch proves the risky condition cannot hold'], requiredContext: ['enclosing-file'] },
        evidence: [{ id: `file:${sourceDigest(source)}`, kind: 'enclosing-file', content: source, anchor: { path: c.path!, sourceDigest: sourceDigest(source), span: { start: sourcePosition(source, 0), end: sourcePosition(source, source.length) } } }],
      });
      const record = { callIdentity, caseId: c.id, snapshot, commit: snapshot === 'before' ? c.baseSha : c.headSha, candidate, outcome };
      await writeFile(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      results.push(record);
    }
  }
}
const report = { identity, mode: 'live_codex_retrospective_seed', results, limitations: ['Model outputs are predictions, not independently verified labels', 'Rules were derived from these known fixes; this is not heldout generalization', 'No GitHub publication is performed'] };
await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ reportDirectory: outDir, callsRecorded: results.length, publication: 'disabled' }) + '\n');

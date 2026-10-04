import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BlindDraftSchema, validateBlindDraft, prepareW0EvaluationInputs, verifyContextRecord, verifyRuffPairRecords } from '../scripts/prepare-w0-evaluation-inputs.js';
import { MEMBERS } from '../scripts/prepare-w0-mining.js';
const load = async (file: string) => JSON.parse(await readFile(new URL(`../experiments/temporal-pilot/w0-first-three/${file}`, import.meta.url), 'utf8'));
it('reproduces provenance offline while keeping unassigned packets and identity map outside Git', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w0-eval-test-'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  try {
    const ledger = await prepareW0EvaluationInputs(join(dir, 'out'), join(dir, 'private'));
    expect(ledger).toEqual(await load('evaluation-preparation/provenance-ledger.json'));
    const mapping = JSON.parse(await readFile(join(dir, 'private', 'facilitator', 'facilitator-only.json'), 'utf8'));
    const names = await readdir(join(dir, 'private', 'packets'));
    expect(names).toHaveLength(3);
    for (const name of names) {
      const packet = BlindDraftSchema.parse(JSON.parse(await readFile(join(dir, 'private', 'packets', name), 'utf8')));
      const member = MEMBERS.find(m => m.number === mapping.find((r: { packetId: string }) => r.packetId === packet.packetId).number)!;
      const bytes = await readFile(new URL(`../experiments/temporal-pilot/w0-first-three/proxy-attempt-1/package-${member.number}.json`, import.meta.url));
      expect(validateBlindDraft(packet, bytes, member)).toEqual(packet);
      const pkg = JSON.parse(bytes.toString('utf8'));
      const after = Buffer.from(pkg.evidence.evidence.snapshot.changes[0].after.bytesBase64, 'base64').toString('utf8');
      expect(() => validateBlindDraft({ ...packet, sources: [{ ...packet.sources[0], content: after }, ...packet.sources.slice(1)] }, bytes, member)).toThrow('frozen before');
      expect(() => validateBlindDraft({ ...packet, sources: [{ ...packet.sources[0], content: packet.sources[0]!.content + '\nReference answer: negative' }, ...packet.sources.slice(1)] }, bytes, member)).toThrow('frozen before');
      expect(() => validateBlindDraft({ ...packet, sources: [...packet.sources, packet.sources[0]] }, bytes, member)).toThrow('frozen before');
      for (const key of ['split', 'referenceAnswers', 'toolResult', 'commit']) expect(() => validateBlindDraft({ ...packet, [key]: null }, bytes, member)).toThrow();
      expect(packet.label).toBeNull();
      expect(packet.ruleDefinition).toBeNull();
      expect(() => BlindDraftSchema.parse({ ...packet, label: 'negative' })).toThrow();
      expect(() => BlindDraftSchema.parse({ ...packet, prNumber: 3031 })).toThrow();
      expect(() => BlindDraftSchema.parse({ ...packet, afterSource: [] })).toThrow();
      expect(JSON.stringify(ledger)).not.toContain(packet.packetId);
    }
    const heldout = JSON.parse(await readFile(join(dir, 'out', 'heldout-selection.json'), 'utf8'));
    expect(heldout.windows.map((w: { members: unknown[] }) => w.members.length)).toEqual([13, 19]);
    expect(heldout.windows[0].role).toContain('not-holdout');
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
it('rejects private directories in the repository including symlinked parents before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w0-eval-path-test-'));
  try {
    await symlink(resolve('.'), join(dir, 'repository-link'));
    await expect(prepareW0EvaluationInputs(join(dir, 'out'), join(dir, 'repository-link', 'private'))).rejects.toThrow('outside repository');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('rejects incomplete or relabelled behavior and context records', async () => {
  const behavior = await load('permission-diagnosis/ledger.json');
  verifyRuffPairRecords(behavior.ruffPairs);
  expect(() => verifyRuffPairRecords([])).toThrow();
  expect(() => verifyRuffPairRecords([behavior.ruffPairs[0], behavior.ruffPairs[0]])).toThrow();
  const altered = structuredClone(behavior.ruffPairs); altered[0].commands[1].command = altered[0].commands[0].command;
  expect(() => verifyRuffPairRecords(altered)).toThrow();
  const context = await load('full-context/context-3031-after.json');
  const expected = { commit: context.sha, tree: context.tree, repositoryId: context.binding.repositoryId };
  verifyContextRecord(context, expected);
  expect(() => verifyContextRecord({ ...context, tree: 'f'.repeat(40) }, expected)).toThrow();
  expect(() => verifyContextRecord({ ...context, observation: { fullCommittedTreeVerified: false } }, expected)).toThrow();
});

it('rejects another repository or linked worktree before creating any output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w0-eval-other-git-'));
  try {
    for (const kind of ['repository', 'linked-worktree']) {
      const repo = join(dir, kind); await mkdir(repo);
      if (kind === 'repository') { await mkdir(join(repo, '.git')); await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n'); }
      else await writeFile(join(repo, '.git'), 'gitdir: /nonexistent/example\n');
      await expect(prepareW0EvaluationInputs(join(dir, `out-${kind}`), join(repo, 'private'))).rejects.toThrow('outside every Git worktree');
      await expect(lstat(join(dir, `out-${kind}`))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(repo, 'private'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

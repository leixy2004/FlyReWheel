import { expect, it } from 'vitest';
import { canonicalJson, digestOf } from '../src/core/identity.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { renderState, reviewRequest } from '../experiments/matched-revision/prompts.js';
import { checkPersistentBudget, validatePacket, validateProposal } from '../experiments/matched-revision/validation.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import { aggregateMatchedResults } from '../experiments/matched-revision/macro-report.js';
import type { PersistentState } from '../experiments/matched-revision/contracts.js';
const memory = (operation: 'revise' | 'qualify' | 'suppress', text: string, initialLesson = 'RETIRED_ONLY_SENTINEL'): PersistentState =>
  ({ kind: 'scoped_memory', initialLesson, delta: { operation, text } });
it('projects replacement/suppression without retired text and keeps qualification explicit', () => {
  const f = createMatchedFixture();
  for (const op of ['revise', 'suppress'] as const) {
    const state = memory(op, 'current instruction');
    for (const stage of ['gate', 'future'] as const) {
      const request = reviewRequest(stage, state, f.future.cases.map(c => c.input), f.packet.episode.settings);
      expect(request.prompt).not.toContain('RETIRED_ONLY_SENTINEL');
      expect(request.prompt).not.toContain('initialLesson');
      expect(request.prompt).toContain('current instruction');
      expect(request.prompt).toContain('Return all target IDs exactly once');
    }
    expect(renderState(state)).toBe(renderState(memory(op, 'current instruction', 'different retired text')));
    expect(canonicalJson(state)).toContain('RETIRED_ONLY_SENTINEL');
  }
  expect(renderState(memory('revise', 'new lesson'))).toBe('new lesson');
  expect(JSON.parse(renderState(memory('qualify', 'qualified boundary')))).toMatchObject({ activeLesson: 'RETIRED_ONLY_SENTINEL', qualification: 'qualified boundary' });
  expect(JSON.parse(renderState(memory('suppress', 'disable pending evidence')))).toMatchObject({ activeLesson: null, suppression: 'disable pending evidence' });
});
it('charges exactly active UTF-8 bytes including qualification/suppression framing at both cap boundaries', () => {
  const f = createMatchedFixture();
  for (const op of ['revise', 'qualify', 'suppress'] as const) {
    const state = memory(op, '边界😀'), n = Buffer.byteLength(renderState(state));
    expect(n).toBeGreaterThan(renderState(state).length);
    f.packet.episode.settings.limits.persistentStateTokens = n;
    expect(() => checkPersistentBudget(state, f.packet.episode)).not.toThrow();
    f.packet.episode.settings.limits.persistentStateTokens = n - 1;
    expect(() => checkPersistentBudget(state, f.packet.episode)).toThrow();
    expect(() => checkPersistentBudget(state, f.packet.episode, n)).not.toThrow();
    expect(() => checkPersistentBudget(state, f.packet.episode, n - 1)).toThrow();
  }
});
it('admits replacement at H/U current-state capacity without charging the retired audit version', () => {
  const f = createMatchedFixture(), validated = validatePacket(f.packet, f.future);
  const prepared = validated.prepared, episode = structuredClone(validated.episode);
  const size = Buffer.byteLength(renderState(f.proposal.state!));
  episode.settings.limits.persistentStateTokens = size;
  expect(renderState(f.memoryProposal.state!)).toBe(renderState(f.proposal.state!));
  expect(Buffer.byteLength(canonicalJson(f.memoryProposal.state))).toBeGreaterThan(size);
  for (const arm of ['U', 'H', 'M'] as const) {
    const proposal = arm === 'M' ? f.memoryProposal : f.proposal;
    expect(() => validateProposal(proposal, arm, episode, prepared, size)).not.toThrow();
    expect(() => validateProposal(proposal, arm, episode, prepared, size - 1)).toThrow();
  }
});
it('retains audit updates, identical common inputs/review requests, repeatability and validated saved replay', async () => {
  const f = createMatchedFixture();
  const report = await runMatchedRevision({ ...f, mode: 'authored_fixture' });
  if (report.execution !== 'completed') throw Error('Expected completed fixture');
  const m = report.arms.find(a => a.arm === 'M')!, u = report.arms.find(a => a.arm === 'U')!;
  expect(m.acceptedChange).toBe(true); expect(m.effectiveState).toEqual(f.memoryProposal.state);
  expect(m.persistentReviewBytesDigest).toBe(u.persistentReviewBytesDigest);
  for (const stage of ['gate', 'future'] as const) expect(m.calls.find(c => c.stage === stage)!.request).toEqual(u.calls.find(c => c.stage === stage)!.request);
  const common = (prompt: string) => prompt.split('COMMON_INPUT=')[1].split('\nEDIT_POLICY=')[0];
  expect(common(m.calls[0].request.prompt)).toBe(common(u.calls[0].request.prompt));
  const again = await runMatchedRevision({ ...createMatchedFixture(), mode: 'authored_fixture' });
  if (again.execution !== 'completed') throw Error('Expected completed fixture');
  expect(again.arms.map(a => a.calls.map(c => c.requestDigest))).toEqual(report.arms.map(a => a.calls.map(c => c.requestDigest)));
  const saved = JSON.parse(JSON.stringify(report));
  expect(() => aggregateMatchedResults([{ ...f, report: saved, repetition: 1 }])).not.toThrow();
  const future = saved.arms.find((a: any) => a.arm === 'M').calls.find((c: any) => c.stage === 'future');
  future.request.prompt += '\nRETIRED_ONLY_SENTINEL'; future.requestDigest = digestOf(future.request);
  const { digest, ...body } = saved; saved.digest = digestOf(body);
  expect(() => aggregateMatchedResults([{ ...f, report: saved, repetition: 1 }])).toThrow('Request settings/context');
});

import { expect, test } from 'vitest';
import { planPublication } from '../src/publication.js';
import type { Finding } from '../src/core/index.js';
const finding: Finding = {
  id: 'f', runId: 'r', bundleDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), ruleId: 'deadline', ruleVersion: '1',
  location: { path: 'job.ts', startLine: 3, endLine: 3 }, candidateState: 'passed', execution: { state: 'succeeded', error: null }, evidenceRefs: ['caller'],
  adjudication: { decision: 'violation', source: 'agent', reasoning: 'Confirmed against caller deadline contract', evidenceRefs: ['caller'] },
};
const context = { analyzedCommit: 'abc1234', currentCommit: 'abc1234', activeBundleDigest: finding.bundleDigest, authorized: true, applicable: true, actionable: true, anchorValid: true, alreadyPublishedKeys: [] as string[] };
test('eligible plan remains non-publishing and a duplicate is blocked', () => {
  const plan = planPublication(finding, context);
  expect(plan.eligible).toBe(true);
  expect(plan.action).toBe('plan_only');
  expect(planPublication(finding, { ...context, alreadyPublishedKeys: [plan.key] }).reasons).toContain('duplicate');
});
test.each(['authorized', 'applicable', 'actionable', 'anchorValid'] as const)('%s gate cannot be bypassed', gate => {
  expect(planPublication(finding, { ...context, [gate]: false }).eligible).toBe(false);
});

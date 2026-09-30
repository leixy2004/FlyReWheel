import { expect, test } from 'vitest';
import { QualEvoStore } from '../src/storage/index.js';
import { runDemo } from '../src/demo.js';
import { planPublication, exportSarif } from '../src/publication.js';

test('real detector + fixture semantics + PostgreSQL run end to end and replay is idempotent', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const result = await runDemo(store);
    expect(result.observations.map(f => f.candidateState)).toEqual(['passed', 'not_recalled', 'passed', 'not_recalled', 'rejected', 'abstained']);
    expect(result.report.eligible).toBe(false);
    expect(result.report.evidenceKind).toBe('synthetic_only');
    expect(result.feedbackExample.groundTruthVerdict).toBe('Unknown');
    const rerun = await runDemo(store);
    expect(rerun.evaluationId).toBe(result.evaluationId);
    expect(rerun.observations).toEqual(result.observations);
    const f = result.observations[0]!;
    const plan = planPublication(f, { analyzedCommit: 'old', currentCommit: 'new', activeBundleDigest: null, authorized: false, applicable: true, actionable: true, anchorValid: false, alreadyPublishedKeys: [] });
    expect(plan.reasons).toEqual(expect.arrayContaining(['stale_commit', 'publication_not_authorized', 'invalid_anchor', 'fixture_cannot_be_published']));
    expect(plan.action).toBe('plan_only');
    const sarif = exportSarif(result.observations);
    expect(sarif.runs[0]!.results).toHaveLength(2);
    expect(sarif.runs[0]!.results[0]!.properties.predictionSource).toBe('fixture');
  } finally { await store.close(); }
}, 30000);

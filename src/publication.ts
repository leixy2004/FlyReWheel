import type { Finding } from './core/index.js';
import { digestOf } from './core/index.js';

export interface PublicationContext {
  analyzedCommit: string; currentCommit: string;
  activeBundleDigest: string | null;
  authorized: boolean; applicable: boolean; actionable: boolean;
  anchorValid: boolean; alreadyPublishedKeys: readonly string[];
}
/** Produces a plan only. No API client or provider credential is accepted here. */
export function planPublication(finding: Finding, context: PublicationContext) {
  const key = digestOf([finding.ruleId, finding.bundleDigest, context.analyzedCommit, finding.location]);
  const reasons: string[] = [];
  if (!context.authorized) reasons.push('publication_not_authorized');
  if (!context.applicable) reasons.push('not_applicable');
  if (!context.actionable) reasons.push('not_actionable_here');
  if (context.analyzedCommit !== context.currentCommit) reasons.push('stale_commit');
  if (context.activeBundleDigest !== finding.bundleDigest) reasons.push('inactive_or_stale_rule_version');
  if (!context.anchorValid) reasons.push('invalid_anchor');
  if (context.alreadyPublishedKeys.includes(key)) reasons.push('duplicate');
  if (finding.candidateState !== 'passed' || finding.execution.state !== 'succeeded' || finding.adjudication?.decision !== 'violation') reasons.push('not_confirmed_by_independent_judge');
  if (finding.adjudication?.source !== 'agent') reasons.push('fixture_cannot_be_published');
  return { key, eligible: reasons.length === 0, reasons, action: 'plan_only' as const, findingId: finding.id };
}

/** SARIF exports scanner/judge predictions. This never labels them as human-confirmed truth. */
export function exportSarif(findings: Finding[]) {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{ tool: { driver: { name: 'flyrewheel', version: '0.1.0' } }, results: findings.filter(f => f.candidateState === 'passed').map(f => ({
      ruleId: f.ruleId, level: 'warning', message: { text: f.adjudication?.reasoning ?? 'Candidate requires review' },
      locations: [{ physicalLocation: { artifactLocation: { uri: f.location.path }, region: { startLine: f.location.startLine, endLine: f.location.endLine } } }],
      partialFingerprints: { 'qualEvo/v1': digestOf([f.bundleDigest, f.sourceDigest, f.location]) },
      properties: { bundleDigest: f.bundleDigest, ruleVersion: f.ruleVersion, runId: f.runId, predictionSource: f.adjudication?.source, humanGroundTruth: 'not_inferred', publication: 'not_performed' },
    })) }],
  };
}

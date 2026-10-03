import type { Command } from 'commander';
import { DigestSchema } from './core/model.js';
import { deriveLocalReviewVerdict } from './core/semantic-review.js';
import type { StoredRevisionCandidate, StoredRevisionNoMutationOutcome } from './core/revision-generation.js';
import type { RevisionGenerationEvidence } from './revision-generation.js';
import { RevisionCatalogPageSchema, RevisionCandidatePageSchema } from './storage/store.js';
import { databaseCommand, storeFor } from './cli-database.js';

type StoredGeneration = StoredRevisionCandidate | StoredRevisionNoMutationOutcome;
type Output = (value: unknown, path?: string) => Promise<void>;

/** Display-only projection of already revalidated records. Never rewrites stored receipts or verdicts. */
export function revisionInspectionSummary(stored: StoredGeneration) {
  const record = 'candidate' in stored ? stored.candidate : stored.outcome;
  const receipt = record.executionReceipt, proposal = receipt.workerResult.value.result;
  const ruleDigest = 'ruleDigest' in record ? record.ruleDigest : null;
  const bindings = 'repositoryContextBindings' in record ? record.repositoryContextBindings : [];
  const contextDigests = [...new Set(bindings.flatMap(binding => binding.repositoryContextDigests))].sort();
  return {
    digest: stored.digest, id: record.id, recordSchemaVersion: record.schemaVersion, kind: record.kind,
    requestDigest: record.requestDigest, baseRuleDigest: record.baseRuleDigest, ruleDigest,
    status: 'status' in record ? record.status : record.result.status,
    source: record.source, synthesis: record.synthesis, modelExecution: receipt.modelExecution,
    operator: 'operator' in proposal ? proposal.operator : null,
    policyVersion: 'policyVersion' in record ? record.policyVersion : null,
    evidencePolicyVersion: 'evidencePolicyVersion' in record ? record.evidencePolicyVersion : null,
    diagnosis: record.diagnosis, diagnoses: proposal.diagnoses,
    nextStep: 'nextStep' in proposal ? proposal.nextStep : 'Compare exact base and candidate reviews on the same snapshots, then record an explicit decision',
    missingEvidence: 'missingEvidence' in proposal ? proposal.missingEvidence : [],
    repositoryContextBindings: bindings,
    execution: { outputContract: receipt.workerResult.outputContract, runtimeId: receipt.runtimeId,
      model: receipt.model, modelIdentity: receipt.modelIdentity, boundary: receipt.workerResult.boundary,
      completedAt: receipt.completedAt, trust: receipt.trust },
    activation: record.activation, certification: 'none' as const,
    links: {
      request: ['revisions', 'show', '--digest', record.requestDigest],
      baseRule: ['rules', 'show', '--digest', record.baseRuleDigest],
      rule: ruleDigest === null ? null : ['rules', 'show', '--digest', ruleDigest],
      snapshot: ['snapshots', 'show', '--digest', receipt.context.snapshotDigest],
      repositoryContexts: contextDigests.map(digest => ['contexts', 'show', '--digest', digest]),
      comparisons: ruleDigest === null ? null : ['revisions', 'comparisons', '--request-digest', record.requestDigest, '--candidate-rule-digest', ruleDigest],
    },
  };
}

export function revisionInspection(stored: StoredGeneration, graph: RevisionGenerationEvidence) {
  const rule = graph.baseRule.rule;
  return {
    ...revisionInspectionSummary(stored),
    request: graph.request.request,
    baseRule: { ruleId: rule.ruleId, version: rule.version, title: rule.schemaVersion === 2 ? rule.semantics.title : rule.skill.title },
    selectedFeedback: graph.feedback.map(({ feedback, finding, review }) => ({
      ...feedback, findingStatus: finding.status, anchor: finding.anchor,
      selectedVerdict: deriveLocalReviewVerdict(graph.feedback.filter(entry => entry.finding.id === finding.id).map(entry => entry.feedback)),
      review: ['reviews', 'show', '--id', review.id], finding: ['reviews', 'finding', '--id', finding.id],
    })),
    trust: { identityVerification: 'caller-declared-unverified', verdictScope: 'frozen-selected-feedback-only',
      certification: 'none', diagnosis: 'proposal-not-established-fact', reviewRepair: 'not_performed',
      note: 'Fixture labels do not establish human verdicts; local-human-declared labels are unverified declarations. Inspection does not run generation, acquire context, repair findings, activate rules, or certify quality.' },
  };
}

export function registerRevisionInspectionCommands(revisions: Command, output: Output) {
  for (const kind of ['candidate', 'outcome'] as const) {
    databaseCommand(revisions, kind).description(`Inspect one immutable generated ${kind} and its evidence links; no generation or quality certification`)
      .requiredOption('--digest <sha256>', `Exact ${kind} record digest, not a rule or request digest`).option('--out <file>')
      .addHelpText('after', `\nExample: flyrewheel revisions ${kind} --db ./state --digest <sha256>\nReturned links are CLI argument arrays; append the same explicit database selector. Storage opening may apply pending migrations.`)
      .action(async options => {
        const digest = DigestSchema.parse(options.digest);
        const store = await storeFor(options);
        try {
          const stored = kind === 'candidate' ? await store.getRevisionCandidate(digest) : await store.getRevisionOutcome(digest);
          const record = 'candidate' in stored ? stored.candidate : stored.outcome;
          const graph = await store.getRevisionGenerationEvidence(record.requestDigest);
          await output({ ...stored, inspection: revisionInspection(stored, graph) }, options.out);
        } finally { await store.close(); }
      });
    const command = databaseCommand(revisions, `${kind}s`).description(`Discover generated ${kind}s in digest order; validated read-only records, never a quality ranking`)
      .option('--request-digest <sha256>', 'Exact frozen request').option('--id <id>', `Exact application-supplied ${kind} ID`)
      .option('--after <sha256>', 'Exclusive record-digest cursor; continue with identical filters')
      .option('--limit <count>', '1–100 records per page; at most 16MB, use a smaller limit if exceeded', '20').option('--out <file>');
    if (kind === 'candidate') command.option('--rule-digest <sha256>', 'Exact generated rule version');
    command.addHelpText('after', `\nExample: flyrewheel revisions ${kind}s --db ./state --request-digest <sha256> --limit 20\nUse each digest with revisions ${kind}. nextAfter is the last returned digest; continue until an empty page returns null.\nPages are not a cross-invocation snapshot. --postgres explicitly uses DATABASE_URL. Storage opening may apply pending migrations.`)
      .action(async options => {
        const common = { requestDigest: options.requestDigest, id: options.id, after: options.after, limit: Number(options.limit) };
        const selection = kind === 'candidate' ? RevisionCandidatePageSchema.parse({ ...common, ruleDigest: options.ruleDigest }) : RevisionCatalogPageSchema.parse(common);
        const store = await storeFor(options);
        try {
          const records = kind === 'candidate' ? await store.listRevisionCandidates(selection) : await store.listRevisionOutcomes(selection);
          await output({ schemaVersion: 1, kind: `revision-${kind}-list`, [kind === 'candidate' ? 'candidates' : 'outcomes']: records.map(revisionInspectionSummary),
            requestDigest: selection.requestDigest ?? null, id: selection.id ?? null,
            ...(kind === 'candidate' ? { ruleDigest: 'ruleDigest' in selection ? selection.ruleDigest ?? null : null } : {}),
            after: selection.after ?? null, limit: selection.limit, nextAfter: records.at(-1)?.digest ?? null, certification: 'none' }, options.out);
        } finally { await store.close(); }
      });
  }
}

import { GovernedReviewPlanInputSchema, governedReviewJobs, governedReviewStatus, enqueueGovernedReviewPlan } from './governed-semantic-review.js';
import { Command } from 'commander';
import { exportEvaluationCheckout, inspectEvaluationCheckout, EvaluationVisibilityManifestSchema, EVALUATION_CHECKOUT_LIMITS } from './workspace/evaluation-checkout.js';
import { evaluatePairedReviews, readEvaluationJson, writeEvaluationJson } from './paired-evaluation.js';
import { writePairedEvaluationDemo } from './paired-evaluation-demo.js';
import { PAIRED_EVALUATION_LIMITS } from './core/paired-evaluation.js';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { RuleBundleSchema, RuleVersionSchema, ProblemCaseSchema } from './core/index.js';
import { openSelectedStore, resolveDatabaseSelection } from './storage/connection.js';
import { databaseCommand, storeFor, withSelectedQueue } from './cli-database.js';
import { registerDatabaseMigrationCommands } from './cli-database-migrations.js';
import { registerRevisionInspectionCommands } from './cli-revision-inspection.js';
import { RevisionComparisonPageSchema } from './storage/store.js';
import { ReplayDatasetSchema, replayDataset } from './pipeline.js';
import { runDemo } from './demo.js';
import { runSemanticReviewDemo } from './review-demo.js';
import { runRevisionComparisonDemo } from './revision-demo.js';
import { runLocalClosedLoop } from './local-closed-loop.js';
import { detectAstGrep } from './adapters/index.js';
import { bundleDigest } from './core/index.js';
import { configuredCodex, resolveCodexExecutionConfig } from './model-runtime.js';
import { enqueueReplay, enqueueApplication, APPLICATION_QUEUE } from './jobs.js';
import { ApplicationJobSchema, applicationJobDigest, applicationJobId, applicationJobSummary, applicationJobGovernance } from './application-job-contract.js';
import { extractBugFixPair } from './git-evidence.js';
import { prepareWorkspace, inspectWorkspace, cleanupWorkspace } from './workspace/index.js';
import { captureRepositoryContext, readRepositoryContextPackage, verifyRepositoryContext, validateRepositoryContextForSnapshot,
  makeRepositoryContextAnchor, makeRepositoryContextEvidence } from './repository-context.js';
import { captureChangeSnapshot, ChangeSnapshotPackageSchema, SNAPSHOT_MAX_JSON_BYTES, integrityReceipt } from './change-snapshot.js';
import { captureGithubPrEvidence } from './github-pr.js';
import { discoverGithubPrHistory, validateHistoryPlan, HISTORY_MAX_JSON_BYTES } from './github-pr-history.js';
import { captureGithubPrHistoryBatch, HistoryCaptureOptionsSchema } from './github-pr-history-batch.js';
import { GithubPrEvidencePackageSchema, GITHUB_PR_MAX_JSON_BYTES } from './github-pr-evidence.js';
import { ReviewFixtureSchema, LocalReviewFeedbackSchema, RevisionRequestInputSchema } from './core/semantic-review.js';
import { RevisionComparisonInputSchema, RevisionDecisionInputSchema } from './core/revision-comparison.js';
import { PrMiningRequestInputSchema, PrMiningCandidateInputSchema } from './core/pr-mining.js';
import { LocalSemanticSelectionInputSchema, SemanticGovernanceCommandSchema } from './core/semantic-governance.js';

async function json(path: string) {
  if ((await stat(path)).size > 2_000_000) throw new Error('Input exceeds 2MB; use an explicit smaller batch');
  const bytes = await readFile(path);
  if (bytes.length > 2_000_000) throw new Error('Input exceeds 2MB; use an explicit smaller batch');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
async function output(value: unknown, path?: string) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (path) await writeFile(path, text, { mode: 0o600 }); else process.stdout.write(text);
}
const cli = new Command().name('flyrewheel').description('Evidence-backed quality rules; persistent commands require an explicit local or PostgreSQL database');
registerDatabaseMigrationCommands(cli);
const evaluation = cli.command('evaluation').description('Offline descriptive pairing of frozen reviews and separate annotations; never runs a model or certifies efficacy');
evaluation.command('score').requiredOption('--dataset <file>').requiredOption('--annotations <file>').requiredOption('--runs <file>')
  .requiredOption('--out <new-file>', 'Immutable new report path; existing files are never replaced')
  .action(async options => {
    const dataset = await readEvaluationJson(options.dataset, PAIRED_EVALUATION_LIMITS.datasetBytes);
    const annotations = await readEvaluationJson(options.annotations, PAIRED_EVALUATION_LIMITS.annotationBytes);
    const runs = await readEvaluationJson(options.runs, PAIRED_EVALUATION_LIMITS.runsBytes);
    const report = evaluatePairedReviews(dataset, annotations, runs);
    await writeEvaluationJson(options.out, report);
    await output({ reportId: report.id, digest: report.digest, file: options.out, comparisons: report.comparisons });
  });
evaluation.command('demo').requiredOption('--directory <new-directory>', 'New directory for separately frozen synthetic manifests and report')
  .action(async options => output(await writePairedEvaluationDemo(options.directory)));
const checkout = evaluation.command('checkout').description('Optional exact-head standalone Git export; historical public visibility remains unproven');
checkout.command('export').requiredOption('--repo <directory>', 'Canonical trusted full source repository; read only')
  .requiredOption('--store <directory>', 'Independent canonical trusted local export store')
  .requiredOption('--manifest <file>', 'Caller-declared exact allowed heads and visibility metadata')
  .action(async options => output(await exportEvaluationCheckout({ repoPath: options.repo, storePath: options.store,
    manifest: EvaluationVisibilityManifestSchema.parse(await readEvaluationJson(options.manifest, EVALUATION_CHECKOUT_LIMITS.manifestBytes)) })));
checkout.command('inspect').requiredOption('--store <directory>').requiredOption('--manifest <file>', 'Original caller visibility manifest, checked against the export')
  .action(async options => output(await inspectEvaluationCheckout({ storePath: options.store,
    manifest: EvaluationVisibilityManifestSchema.parse(await readEvaluationJson(options.manifest, EVALUATION_CHECKOUT_LIMITS.manifestBytes)) })));
const githubPr = cli.command('github-pr').description('Read-only public GitHub PR current observation; not a historical review');
databaseCommand(githubPr, 'capture').requiredOption('--repository <owner/repo>').requiredOption('--number <number>')
  .option('--max-requests <count>', 'Explicit bounded GitHub API request budget').option('--out <file>')
  .action(async options => {
    const result = await captureGithubPrEvidence({ repository: options.repository, number: Number(options.number),
      ...(options.maxRequests === undefined ? {} : { maxRequests: Number(options.maxRequests) }) });
    // Do not open or modify the selected database until acquisition and validation finish.
    const value = GithubPrEvidencePackageSchema.parse(result);
    const store = await storeFor(options);
    try { await output({ ...await store.importGithubPrEvidence(value.evidence), receipt: result.receipt }, options.out); } finally { await store.close(); }
  });
databaseCommand(githubPr, 'import').requiredOption('--file <file>', 'Frozen evidence package; only internal integrity is checked')
  .option('--out <file>')
  .action(async options => {
    if ((await stat(options.file)).size > GITHUB_PR_MAX_JSON_BYTES) throw new Error('GitHub PR evidence package exceeds 8MB');
    const bytes = await readFile(options.file);
    if (bytes.length > GITHUB_PR_MAX_JSON_BYTES) throw new Error('GitHub PR evidence package exceeds 8MB');
    const value = GithubPrEvidencePackageSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const store = await storeFor(options);
    try { await output({ ...await store.importGithubPrEvidence(value.evidence), receipt: integrityReceipt }, options.out); } finally { await store.close(); }
  });
databaseCommand(githubPr, 'show').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output({ ...await store.getGithubPrEvidence(options.digest), receipt: integrityReceipt }, options.out); } finally { await store.close(); }
  });
const history = githubPr.command('history').description('Bounded public PR discovery and explicit resumable local capture; no model or queue work');
history.command('preview').requiredOption('--repository <owner/repo>')
  .requiredOption('--created-from <timestamp>', 'Inclusive PR creation time, ISO-8601 whole seconds')
  .requiredOption('--created-before <timestamp>', 'Exclusive PR creation time; at most a 366-day window')
  .requiredOption('--status <status>', 'all, open, closed (includes merged), or merged')
  .option('--max-pulls <count>', 'At most 25 PRs; deterministic order within observed rows', '5')
  .option('--max-pages <count>', 'At most 10 search pages, 5 rows each', '2').option('--out <file>')
  .action(async options => output(await discoverGithubPrHistory({ repository: options.repository, createdFrom: options.createdFrom,
    createdBefore: options.createdBefore, status: options.status, maxPulls: Number(options.maxPulls), maxPages: Number(options.maxPages) }), options.out));
databaseCommand(history, 'import').requiredOption('--file <file>', 'Frozen discovery plan only; imported capture progress is not accepted')
  .option('--out <file>')
  .action(async options => {
    if ((await stat(options.file)).size > HISTORY_MAX_JSON_BYTES) throw new Error('History plan exceeds 500KB');
    const value = validateHistoryPlan(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.importGithubPrHistoryPlan(value), options.out); } finally { await store.close(); }
  });
databaseCommand(history, 'show').requiredOption('--batch <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getGithubPrHistoryBatch(options.batch), options.out); } finally { await store.close(); } });
databaseCommand(history, 'list').option('--repository <owner/repo>').option('--after <sha256>')
  .option('--limit <count>', 'At most 100 batches, ordered by digest', '20').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output(await store.listGithubPrHistoryBatches({ repository: options.repository, after: options.after, limit: Number(options.limit) }), options.out); } finally { await store.close(); }
  });
databaseCommand(history, 'capture').requiredOption('--batch <sha256>')
  .option('--max-pulls <count>', 'At most 5 PR attempts in this invocation', '2')
  .option('--max-requests <count>', 'Aggregate GitHub GET budget, at most 200', '50')
  .option('--max-requests-per-pull <count>', 'Per-PR GET budget, at most 50', '50')
  .option('--timeout-ms <milliseconds>', 'Aggregate capture deadline, at most 300000', '120000')
  .option('--retry-failed', 'Explicitly retry failed PRs; captured PRs are reused')
  .option('--recover-interrupted', 'Only after stopping other operators: recover an interrupted active PR')
  .option('--out <file>')
  .action(async options => {
    const bounds = HistoryCaptureOptionsSchema.parse({ maxPulls: Number(options.maxPulls), maxRequests: Number(options.maxRequests),
      maxRequestsPerPull: Number(options.maxRequestsPerPull), timeoutMs: Number(options.timeoutMs), retryFailed: !!options.retryFailed, recoverInterrupted: !!options.recoverInterrupted });
    const store = await storeFor(options);
    try {
      const result = await captureGithubPrHistoryBatch(store, options.batch, bounds);
      await output(result, options.out);
      if (result.batch.items.some(item => item.status !== 'captured')) process.exitCode = 2;
    } finally { await store.close(); }
  });
databaseCommand(history, 'mining-request').requiredOption('--batch <sha256>').requiredOption('--number <number>')
  .requiredOption('--file <file>', 'Existing mining request format with exact captured evidence digest and explicit selections')
  .option('--out <file>')
  .action(async options => {
    const value = PrMiningRequestInputSchema.parse(await json(options.file));
    const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(Number(options.number));
    const store = await storeFor(options);
    try { await output(await store.createGithubPrHistoryMiningRequest(options.batch, number, value), options.out); } finally { await store.close(); }
  });
const mining = cli.command('mining').description('Local PR evidence requests and supplied/fixture v2 candidates; no live synthesis or labels');
databaseCommand(mining, 'request').requiredOption('--file <file>', 'Exact PR evidence/source/statement selection and authored objective')
  .option('--out <file>')
  .action(async options => {
    const value = PrMiningRequestInputSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.createPrMiningRequest(value), options.out); } finally { await store.close(); }
  });
databaseCommand(mining, 'show').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getPrMiningRequest(options.digest), options.out); } finally { await store.close(); } });
databaseCommand(mining, 'list').option('--evidence-digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.listPrMiningRequests(options.evidenceDigest), options.out); } finally { await store.close(); } });
databaseCommand(mining, 'supply').requiredOption('--file <file>', 'Candidate envelope containing requestDigest, source, ID and full semantic-v2 rule')
  .option('--out <file>')
  .action(async options => {
    const value = PrMiningCandidateInputSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.importPrMiningCandidate(value), options.out); } finally { await store.close(); }
  });
databaseCommand(mining, 'candidate').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getPrMiningCandidate(options.digest), options.out); } finally { await store.close(); } });
databaseCommand(mining, 'candidates').option('--request-digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.listPrMiningCandidates(options.requestDigest), options.out); } finally { await store.close(); } });
const contexts = cli.command('contexts').description('Freeze selected Git paths at an exact head for explicitly selected context-aware semantic reviews');
databaseCommand(contexts, 'capture').requiredOption('--repo <directory>').requiredOption('--repository-id <id>', 'Caller-supplied logical repository identity')
  .requiredOption('--head <sha>', 'Exact full SHA-1 review head, never a moving ref')
  .requiredOption('--path <path...>', 'Explicit repository-relative paths; literal, no glob expansion or recursive directory capture')
  .option('--snapshot-digest <sha256>', 'Require an exact repository/head binding to this stored review snapshot')
  .option('--max-paths <count>', 'Hard limit, at most 128', '128').option('--max-blob-bytes <count>', 'Hard per-blob limit, at most 262144', '262144')
  .option('--max-total-bytes <count>', 'Hard captured-byte limit, at most 2097152', '2097152').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try {
      // Check head/repository before reading any selected source, then revalidate the complete package.
      const snapshot = options.snapshotDigest ? await store.getChangeSnapshot(options.snapshotDigest) : undefined;
      if (snapshot && (snapshot.snapshot.head !== options.head || snapshot.snapshot.repository.id !== options.repositoryId)) {
        throw new Error('Repository context must bind to this exact snapshot repository and review head');
      }
      const result = await captureRepositoryContext({ repositoryPath: options.repo, repositoryId: options.repositoryId, head: options.head, paths: options.path,
        limits: { maxPaths: Number(options.maxPaths), maxBlobBytes: Number(options.maxBlobBytes), maxTotalBytes: Number(options.maxTotalBytes) } });
      if (snapshot) validateRepositoryContextForSnapshot(result, snapshot);
      await output({ ...await store.importRepositoryContext(result.context), receipt: result.receipt }, options.out);
    } finally { await store.close(); }
  });
databaseCommand(contexts, 'import').requiredOption('--file <file>', 'Frozen context package; imports check internal integrity only')
  .option('--out <file>')
  .action(async options => {
    const value = await readRepositoryContextPackage(options.file), store = await storeFor(options);
    try { await output({ ...await store.importRepositoryContext(value.context), receipt: integrityReceipt }, options.out); } finally { await store.close(); }
  });
databaseCommand(contexts, 'show').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output({ ...await store.getRepositoryContext(options.digest), receipt: integrityReceipt }, options.out); } finally { await store.close(); }
  });
databaseCommand(contexts, 'verify').requiredOption('--digest <sha256>').requiredOption('--repo <directory>').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output(await verifyRepositoryContext(await store.getRepositoryContext(options.digest), options.repo), options.out); } finally { await store.close(); }
  });
databaseCommand(contexts, 'cite').requiredOption('--digest <sha256>').requiredOption('--path <path>').requiredOption('--kind <kind>', 'Caller-declared context role, e.g. callee-contract or test')
  .requiredOption('--start <offset>', 'Zero-based UTF-16 start offset').requiredOption('--end <offset>', 'End-exclusive UTF-16 offset')
  .option('--snapshot-digest <sha256>', 'Check same-repository/exact-head snapshot binding').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try {
      const value = await store.getRepositoryContext(options.digest);
      const binding = options.snapshotDigest ? validateRepositoryContextForSnapshot(value, await store.getChangeSnapshot(options.snapshotDigest)) : undefined;
      const anchor = makeRepositoryContextAnchor(value, options.path, Number(options.start), Number(options.end));
      await output({ evidence: makeRepositoryContextEvidence(value, anchor, options.kind), ...(binding ? { binding } : {}),
        semanticReviewAcceptance: 'semantic-snapshot-review-v3',
        semanticReviewRequirements: 'Select the registered context digest explicitly; review repository/head and all citation bytes must match',
        historicalAvailability: 'unproven', receipt: integrityReceipt }, options.out);
    } finally { await store.close(); }
  });
databaseCommand(contexts, 'list').option('--repository-id <id>').option('--head <sha>').option('--after <sha256>')
  .option('--limit <count>', 'At most 100, ordered by digest', '20').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try {
      const records = await store.listRepositoryContexts({ repositoryId: options.repositoryId, head: options.head, after: options.after, limit: Number(options.limit) });
      await output({ contexts: records.map(({ digest, context }) => ({ digest, repository: context.repository, head: context.head, coverage: context.coverage })),
        nextAfter: records.length ? records.at(-1)!.digest : null, receipt: integrityReceipt }, options.out);
    } finally { await store.close(); }
  });
const snapshots = cli.command('snapshots').description('Freeze bounded local Git changes; no provider ingestion, review, model calls or execution');
databaseCommand(snapshots, 'capture').requiredOption('--repo <directory>').requiredOption('--repository-id <id>', 'Caller-supplied logical identity, not provider verified')
  .requiredOption('--base-tip <sha>', 'Exact full SHA-1 base branch tip').requiredOption('--head <sha>', 'Exact full SHA-1 change head')
  .option('--pr-metadata <file>', 'Explicitly unverified metadata JSON').option('--out <file>')
  .action(async options => {
    const result = await captureChangeSnapshot({ repositoryPath: options.repo, repositoryId: options.repositoryId,
      baseTip: options.baseTip, head: options.head, ...(options.prMetadata ? { prMetadata: await json(options.prMetadata) } : {}) });
    const store = await storeFor(options);
    try { await output({ ...await store.importChangeSnapshot(result.snapshot), receipt: result.receipt }, options.out); } finally { await store.close(); }
  });
databaseCommand(snapshots, 'import').requiredOption('--file <file>', 'Frozen snapshot package; only internal integrity is checked')
  .option('--out <file>')
  .action(async options => {
    if ((await stat(options.file)).size > SNAPSHOT_MAX_JSON_BYTES) throw new Error('Snapshot package exceeds 5MB');
    const bytes = await readFile(options.file);
    if (bytes.length > SNAPSHOT_MAX_JSON_BYTES) throw new Error('Snapshot package exceeds 5MB');
    const value = ChangeSnapshotPackageSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const store = await storeFor(options);
    try { await output({ ...await store.importChangeSnapshot(value.snapshot), receipt: integrityReceipt }, options.out); } finally { await store.close(); }
  });
databaseCommand(snapshots, 'show').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output({ ...await store.getChangeSnapshot(options.digest), receipt: integrityReceipt }, options.out); } finally { await store.close(); }
  });
databaseCommand(snapshots, 'list').option('--repository-id <id>').option('--after <sha256>')
  .option('--limit <count>', 'At most 100; ordered by digest, not capture time', '20').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try {
      const records = await store.listChangeSnapshots({ repositoryId: options.repositoryId, after: options.after, limit: Number(options.limit) });
      // Inventory only; use show to retrieve the bounded byte payload.
      await output({ snapshots: records.map(({ digest, snapshot }) => ({ digest, repository: snapshot.repository, baseTip: snapshot.baseTip, mergeBase: snapshot.mergeBase, head: snapshot.head, coverage: snapshot.coverage })),
        nextAfter: records.length ? records.at(-1)!.digest : null, receipt: integrityReceipt }, options.out);
    } finally { await store.close(); }
  });
const reviews = cli.command('reviews').description('Local snapshot review with optional selected context packages; explicit fixtures only, no model or notifications');
databaseCommand(reviews, 'demo').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await runSemanticReviewDemo(store), options.out); } finally { await store.close(); } });
databaseCommand(reviews, 'run').description('Explicit digest historical/manual replay; not governance-governed').requiredOption('--rule-digest <sha256>').requiredOption('--snapshot-digest <sha256>')
  .option('--offline-fixtures <file>', 'Explicit synthetic semantic judgments, never live model results or human labels')
  .option('--repository-context-digest <sha256...>', 'Explicit registered context digests, unique and canonically sorted; at most 8')
  .option('--attempt <id>', 'Immutable execution-attempt label', 'initial').option('--out <file>')
  .action(async options => {
    const fixtures = options.offlineFixtures ? ReviewFixtureSchema.parse(await json(options.offlineFixtures)) : undefined;
    const store = await storeFor(options);
    try {
      const review = await store.runSemanticReview({ ruleDigest: options.ruleDigest, snapshotDigest: options.snapshotDigest, fixtures, attempt: options.attempt,
        ...(options.repositoryContextDigest === undefined ? {} : { repositoryContextDigests: options.repositoryContextDigest }) });
      await output({ ...review, reviewSelection: 'explicit-digest-replay-not-governance-governed' }, options.out);
      if (review.coverage.targets.some(target => target.scans.some(scan => ['execution_error', 'budget_exceeded'].includes(scan.state)))) process.exitCode = 2;
    } finally { await store.close(); }
  });
const governedReviews = reviews.command('governed').description('Freeze and dispatch bounded local governance-selected reviews; no implicit activation or publication');
databaseCommand(governedReviews, 'plan').requiredOption('--file <file>', 'Strict plan input: id, repository, snapshotDigest, literal paths and trusted workspaceId')
  .option('--out <file>').action(async options => {
    const input = GovernedReviewPlanInputSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try {
      const stored = await store.createGovernedReviewPlan(input);
      await output({ ...stored, jobs: governedReviewJobs(stored), execution: 'not_run' }, options.out);
    } finally { await store.close(); }
  });
databaseCommand(governedReviews, 'show').requiredOption('--digest <sha256>').option('--out <file>').action(async options => {
  const store = await storeFor(options);
  try { const stored = await store.getGovernedReviewPlan(options.digest); await output({ ...stored, jobs: governedReviewJobs(stored) }, options.out); }
  finally { await store.close(); }
});
databaseCommand(governedReviews, 'status').requiredOption('--digest <sha256>').option('--out <file>').action(async options => {
  const store = await storeFor(options);
  try { await output(await governedReviewStatus(store, options.digest), options.out); } finally { await store.close(); }
});
databaseCommand(governedReviews, 'enqueue', { postgresOnly: true }).requiredOption('--digest <sha256>').option('--out <file>').action(async options => {
  const selection = resolveDatabaseSelection(options, process.env, { postgresOnly: true });
  const store = await openSelectedStore(selection);
  try {
    // Validate before queue startup/DDL; enqueue repeats the check and workers check at admission.
    await store.requireCurrentGovernedReviewPlan(options.digest);
    await output(await withSelectedQueue(selection, boss => enqueueGovernedReviewPlan(store, boss, options.digest)), options.out);
  } finally { await store.close(); }
});
databaseCommand(reviews, 'show').requiredOption('--id <review-id>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getSemanticReview(options.id), options.out); } finally { await store.close(); } });
databaseCommand(reviews, 'list').option('--rule-digest <sha256>').option('--snapshot-digest <sha256>')
  .option('--after <review-id>').option('--limit <count>', 'At most 100; ordered by immutable ID', '20').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try {
      const records = await store.listSemanticReviews({ ruleDigest: options.ruleDigest, snapshotDigest: options.snapshotDigest, after: options.after, limit: Number(options.limit) });
      await output({ reviews: records.map(review => ({ id: review.id, ruleDigest: review.ruleDigest, snapshotDigest: review.snapshotDigest, config: review.config,
        targets: review.coverage.targets.length, occurrences: review.occurrences.length, findings: review.findings.length,
        context: review.coverage.repositoryContext, notification: review.notification })), nextAfter: records.at(-1)?.id ?? null }, options.out);
    } finally { await store.close(); }
  });
databaseCommand(reviews, 'finding').requiredOption('--id <finding-id>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getReviewFinding(options.id), options.out); } finally { await store.close(); } });
const feedback = cli.command('feedback').description('Append exact local finding feedback; fixture and caller-declared human sources stay separate');
databaseCommand(feedback, 'add').requiredOption('--file <file>').option('--out <file>')
  .action(async options => {
    const value = LocalReviewFeedbackSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.appendReviewFeedback(value), options.out); } finally { await store.close(); }
  });
const revisions = cli.command('revisions').description('Local immutable requests, generated candidates/outcomes, comparisons and declared decisions; no synthesis, activation or publication');
registerRevisionInspectionCommands(revisions, output);
databaseCommand(revisions, 'request').requiredOption('--file <file>').option('--out <file>')
  .action(async options => {
    const value = RevisionRequestInputSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.createRevisionRequest(value), options.out); } finally { await store.close(); }
  });
databaseCommand(revisions, 'show').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getRevisionRequest(options.digest), options.out); } finally { await store.close(); } });
databaseCommand(revisions, 'list').option('--base-rule-digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.listRevisionRequests(options.baseRuleDigest), options.out); } finally { await store.close(); } });
databaseCommand(revisions, 'demo').description('Synthetic fixture-only compatible/accept and regressed/reject examples; no human approval')
  .option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await runRevisionComparisonDemo(store), options.out); } finally { await store.close(); } });
databaseCommand(revisions, 'compare').description('Freeze a derived comparison of exact stored base/candidate reviews')
  .requiredOption('--file <file>', 'Strict input JSON selecting request, candidate, review pairs and case bindings')
  .option('--out <file>')
  .action(async options => {
    const value = RevisionComparisonInputSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.createRevisionComparison(value), options.out); } finally { await store.close(); }
  });
databaseCommand(revisions, 'comparison').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getRevisionComparison(options.digest), options.out); } finally { await store.close(); } });
databaseCommand(revisions, 'comparisons').option('--request-digest <sha256>').option('--out <file>')
  .option('--candidate-rule-digest <sha256>', 'Match the exact generated rule as well as the request; enables page output')
  .option('--after <sha256>', 'Exclusive comparison-digest cursor; enables page output')
  .option('--limit <count>', '1–100 records; enables page output (default 20)')
  .addHelpText('after', '\nWith any page option, returns { comparisons, nextAfter, ... }; without them, preserves the legacy bounded array. Continue page cursors until null on an empty page.')
  .action(async options => {
    const paged = options.candidateRuleDigest !== undefined || options.after !== undefined || options.limit !== undefined;
    const selection = RevisionComparisonPageSchema.parse({ requestDigest: options.requestDigest, candidateRuleDigest: options.candidateRuleDigest,
      after: options.after, limit: options.limit === undefined ? 20 : Number(options.limit) });
    const store = await storeFor(options);
    try {
      const comparisons = await store.listRevisionComparisons(paged ? selection : selection.requestDigest);
      await output(paged ? { schemaVersion: 1, kind: 'revision-comparison-list', comparisons,
        requestDigest: selection.requestDigest ?? null, candidateRuleDigest: selection.candidateRuleDigest ?? null,
        after: selection.after ?? null, limit: selection.limit, nextAfter: comparisons.at(-1)?.digest ?? null, certification: 'none' } : comparisons, options.out);
    } finally { await store.close(); }
  });
databaseCommand(revisions, 'decide').description('Append an explicit fixture or caller-declared local decision; never activates a rule')
  .requiredOption('--file <file>', 'Strict input JSON with explicit actor, source, choice, reason and timestamp')
  .option('--out <file>')
  .action(async options => {
    const value = RevisionDecisionInputSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.recordRevisionDecision(value), options.out); } finally { await store.close(); }
  });
databaseCommand(revisions, 'decision').requiredOption('--digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.getRevisionDecision(options.digest), options.out); } finally { await store.close(); } });
databaseCommand(revisions, 'decisions').option('--comparison-digest <sha256>').option('--out <file>')
  .action(async options => { const store = await storeFor(options); try { await output(await store.listRevisionDecisions(options.comparisonDigest), options.out); } finally { await store.close(); } });
const rules = cli.command('rules').description('Import and inspect immutable v1/v2 rule versions; no execution or activation');
databaseCommand(rules, 'import').requiredOption('--rule <file>', 'Explicit schemaVersion 1 or 2 JSON')
  .option('--cases <file>', 'JSON array of source/regression ProblemCases; imported atomically with the rule')
  .option('--out <file>')
  .action(async options => {
    const rule = RuleVersionSchema.parse(await json(options.rule));
    const cases = options.cases ? z.array(ProblemCaseSchema).max(1000).parse(await json(options.cases)) : [];
    const store = await storeFor(options);
    try { await output(await store.importRuleVersion(rule, cases), options.out); } finally { await store.close(); }
  });
databaseCommand(rules, 'show').requiredOption('--digest <sha256>', 'Exact immutable rule version digest')
  .option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output(await store.getRuleVersion(options.digest), options.out); } finally { await store.close(); }
  });
databaseCommand(rules, 'list').option('--rule-id <id>', 'Exact logical rule ID').option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output(await store.listRuleVersions(options.ruleId), options.out); } finally { await store.close(); }
  });
const governance = rules.command('governance').description('Explicit local semantic-review selection and immutable history; no review, activation, certification or publication');
databaseCommand(governance, 'apply').requiredOption('--file <file>', 'Strict local governance command with explicit actor, source, reason and expected head')
  .option('--out <file>')
  .action(async options => {
    const value = SemanticGovernanceCommandSchema.parse(await json(options.file));
    const store = await storeFor(options);
    try { await output(await store.applySemanticGovernance(value), options.out); } finally { await store.close(); }
  });
databaseCommand(governance, 'show').requiredOption('--rule-id <id>', 'Exact logical rule ID')
  .option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output(await store.getSemanticGovernance(options.ruleId), options.out); } finally { await store.close(); }
  });
databaseCommand(governance, 'history').requiredOption('--rule-id <id>', 'Exact logical rule ID')
  .option('--out <file>')
  .action(async options => {
    const store = await storeFor(options);
    try { await output(await store.getSemanticGovernanceHistory(options.ruleId), options.out); } finally { await store.close(); }
  });
databaseCommand(governance, 'select').requiredOption('--repository <id>', 'Exact caller-supplied repository identity')
  .requiredOption('--path <path>', 'Literal repository-relative path; repeat for multiple paths', (value: string, previous: string[]) => [...previous, value], [])
  .option('--out <file>')
  .action(async options => {
    const value = LocalSemanticSelectionInputSchema.parse({ repository: options.repository, paths: options.path });
    const store = await storeFor(options);
    try { await output(await store.selectLocalSemanticRules(value), options.out); } finally { await store.close(); }
  });
const workspace = cli.command('workspace').description('Local Sandcastle attempt lifecycle in a dedicated trusted Linux Git store; no code execution or sandbox launch');
function workspaceIdentity(command: Command) {
  return command.requiredOption('--repo <directory>', 'Full-history main repository root')
    .requiredOption('--run <id>', 'Lowercase letters/digits with single hyphens; up to 40 characters')
    .requiredOption('--attempt <id>', 'Fresh identity; cannot be reused after failure or cleanup');
}
workspaceIdentity(workspace.command('prepare').description('Allocate one fresh worktree at an exact base commit'))
  .requiredOption('--base <sha>', 'Full immutable SHA-1 commit to check out')
  .option('--head <sha>', 'Full immutable comparison head; defaults to base, is recorded without changing checkout')
  .action(async options => output(await prepareWorkspace({ repoPath: options.repo, runId: options.run, attemptId: options.attempt, baseSha: options.base, headSha: options.head })));
workspaceIdentity(workspace.command('inspect').description('Read persisted state and independently observe worktree/branch identity'))
  .action(async options => output(await inspectWorkspace({ repoPath: options.repo, runId: options.run, attemptId: options.attempt })));
workspaceIdentity(workspace.command('cleanup').description('Remove only a clean worktree; retain branches, commits, attempt history, dirty and ignored bytes'))
  .action(async options => {
    const result = await cleanupWorkspace({ repoPath: options.repo, runId: options.run, attemptId: options.attempt });
    await output(result);
    if (result.record.status === 'preserved-dirty') process.exitCode = 2;
  });
cli.command('extract').requiredOption('--repo <directory>').requiredOption('--base <ref>').requiredOption('--head <ref>').requiredOption('--path <file>').requiredOption('--case-id <id>').requiredOption('--problem <description>', 'Explicit bug claim, not inferred from commit text').option('--language <language>', 'ast-grep language', 'typescript').requiredOption('--out <file>').action(async options => {
  await output(await extractBugFixPair({ repository: options.repo, base: options.base, head: options.head, path: options.path, caseId: options.caseId, language: options.language, problem: options.problem }), options.out);
});
const closedLoop = cli.command('closed-loop').description('Single local fixture-only historical mining → review → feedback → generated revision → comparison → decision flow');
closedLoop.command('demo').description('Deterministic authored fixtures only; no live model, external calls, real developer feedback or activation')
  .requiredOption('--out-dir <directory>', 'Dedicated artifact directory; rerun the same path to validate and reuse immutable records')
  .option('--db <directory>', 'Local PGlite database; defaults to <out-dir>/db')
  .action(async options => { await output(await runLocalClosedLoop({ outDir: options.outDir, db: options.db })); });
databaseCommand(cli, 'demo', { allowMemory: true }).option('--out <file>').action(async options => {
  const store = await storeFor(options, { allowMemory: true });
  try { await output(await runDemo(store), options.out); } finally { await store.close(); }
});
databaseCommand(cli, 'replay', { allowMemory: true }).requiredOption('--bundle <file>').requiredOption('--dataset <file>').option('--out <file>').option('--enable-model', 'Explicitly permit Codex inference with configured authentication').option('--attempt <id>', 'New immutable attempt identity after fixing an execution failure').action(async options => {
  const store = await storeFor(options, { allowMemory: true });
  try {
    const bundle = RuleBundleSchema.parse(await json(options.bundle));
    const dataset = ReplayDatasetSchema.parse(await json(options.dataset));
    const adapter = options.enableModel ? configuredCodex(process.env) : undefined;
    const result = await replayDataset({ store, bundle, dataset, mode: adapter ? 'model' : 'offline_fixture', modelConfig: adapter?.executionConfig, adjudicator: adapter?.adjudicate, attempt: options.attempt });
    await output(result, options.out);
    if (result.report.metrics.executionErrors) process.exitCode = 2;
  } finally { await store.close(); }
});
cli.command('scan').requiredOption('--bundle <file>').requiredOption('--file <file>').option('--out <file>').action(async options => {
  const bundle = RuleBundleSchema.parse(await json(options.bundle));
  if (bundle.detector.kind !== 'ast-grep') throw new Error('scan uses ast-grep; Semgrep/OpenGrep JSON can be imported via the adapter');
  if ((await stat(options.file)).size > 1_000_000) throw new Error('Source exceeds 1MB');
  await output(detectAstGrep({ source: await readFile(options.file, 'utf8'), path: options.file, language: bundle.detector.language, pattern: bundle.detector.pattern, ruleId: bundle.ruleId, ruleVersion: bundle.version, bundleDigest: bundleDigest(bundle) }), options.out);
});
cli.command('synthesize').requiredOption('--input <file>', 'Explicit training bug/fix pairs; no heldout data').requiredOption('--out <file>').option('--enable-model').action(async options => {
  if (!options.enableModel) throw new Error('synthesize requires --enable-model and explicit Codex configuration');
  const result = await configuredCodex(process.env).synthesize(await json(options.input));
  await output(result, options.out);
  if (result.execution === 'failed') process.exitCode = 2;
});
databaseCommand(cli, 'enqueue', { postgresOnly: true }).requiredOption('--bundle <file>').requiredOption('--dataset <file>').option('--enable-model').option('--interactive').option('--attempt <id>', 'New immutable attempt identity after fixing an execution failure').action(async options => {
  const selection = resolveDatabaseSelection(options, process.env, { postgresOnly: true });
  const execution = options.enableModel ? { mode: 'model' as const, modelConfig: resolveCodexExecutionConfig(process.env) } : { mode: 'offline_fixture' as const };
  const payload = { bundle: RuleBundleSchema.parse(await json(options.bundle)), dataset: ReplayDatasetSchema.parse(await json(options.dataset)),
    ...execution, attempt: options.attempt, workload: options.interactive ? 'interactive' as const : 'background' as const };
  const jobId = await withSelectedQueue(selection, boss => enqueueReplay(boss, payload));
  await output({ jobId });
});
const applications = cli.command('application-jobs').description('Bounded workspace application queue; runtime dependencies are trusted service configuration');
applications.command('validate').requiredOption('--file <file>').option('--out <file>').action(async options => {
  const job = ApplicationJobSchema.parse(await json(options.file));
  await output({ job, ...applicationJobGovernance(job), jobDigest: applicationJobDigest(job), jobId: applicationJobId(job), execution: 'not_run' }, options.out);
});
databaseCommand(applications, 'enqueue', { postgresOnly: true }).requiredOption('--file <file>').option('--out <file>').action(async options => {
  const selection = resolveDatabaseSelection(options, process.env, { postgresOnly: true });
  const job = ApplicationJobSchema.parse(await json(options.file));
  const id = await withSelectedQueue(selection, boss => enqueueApplication(boss, job));
  await output({ ...applicationJobGovernance(job), jobId: applicationJobId(job), jobDigest: applicationJobDigest(job), enqueued: id !== null, execution: 'not_run' }, options.out);
});
databaseCommand(applications, 'status').requiredOption('--file <file>', 'The exact normalized job identity').option('--out <file>').action(async options => {
  const selection = resolveDatabaseSelection(options, process.env);
  const job = ApplicationJobSchema.parse(await json(options.file));
  const store = await openSelectedStore(selection);
  try { const record = await store.getApplicationJob(applicationJobDigest(job));
    const queueState = selection.kind === 'postgres'
      ? await withSelectedQueue(selection, async boss => (await boss.getJobById(APPLICATION_QUEUE, applicationJobId(job)))?.state ?? null) : null;
    await output({ ...applicationJobGovernance(job), jobId: applicationJobId(job), jobDigest: applicationJobDigest(job), queueState,
      state: record?.state ?? 'not_started', attempts: record?.attempts ?? 0,
      result: record?.result ? applicationJobSummary(record.result) : null }, options.out);
  } finally { await store.close(); }
});
await cli.parseAsync().catch(error => { process.stderr.write(`FlyReWheel: ${error instanceof Error ? error.message : 'Command failed'}\n`); process.exitCode = 1; });

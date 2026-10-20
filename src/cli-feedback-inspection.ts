import { prepareReviewFeedback } from './feedback-preparation.js';
import type { Command } from 'commander';
import { databaseCommand, storeFor } from './cli-database.js';
import { ReviewFeedbackPageSchema } from './storage/store.js';
import { IdSchema } from './core/model.js';
import type { LocalReviewFeedback } from './core/semantic-review.js';

const links = (feedback: LocalReviewFeedback) => ({
  feedback: ['feedback', 'show', '--id', feedback.id],
  finding: ['reviews', 'finding', '--id', feedback.findingId],
  review: ['reviews', 'show', '--id', feedback.reviewId],
  rule: ['rules', 'show', '--digest', feedback.ruleDigest],
  revisionRequests: ['revisions', 'list', '--base-rule-digest', feedback.ruleDigest],
});
const trust = { identityVerification: 'caller-declared-unverified', certification: 'none',
  note: 'Fixture feedback never establishes a human verdict. Explicitly select feedback IDs when creating a revision request.' };

export function registerFeedbackInspectionCommands(feedback: Command, output: (value: unknown, path?: string) => Promise<void>) {
  databaseCommand(feedback, 'prepare').description('Prepare exact finding-bound feedback JSON for inspection; no feedback write, revision or governance action')
    .requiredOption('--finding-id <id>').requiredOption('--id <id>', 'Caller-selected immutable feedback ID')
    .requiredOption('--kind <kind>', 'label, resolve, merge or note')
    .option('--label <label>', 'TP, FP, Unknown or Disputed; required only for kind label')
    .requiredOption('--reason <text>').requiredOption('--actor <text>')
    .requiredOption('--source <source>', 'fixture or local-human-declared; identity remains caller-declared, not authenticated')
    .requiredOption('--created-at <iso-time>').option('--out <file>')
    .addHelpText('after', '\nInspect the generated JSON, then explicitly submit with feedback add --file. Fixture feedback never establishes a human verdict.')
    .action(async options => {
      const store = await storeFor(options);
      try {
        await output(await prepareReviewFeedback(store, { id: options.id, findingId: options.findingId,
          kind: options.kind, label: options.label ?? null, reason: options.reason, actor: options.actor,
          source: options.source, createdAt: options.createdAt }), options.out);
      } finally { await store.close(); }
    });
  databaseCommand(feedback, 'list').description('Discover immutable feedback IDs and exact evidence links for explicit revision selection')
    .option('--rule-digest <sha256>').option('--review-id <id>').option('--finding-id <id>')
    .option('--source <source>', 'fixture or local-human-declared; omitted returns both with their source labels')
    .option('--after <id>', 'Exclusive feedback ID cursor; retain the same filters')
    .option('--limit <count>', '1–100 records in ID order, not chronological order', '20').option('--out <file>')
    .addHelpText('after', '\nContinue until an empty page returns nextAfter: null. Pages are not a cross-invocation snapshot. Returned CLI links require the same database selector.')
    .action(async options => {
      const selection = ReviewFeedbackPageSchema.parse({ ruleDigest: options.ruleDigest, reviewId: options.reviewId,
        findingId: options.findingId, source: options.source, after: options.after, limit: Number(options.limit) });
      const store = await storeFor(options);
      try {
        const records = await store.listReviewFeedback(selection);
        await output({ schemaVersion: 1, kind: 'review-feedback-list', selection,
          feedback: records.map(record => ({ ...record, links: links(record) })), nextAfter: records.at(-1)?.id ?? null, trust }, options.out);
      } finally { await store.close(); }
    });
  databaseCommand(feedback, 'show').description('Inspect an exact feedback record, finding anchor, current verdict and related evidence')
    .requiredOption('--id <id>').option('--out <file>').action(async options => {
      const id = IdSchema.parse(options.id), store = await storeFor(options);
      try {
        const record = await store.getReviewFeedback(id), context = await store.getReviewFinding(record.findingId);
        await output({ schemaVersion: 1, kind: 'review-feedback-inspection', feedback: record,
          finding: context.finding, currentFindingVerdict: context.verdict, verdictScope: 'all-current-finding-feedback-not-frozen-request',
          findingFeedbackIds: context.feedback.map(item => item.id), links: links(record), trust }, options.out);
      } finally { await store.close(); }
    });
}

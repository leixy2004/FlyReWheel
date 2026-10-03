import { z } from 'zod';
import { DigestSchema } from './model.js';
import { SpanSchema } from '../adapters/candidates.js';
import { digestOf } from './identity.js';

const Text = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank text');
const Path = z.string().min(1).max(4096);
const unique = (items: readonly string[]) => new Set(items).size === items.length;
/** Snapshot/side are part of an anchor: before and after may share a path and bytes. */
export const SnapshotAnchorSchema = z.object({
  snapshotDigest: DigestSchema, side: z.enum(['before', 'after']), path: Path, sourceDigest: DigestSchema, span: SpanSchema,
}).strict();
export type SnapshotAnchor = z.infer<typeof SnapshotAnchorSchema>;
export const ReviewEvidenceSchema = z.object({ id: DigestSchema, kind: Text, anchor: SnapshotAnchorSchema, content: z.string().min(1).max(262_144) }).strict();
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;
export const FixtureJudgmentSchema = z.object({
  targetId: DigestSchema, decision: z.enum(['violation', 'safe', 'unknown']), reasoning: Text,
  evidenceRefs: z.array(DigestSchema).max(1000).refine(unique, 'Duplicate evidence references'),
  // Exact anchors explicitly adjudicated with `decision`, including safe anchors.
  // An empty safe list is the legacy target-only claim, never an anchor claim.
  findingAnchors: z.array(SnapshotAnchorSchema).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'violation' && !value.findingAnchors.length) ctx.addIssue({ code: 'custom', message: 'A violation judgment requires one or more finding anchors' });
  if (value.decision === 'unknown' && value.findingAnchors.length) ctx.addIssue({ code: 'custom', message: 'An unknown judgment cannot adjudicate finding anchors' });
  if (!unique(value.findingAnchors.map(digestOf))) ctx.addIssue({ code: 'custom', message: 'Duplicate fixture finding anchors' });
});


/** V3 separates target coverage from independent exact-anchor adjudications.
 * Context declarations stay local to each judgment, never pooled across a file. */
const ContextJudgmentSchema = z.object({
  decision: z.enum(['violation', 'safe', 'unknown']), reasoning: Text,
  evidenceRefs: z.array(DigestSchema).max(1000).refine(unique, 'Duplicate evidence references'),
  missingContext: z.array(Text).max(100).refine(unique, 'Duplicate missing context'),
}).strict();
export const AnchorJudgmentSchema = ContextJudgmentSchema.extend({ anchor: SnapshotAnchorSchema }).strict();
export type AnchorJudgment = z.infer<typeof AnchorJudgmentSchema>;
export const AnchorTargetJudgmentSchema = ContextJudgmentSchema.extend({
  targetId: DigestSchema, anchorJudgments: z.array(AnchorJudgmentSchema).max(100),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.anchorJudgments.map(item => digestOf(item.anchor)))) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate or conflicting anchor judgments' });
  }
  if (value.decision === 'violation' && !value.anchorJudgments.some(item => item.decision === 'violation')) {
    ctx.addIssue({ code: 'custom', message: 'A target violation requires an explicit violation anchor judgment' });
  }
  if (value.decision === 'safe' && value.anchorJudgments.some(item => item.decision !== 'safe')) {
    ctx.addIssue({ code: 'custom', message: 'A safe target cannot contain violation or unknown anchor judgments' });
  }
});
export type AnchorTargetJudgment = z.infer<typeof AnchorTargetJudgmentSchema>;

import { z } from 'zod';
import { DigestSchema } from '../../src/core/model.js';
import { EvaluationDatasetSchema, EvaluationAnnotationSchema } from '../../src/core/paired-evaluation.js';
const Text = z.string().trim().min(1).max(4096), Id = z.string().uuid();
const Time = z.string().datetime({ offset: true });
const label = EvaluationAnnotationSchema.shape.instances.element.shape.label;
const coverage = EvaluationAnnotationSchema.shape.coverage.element.shape.state;
export const PlanSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('blinded-development-annotation-plan'),
  origin: z.enum(['authored-fixture', 'local-human-declared']), dataset: EvaluationDatasetSchema,
  frozenAt: Time, observationCutoff: Time,
  sourceBindings: z.array(z.object({ prId: Text, snapshotDigest: DigestSchema, capturedAt: Time,
    captureEvidenceDigest: DigestSchema, historicalVisibility: z.literal('not-established') }).strict()).min(1).max(25),
  rubrics: z.array(z.object({ familyId: Text, text: Text,
    scope: z.literal('predefined-after-side-opportunities-only'),
    definitionDigest: DigestSchema }).strict()).min(1).max(8),
  // Opportunities are fixed independently of evaluated outputs, never selected from alerts.
  opportunities: z.array(EvaluationAnnotationSchema.shape.instances.element.pick({ id: true, prId: true, familyId: true,
    issueId: true, lineageId: true, anchors: true })).min(1).max(2000),
  sourceOnlyAudit: z.object({ evidenceDigest: DigestSchema, reviewerId: Text,
    rubricAndScopeIndependentOfOutputs: z.literal(true), noOutcomeMaterialInAllowedSources: z.literal(true) }).strict(),
}).strict();
export type AnnotationPlan = z.infer<typeof PlanSchema>;
export const AssignmentSchema = z.object({
  kind: z.literal('independent-annotation-assignment'), origin: z.enum(['authored-fixture', 'local-human-declared']),
  raters: z.array(z.object({ id: Text, expertise: Text, priorExposure: Text, conflictDisclosure: Text,
    noOutcomeOrArmExposureDeclared: z.literal(true), notRuleOrSourceAuthorDeclared: z.literal(true),
    independentWorkDeclared: z.literal(true) }).strict()).length(2),
  adjudicator: z.object({ id: Text, expertise: Text, priorExposure: Text, conflictDisclosure: Text,
    noOutcomeOrArmExposureDeclared: z.literal(true), notRuleOrSourceAuthorDeclared: z.literal(true) }).strict(),
}).strict();
export type Assignment = z.infer<typeof AssignmentSchema>;
const Row = z.object({ opportunityId: Id, label: label.exclude(['disputed']).nullable(), reason: Text,
  evidenceIds: z.array(Id).max(20) }).strict();
export const SubmissionSchema = z.object({
  kind: z.literal('independent-source-annotation-submission'), origin: z.enum(['authored-fixture', 'local-human-declared']),
  assignmentId: Id, participantId: Text, packetDigest: DigestSchema, submittedAt: Time,
  noOutcomeOrOtherRaterExposureDeclared: z.literal(true),
  tasks: z.array(z.object({ taskId: Id, coverage, reason: Text, minutes: z.number().finite().min(0).max(10000),
    rows: z.array(Row).max(2000) }).strict()).min(1).max(200),
}).strict();
export type Submission = z.infer<typeof SubmissionSchema>;
export const AdjudicationSchema = z.object({
  kind: z.literal('independent-source-adjudication'), origin: z.enum(['authored-fixture', 'local-human-declared']),
  assignmentId: Id, adjudicatorId: Text, packetDigest: DigestSchema,
  submissionDigests: z.array(DigestSchema).length(2), submittedAt: Time,
  noOutcomeOrArmExposureDeclared: z.literal(true),
  tasks: z.array(z.object({ taskId: Id, coverage, reason: Text,
    rows: z.array(z.object({ opportunityId: Id,
      decision: z.enum(['accept-a', 'accept-b', 'unknown', 'disputed', 'unassessed']), reason: Text,
      evidenceIds: z.array(Id).max(20) }).strict()).max(2000) }).strict()).min(1).max(200),
}).strict();

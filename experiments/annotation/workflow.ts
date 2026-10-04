import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { digestOf } from '../../src/core/identity.js';
import { validateSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { writeEvaluationJson, validateEvaluationAnnotations } from '../../src/paired-evaluation.js';
import { EvaluationAnnotationSchema } from '../../src/core/paired-evaluation.js';
import { PlanSchema, AssignmentSchema, SubmissionSchema, AdjudicationSchema, type AnnotationPlan, type Assignment, type Submission } from './contracts.js';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const LOCKED_RECEIPT_BYTES = 16_000_000;
const unique = (xs: string[], name: string) => { if (new Set(xs).size !== xs.length) throw new Error(`Duplicate ${name}`); };
const same = (a: unknown, b: unknown) => digestOf(a) === digestOf(b);
const seal = <T extends object>(body: T) => ({ ...body, digest: digestOf(body) });
function checkSeal<T extends { digest: string }>(value: T) {
  const { digest, ...body } = value; if (digestOf(body) !== digest) throw new Error('Locked record digest mismatch');
  return value;
}
export function validatePlan(raw: unknown) {
  const plan = PlanSchema.parse(raw), dataset = plan.dataset;
  if ((plan.origin === 'authored-fixture') !== (dataset.sampling.kind === 'synthetic')
    || dataset.prs.some(p => p.split !== (plan.origin === 'authored-fixture' ? 'synthetic' : 'development'))
    || dataset.temporal.visibility !== (plan.origin === 'authored-fixture' ? 'synthetic' : 'current-capture')) throw new Error('Only synthetic or current-capture development annotation is supported; historical/holdout release remains blocked');
  if (Date.parse(plan.observationCutoff) > Date.parse(plan.frozenAt)
    || dataset.temporal.annotationObservationCutoff !== plan.observationCutoff) throw new Error('Observation cutoff/freeze mismatch');
  unique(dataset.prs.map(p => p.id), 'PR'); unique(dataset.families.map(f => f.id), 'family');
  unique(plan.sourceBindings.map(p => p.prId), 'source binding'); unique(plan.rubrics.map(r => r.familyId), 'rubric');
  unique(plan.opportunities.map(o => o.id), 'opportunity');
  unique(plan.opportunities.map(o => JSON.stringify([o.prId, o.familyId, o.issueId])), 'issue');
  unique(plan.opportunities.map(o => JSON.stringify([o.prId, o.familyId, o.lineageId])), 'lineage');
  if (plan.sourceBindings.length !== dataset.prs.length || plan.rubrics.length !== dataset.families.length) throw new Error('Complete source/rubric roster required');
  for (const pr of dataset.prs) {
    const binding = plan.sourceBindings.find(s => s.prId === pr.id);
    if (!binding || binding.snapshotDigest !== pr.snapshot.digest || pr.repository !== pr.snapshot.snapshot.repository.id
      || Date.parse(binding.capturedAt) > Date.parse(plan.observationCutoff)) throw new Error('Source/cutoff binding mismatch');
  }
  for (const family of dataset.families) {
    const rubric = plan.rubrics.find(r => r.familyId === family.id);
    if (!rubric || rubric.definitionDigest !== digestOf(rubric.text) || family.definitionDigest !== rubric.definitionDigest) throw new Error('Frozen rubric binding mismatch');
  }
  const occupied = new Set<string>();
  for (const opportunity of plan.opportunities) {
    const pr = dataset.prs.find(p => p.id === opportunity.prId);
    if (!pr || !dataset.families.some(f => f.id === opportunity.familyId)) throw new Error('Opportunity outside frozen roster');
    for (const anchor of opportunity.anchors) {
      if (anchor.side !== 'after') throw new Error('Before-only drafts cannot become head-review annotation tasks');
      validateSnapshotAnchor(anchor, pr.snapshot);
      const key = JSON.stringify([pr.id, opportunity.familyId, anchor]);
      if (occupied.has(key)) throw new Error('Overlapping duplicate opportunity anchor'); occupied.add(key);
    }
  }
  return plan;
}
function validateAssignment(raw: unknown, plan: AnnotationPlan) {
  const assignment = AssignmentSchema.parse(raw);
  if (assignment.origin !== plan.origin) throw new Error('Assignment origin mismatch');
  unique([...assignment.raters.map(r => r.id), assignment.adjudicator.id], 'independent participant identity');
  return assignment;
}
/** Refuse Git ancestors and symlinks, including parent symlinks. Existing parents
 * must exist. This is local filesystem isolation, not a multi-user access service. */
export async function privatePath(path: string, existing = false) {
  const absolute = resolve(path);
  let current = existing ? absolute : dirname(absolute);
  for (;;) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private annotation path must use real directories');
    try {
      const marker = join(current, '.git'), entry = await lstat(marker);
      // Managed environments mount empty read-only .git guard directories at
      // writable roots. They contain no repository. Gitfiles, links and any
      // nonempty Git directory still block private annotation release.
      if (!entry.isDirectory() || entry.isSymbolicLink() || (await readdir(marker)).length) {
        throw new Error('Private annotation workspaces must be outside Git worktrees');
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  if (existing && (await lstat(absolute)).mode & 0o077) throw new Error('Private annotation workspace permissions must be 0700');
  return absolute;
}
export function prepareExport(planInput: unknown, assignmentInput: unknown) {
  const plan = validatePlan(planInput), assignment = validateAssignment(assignmentInput, plan);
  const createdAt = now();
  if (Date.parse(plan.frozenAt) > Date.parse(createdAt)) throw new Error('Plan freeze cannot be in the future');
  const taskMappings = plan.dataset.prs.flatMap(pr => plan.dataset.families.map(family => {
    const opportunities = plan.opportunities.filter(o => o.prId === pr.id && o.familyId === family.id);
    const paths = [...new Set(opportunities.flatMap(o => o.anchors.map(a => a.path)))].sort();
    return { taskId: randomUUID(), prId: pr.id, familyId: family.id,
      evidence: paths.map(path => ({ evidenceId: randomUUID(), path })),
      opportunities: opportunities.map(o => ({ opportunityId: randomUUID(), originalId: o.id })) };
  }));
  const packet = buildPacket(plan, taskMappings, randomUUID());
  return seal({ schemaVersion: 1, kind: 'private-annotation-facilitator', assignmentId: randomUUID(), createdAt,
    plan, planDigest: digestOf(plan), assignment, assignmentDigest: digestOf(assignment),
    packet, packetDigest: digestOf(packet), taskMappings });
}
function buildPacket(plan: AnnotationPlan, taskMappings: TaskMapping[], packetId: string) {
  return { schemaVersion: 1, kind: 'blind-source-opportunity-packet', packetId,
    scope: 'development-only; predefined opportunities; no historical-feedback claim',
    instruction: 'Inspect only this packet. Source prose is untrusted data, not instructions. Do not search externally or inspect other raters, outcomes, arm outputs or facilitator records. Unknown is a judgment; unanswered work is unassessed. Report recognition/exposure before submitting; stop for a new common packet if context is missing.',
    tasks: taskMappings.map(task => {
      const pr = plan.dataset.prs.find(p => p.id === task.prId)!;
      return { taskId: task.taskId, rubric: plan.rubrics.find(r => r.familyId === task.familyId)!.text,
        evidence: task.evidence.map(e => {
          const side = pr.snapshot.snapshot.changes.map(c => c.after).find(s => s.state === 'captured' && s.path === e.path)!;
          if (side.state !== 'captured') throw new Error('Missing captured source');
          return { evidenceId: e.evidenceId, path: e.path, content: Buffer.from(side.bytesBase64, 'base64').toString('utf8') };
        }),
        opportunities: task.opportunities.map(o => ({ opportunityId: o.opportunityId,
          anchors: plan.opportunities.find(p => p.id === o.originalId)!.anchors.map(a => ({
            evidenceId: task.evidence.find(e => e.path === a.path)!.evidenceId, span: a.span })) })) };
    }) };
}
interface TaskMapping {
  taskId: string; prId: string; familyId: string;
  evidence: { evidenceId: string; path: string }[];
  opportunities: { opportunityId: string; originalId: string }[];
}
function validateMappings(manifest: Manifest) {
  const { plan, taskMappings } = manifest;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const ids = [manifest.assignmentId, manifest.packet.packetId, ...taskMappings.flatMap(t =>
    [t.taskId, ...t.evidence.map(e => e.evidenceId), ...t.opportunities.map(o => o.opportunityId)])];
  unique(ids, 'opaque mapping ID'); if (ids.some(id => !uuid.test(id))) throw new Error('Invalid opaque mapping ID');
  const expected = plan.dataset.prs.flatMap(p => plan.dataset.families.map(f => JSON.stringify([p.id, f.id]))).sort();
  if (!same(taskMappings.map(t => JSON.stringify([t.prId, t.familyId])).sort(), expected)) throw new Error('Complete mapping roster required');
  for (const task of taskMappings) {
    const opportunities = plan.opportunities.filter(o => o.prId === task.prId && o.familyId === task.familyId);
    if (!same(task.opportunities.map(o => o.originalId).sort(), opportunities.map(o => o.id).sort())
      || !same(task.evidence.map(e => e.path).sort(), [...new Set(opportunities.flatMap(o => o.anchors.map(a => a.path)))].sort())) throw new Error('Source opportunity mapping mismatch');
  }
  if (!same(manifest.packet, buildPacket(plan, taskMappings, manifest.packet.packetId))) throw new Error('Blind packet differs from frozen allowlist');
}
type Manifest = ReturnType<typeof prepareExport>;
function blank(manifest: Manifest, participantId: string) {
  return { kind: 'independent-source-annotation-submission', origin: manifest.plan.origin,
    assignmentId: manifest.assignmentId, participantId, packetDigest: manifest.packetDigest, submittedAt: null,
    noOutcomeOrOtherRaterExposureDeclared: null,
    tasks: manifest.packet.tasks.map(t => ({ taskId: t.taskId, coverage: 'unassessed', reason: null, minutes: null,
      rows: t.opportunities.map(o => ({ opportunityId: o.opportunityId, label: null, reason: null, evidenceIds: [] })) })) };
}
export async function exportAnnotation(plan: unknown, assignment: unknown, path: string) {
  const manifest = prepareExport(plan, assignment), root = await privatePath(path);
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'facilitator'), { mode: 0o700 });
  await mkdir(join(root, 'locks'), { mode: 0o700 });
  await writeEvaluationJson(join(root, 'facilitator', 'manifest.json'), manifest);
  for (const [index, rater] of manifest.assignment.raters.entries()) {
    const folder = join(root, `rater-${index + 1}`); await mkdir(folder, { mode: 0o700 });
    await writeEvaluationJson(join(folder, 'packet.json'), manifest.packet);
    await writeEvaluationJson(join(folder, 'response.blank.json'), blank(manifest, rater.id));
  }
  return { root, assignmentId: manifest.assignmentId, packetDigest: manifest.packetDigest, origin: manifest.plan.origin,
    state: 'awaiting-two-independent-submissions', humanAnnotationsCollected: 0 };
}
async function loadManifest(root: string): Promise<Manifest> {
  await privatePath(root, true);
  const manifest = checkSeal(await readPrivate(join(root, 'facilitator', 'manifest.json'), 16_000_000) as Manifest);
  validatePlan(manifest.plan); validateAssignment(manifest.assignment, manifest.plan); validateMappings(manifest);
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || Date.parse(manifest.createdAt) < Date.parse(manifest.plan.frozenAt)
    || Date.parse(manifest.createdAt) > Date.now()) throw new Error('Invalid assignment creation time');
  if (!same(manifest.plan, PlanSchema.parse(manifest.plan)) || manifest.planDigest !== digestOf(manifest.plan)
    || manifest.assignmentDigest !== digestOf(manifest.assignment) || manifest.packetDigest !== digestOf(manifest.packet)) throw new Error('Manifest binding mismatch');
  for (const index of [1, 2]) {
    if (!same(await readPrivate(join(root, `rater-${index}`, 'packet.json'), 16_000_000), manifest.packet)) throw new Error('Released packet changed');
  }
  return manifest;
}
function roster(rows: { taskId: string }[], manifest: Manifest) {
  unique(rows.map(t => t.taskId), 'task');
  if (!same(rows.map(t => t.taskId).sort(), manifest.packet.tasks.map(t => t.taskId).sort())) throw new Error('Complete task roster required');
}
function checkRows(task: Submission['tasks'][number], manifest: Manifest) {
  const source = manifest.packet.tasks.find(t => t.taskId === task.taskId)!;
  unique(task.rows.map(r => r.opportunityId), 'response opportunity');
  if (!same(task.rows.map(r => r.opportunityId).sort(), source.opportunities.map(o => o.opportunityId).sort())) throw new Error('Complete opportunity roster required');
  for (const row of task.rows) {
    unique(row.evidenceIds, 'evidence reference');
    const allowed: string[] = source.opportunities.find(o => o.opportunityId === row.opportunityId)!.anchors.map(a => a.evidenceId);
    if (row.evidenceIds.some(id => !allowed.includes(id)) || (row.label !== null && !row.evidenceIds.length)) throw new Error('Source evidence reference mismatch');
    if ((task.coverage === 'unassessed' && row.label !== null) || (task.coverage === 'complete-declared' && row.label === null)
      || (task.coverage === 'excluded' && row.label !== 'excluded')) throw new Error('Coverage/label mismatch');
  }
}
async function rawInput(path: string, maxBytes = 4_000_000) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat(); if (!stat.isFile() || stat.size > maxBytes) throw new Error('Submission must be a bounded regular file');
    const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < bytes.length) { const r = await fd.read(bytes, length, bytes.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
    if (length > maxBytes) throw new Error('Submission too large');
    const raw = bytes.subarray(0, length);
    return { raw, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown };
  } finally { await fd.close(); }
}
async function readPrivate(path: string, maxBytes: number) {
  await privatePath(dirname(path), true);
  return (await rawInput(path, maxBytes)).value;
}
function checkTime(submittedAt: string, createdAt: string, importedAt: string) {
  if (![submittedAt, createdAt, importedAt].every(v => Number.isFinite(Date.parse(v))) || Date.parse(submittedAt) < Date.parse(createdAt) || Date.parse(submittedAt) > Date.parse(importedAt)) throw new Error('Submission time outside assignment/import bounds');
}
export async function importAnnotation(root: string, path: string) {
  const manifest = await loadManifest(root), { raw, value } = await rawInput(path), submission = SubmissionSchema.parse(value);
  const index = manifest.assignment.raters.findIndex(r => r.id === submission.participantId), importedAt = now();
  if (index < 0 || submission.origin !== manifest.plan.origin || submission.assignmentId !== manifest.assignmentId
    || submission.packetDigest !== manifest.packetDigest) throw new Error('Participant/packet/assignment mismatch');
  checkTime(submission.submittedAt, manifest.createdAt, importedAt); roster(submission.tasks, manifest);
  submission.tasks.forEach(t => checkRows(t, manifest));
  const record = seal({ manifestDigest: manifest.digest, rawSha256: hash(raw), importedAt, submission });
  const receiptText = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(receiptText) > LOCKED_RECEIPT_BYTES) throw new Error('Locked receipt exceeds byte limit');
  const folder = join(root, 'locks', `rater-${index + 1}`);
  await privatePath(dirname(folder), true);
  await mkdir(folder, { mode: 0o700 }); // A crash leaves a blocked slot; never silently overwrite it.
  await writeFile(join(folder, 'original.json'), raw, { flag: 'wx', mode: 0o600 });
  await writeFile(join(folder, 'receipt.json'), receiptText, { flag: 'wx', mode: 0o600 });
  return { state: 'submission-locked', submissionDigest: record.digest, rawSha256: record.rawSha256, importedAt,
    humanIdentityVerification: 'locally-declared-unverified', origin: submission.origin };
}
type Locked = { manifestDigest: string; rawSha256: string; importedAt: string; submission: Submission; digest: string };
async function locked(root: string, manifest: Manifest, index: number): Promise<Locked> {
  const folder = join(root, 'locks', `rater-${index + 1}`);
  const record = checkSeal(await readPrivate(join(folder, 'receipt.json'), LOCKED_RECEIPT_BYTES) as Locked);
  const { raw, value } = await rawInput(join(folder, 'original.json'));
  if (record.manifestDigest !== manifest.digest || record.rawSha256 !== hash(raw) || !same(record.submission, SubmissionSchema.parse(value))
    || record.submission.participantId !== manifest.assignment.raters[index].id
    || record.submission.packetDigest !== manifest.packetDigest || record.submission.assignmentId !== manifest.assignmentId
    || record.submission.origin !== manifest.plan.origin) throw new Error('Locked submission binding mismatch');
  checkTime(record.submission.submittedAt, manifest.createdAt, record.importedAt);
  roster(record.submission.tasks, manifest); record.submission.tasks.forEach(t => checkRows(t, manifest));
  return record;
}
function adjudicationPacket(manifest: Manifest, records: Locked[]) {
  return { kind: 'blind-source-adjudication-packet', assignmentId: manifest.assignmentId,
    packetDigest: manifest.packetDigest, submissionDigests: records.map(r => r.digest), sourcePacket: manifest.packet,
    responses: records.map((r, index) => ({ slot: index === 0 ? 'a' : 'b', tasks: r.submission.tasks })) };
}
export async function exportAdjudication(root: string) {
  const manifest = await loadManifest(root), records = await Promise.all([locked(root, manifest, 0), locked(root, manifest, 1)]);
  // No participant IDs, provenance, author metadata or private source mappings in this view.
  const packet = adjudicationPacket(manifest, records);
  const folder = join(root, 'adjudicator'); await mkdir(folder, { mode: 0o700 });
  await writeEvaluationJson(join(folder, 'packet.json'), packet);
  await writeEvaluationJson(join(folder, 'response.blank.json'), { kind: 'independent-source-adjudication', origin: manifest.plan.origin,
    assignmentId: manifest.assignmentId, adjudicatorId: manifest.assignment.adjudicator.id, packetDigest: manifest.packetDigest,
    submissionDigests: records.map(r => r.digest), submittedAt: null, noOutcomeOrArmExposureDeclared: null,
    tasks: manifest.packet.tasks.map(t => ({ taskId: t.taskId, coverage: 'unassessed', reason: null,
      rows: t.opportunities.map(o => ({ opportunityId: o.opportunityId, decision: null, reason: null, evidenceIds: [] })) })) });
  await writeEvaluationJson(join(root, 'facilitator', 'adjudication-release.json'), seal({ manifestDigest: manifest.digest,
    packetDigest: digestOf(packet), submissionDigests: records.map(r => r.digest), releasedAt: now() }));
  return { state: 'adjudication-exported', packetDigest: digestOf(packet), submissionDigests: records.map(r => r.digest) };
}
export async function importAdjudication(root: string, path: string) {
  const manifest = await loadManifest(root), records = await Promise.all([locked(root, manifest, 0), locked(root, manifest, 1)]);
  const release = checkSeal(await readPrivate(join(root, 'facilitator', 'adjudication-release.json'), 100_000) as {
    manifestDigest: string; packetDigest: string; submissionDigests: string[]; releasedAt: string; digest: string });
  const packet = await readPrivate(join(root, 'adjudicator', 'packet.json'), 16_000_000);
  if (!same(packet, adjudicationPacket(manifest, records)) || release.manifestDigest !== manifest.digest || release.packetDigest !== digestOf(packet)
    || !same(release.submissionDigests, records.map(r => r.digest))) throw new Error('Adjudication release binding mismatch');
  const { raw, value } = await rawInput(path), response = AdjudicationSchema.parse(value), importedAt = now();
  if (response.origin !== manifest.plan.origin || response.assignmentId !== manifest.assignmentId
    || response.adjudicatorId !== manifest.assignment.adjudicator.id || response.packetDigest !== manifest.packetDigest
    || !same(response.submissionDigests, records.map(r => r.digest))) throw new Error('Adjudicator/two-submission binding mismatch');
  checkTime(response.submittedAt, release.releasedAt, importedAt); roster(response.tasks, manifest);
  const tasks = response.tasks.map(t => ({ ...t, minutes: 0, rows: t.rows.map(r => {
    const a = records[0].submission.tasks.find(v => v.taskId === t.taskId)!.rows.find(v => v.opportunityId === r.opportunityId);
    const b = records[1].submission.tasks.find(v => v.taskId === t.taskId)!.rows.find(v => v.opportunityId === r.opportunityId);
    if (!a || !b) throw new Error('Adjudicated opportunity outside submissions');
    const label = r.decision === 'accept-a' ? a.label : r.decision === 'accept-b' ? b.label
      : r.decision === 'unassessed' ? null : r.decision;
    // An absent judgment is not an Unknown or disputed instance invented by adjudication.
    if (a.label === null && b.label === null && label !== null) throw new Error('Both judgments missing; retain unassessed');
    return { opportunityId: r.opportunityId, label, reason: r.reason, evidenceIds: r.evidenceIds };
  }) }));
  // Same frozen roster/evidence/coverage checks; disputed is adjudication-only.
  tasks.forEach(t => checkRows(t as Submission['tasks'][number], manifest));
  const annotation = EvaluationAnnotationSchema.parse({ schemaVersion: 1, kind: 'paired-review-evaluation-annotations',
    id: manifest.assignmentId, version: 'blinded-development-v1', datasetDigest: digestOf(manifest.plan.dataset), rubricDigest: digestOf(manifest.plan.rubrics),
    provenance: { origin: manifest.plan.origin === 'authored-fixture' ? 'synthetic' : 'adjudicated',
      verification: 'locally-declared-unverified', authors: [...manifest.assignment.raters.map(r => r.id), manifest.assignment.adjudicator.id],
      independentOfRuns: manifest.plan.origin !== 'authored-fixture', blindedToOutputs: manifest.plan.origin !== 'authored-fixture',
      procedure: 'Two locked declared independent source-only submissions and a distinct adjudicator; predefined development opportunities only. Identities/blinding unverified; no historical feedback or H2 label adaptation.',
      evidenceDigests: [manifest.digest, ...records.map(r => r.digest), digestOf(response)] },
    coverage: tasks.map(t => { const m = manifest.taskMappings.find(m => m.taskId === t.taskId)!;
      return { prId: m.prId, familyId: m.familyId, state: t.coverage, reason: t.reason }; }),
    instances: tasks.flatMap(t => t.rows.filter(r => r.label !== null).map(r => {
      const mapping = manifest.taskMappings.find(m => m.taskId === t.taskId)!;
      const original = manifest.plan.opportunities.find(o => o.id === mapping.opportunities.find(o => o.opportunityId === r.opportunityId)!.originalId)!;
      return { ...original, label: r.label, reason: r.reason, evidenceDigests: original.anchors.map(a => a.sourceDigest) };
    })) });
  validateEvaluationAnnotations(manifest.plan.dataset, annotation);
  const report = seal({ kind: 'blinded-development-annotation-audit', origin: manifest.plan.origin,
    independentHumanAnnotationsVerified: 0, identityVerification: 'locally-declared-unverified',
    manifestDigest: manifest.digest, submissionDigests: records.map(r => r.digest), rawSha256: hash(raw), importedAt,
    response, annotations: annotation, agreement: agreement(records),
    boundaries: ['Development only; no formal holdout or historical feedback claim',
      'Source/rubric/identity/blinding declarations are not independent attestations',
      'Unknown/disputed are not known-positive/negative; missing remains unassessed',
      'No automatic matched H2 label conversion or runtime feedback writes'] });
  const folder = join(root, 'locks', 'adjudication'); await privatePath(dirname(folder), true); await mkdir(folder, { mode: 0o700 });
  await writeFile(join(folder, 'original.json'), raw, { flag: 'wx', mode: 0o600 });
  await writeEvaluationJson(join(folder, 'report.json'), report);
  await writeEvaluationJson(join(folder, 'annotations.json'), annotation);
  return { state: 'adjudication-locked', digest: report.digest, origin: manifest.plan.origin,
    independentHumanAnnotationsVerified: 0, agreement: report.agreement };
}
function agreement(records: Locked[]) {
  const labels = ['positive', 'negative', 'unknown'] as const;
  const table = labels.map(() => labels.map(() => 0)); let missing = 0, excluded = 0, equal = 0, n = 0;
  for (const task of records[0].submission.tasks) for (const a of task.rows) {
    const b = records[1].submission.tasks.find(t => t.taskId === task.taskId)!.rows.find(r => r.opportunityId === a.opportunityId)!;
    if (a.label === null || b.label === null) { missing++; continue; }
    if (a.label === 'excluded' || b.label === 'excluded') { excluded++; continue; }
    table[labels.indexOf(a.label)][labels.indexOf(b.label)]++; n++; if (a.label === b.label) equal++;
  }
  const expected = n ? labels.reduce((sum, _, i) => sum + table[i].reduce((a, b) => a + b, 0)
    * table.reduce((sum, row) => sum + row[i], 0), 0) / (n * n) : null;
  const coverageLabels = ['complete-declared', 'partial', 'unassessed', 'excluded'] as const;
  const coverageTable = coverageLabels.map(() => coverageLabels.map(() => 0));
  for (const task of records[0].submission.tasks) {
    const other = records[1].submission.tasks.find(t => t.taskId === task.taskId)!;
    coverageTable[coverageLabels.indexOf(task.coverage)][coverageLabels.indexOf(other.coverage)]++;
  }
  return { basis: 'pre-adjudication fixed opportunities; no post-hoc alignment', labels, contingency: table,
    coverageLabels, coverageContingency: coverageTable,
    pairedRated: n, missingPairs: missing, excludedPairs: excluded, rawAgreement: n ? equal / n : null,
    kappa: n && expected !== null && expected < 1 ? (equal / n - expected) / (1 - expected) : null };
}

export async function inspectAnnotation(root: string) {
  const manifest = await loadManifest(root);
  const submissions = [];
  for (const index of [0, 1]) {
    const folder = join(root, 'locks', `rater-${index + 1}`);
    try { await lstat(folder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      submissions.push({ slot: index + 1, state: 'missing', digest: null }); continue;
    }
    try { const record = await locked(root, manifest, index); submissions.push({ slot: index + 1, state: 'locked', digest: record.digest }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      submissions.push({ slot: index + 1, state: 'incomplete-lock-no-overwrite', digest: null });
    }
  }
  return { origin: manifest.plan.origin, packetDigest: manifest.packetDigest, submissions,
    readyForAdjudication: submissions.every(s => s.state === 'locked'), independentHumanAnnotationsVerified: 0,
    boundary: 'Declared identities, development-only source annotation; missing work has no label' };
}

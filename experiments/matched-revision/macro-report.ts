import { SemanticRuleVersionSchema } from '../../src/core/semantic-rule.js';
import { digestOf } from '../../src/core/identity.js';
import { ARMS, ProposalSchema, UsageSchema, type Proposal, type FrozenPacket, type FrozenFuture } from './contracts.js';
import { commonRevisionBlock, initialMemory, initialStructured, validatePacket, validateProposal } from './validation.js';
import { scoreFuture, observations, evaluateGate } from './scoring.js';
import { proposalRequest, reviewRequest } from './prompts.js';
import { nativeProposalRequest, nativeReviewRequest } from './sdk-native-runner.js';
import { checkNativeCall, checkNativeDiagnosis, type NativeMacroContext } from './native-macro-integrity.js';
import { validateSdkNativeSchedule, validateSdkNativeScheduledInput } from './sdk-native-schedule.js';
import { runMatchedRevision } from './runner.js';

type Completed = Extract<Awaited<ReturnType<typeof runMatchedRevision>>, { execution: 'completed' }>;
export interface PlannedResult { packet: FrozenPacket; future: FrozenFuture; repetition: number; report: Completed | null; native?: NativeMacroContext }
export const MACRO_METRICS = ['positiveRecall', 'repeatedFeedbackFalseAlarmRate',
  'repeatedFeedbackStrictResolution', 'repeatedFeedbackCoverage'] as const;
type Metric = typeof MACRO_METRICS[number];
export interface MacroValue { repository: string; family: string; episode: string; repetition: number; value: number | null }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function summary(xs: (number | null)[]) {
  const known = xs.filter((v): v is number => v !== null);
  return { value: xs.length && known.length === xs.length ? mean(known) : null,
    completeCaseDescriptive: known.length ? mean(known) : null, planned: xs.length, estimable: known.length };
}
/** Equal repetition -> episode -> family within repository -> repository weights. */
export function macroHierarchy(rows: MacroValue[]) {
  const keys = rows.map(r => JSON.stringify([r.repository, r.family, r.episode, r.repetition]));
  if (new Set(keys).size !== keys.length || rows.some(r => !r.repository || !r.family || !r.episode
    || !Number.isSafeInteger(r.repetition) || r.repetition < 1
    || (r.value !== null && (!Number.isFinite(r.value) || Math.abs(r.value) > 1)))) throw new Error('Invalid or duplicate macro unit');
  const groups = <T>(xs: T[], key: (v: T) => string) => [...new Set(xs.map(key))].sort()
    .map(id => ({ id, rows: xs.filter(x => key(x) === id) }));
  const repositories = groups(rows, r => r.repository).map(repo => {
    const families = groups(repo.rows, r => r.family).map(family => {
      const episodes = groups(family.rows, r => r.episode).map(ep => ({ episode: ep.id,
        ...summary(ep.rows.map(r => r.value)), repetitions: ep.rows.map(r => ({ repetition: r.repetition, value: r.value })) }));
      return { family: family.id, ...summary(episodes.map(e => e.value)), episodes };
    });
    return { repository: repo.id, ...summary(families.map(f => f.value)), families };
  });
  return { ...summary(repositories.map(r => r.value)), repositories,
    weighting: 'equal-repository/equal-family/equal-episode/equal-repetition' as const };
}
/** Mathematical reference only. Caller must establish independent random clusters.
 * No empirical admission path currently exists in the authored result reader. */
export function boundedRepositoryDifference(values: number[], alpha = 0.05) {
  if (values.length < 2 || !(alpha > 0 && alpha < 1) || values.some(v => !Number.isFinite(v) || Math.abs(v) > 1)) {
    throw new Error('Bound needs >=2 finite repository contrasts in [-1,1] and 0<alpha<1');
  }
  const center = mean(values), halfWidth = Math.sqrt(2 * (Math.log(2) - Math.log(alpha)) / values.length);
  return { center, halfWidth, lower: Math.max(-1, center - halfWidth), upper: Math.min(1, center + halfWidth),
    alpha, independentRepositoryCount: values.length, method: 'two-sided-Hoeffding-bounded-difference' as const,
    scope: 'mathematical-reference-not-empirical-interval' as const };
}

/** Consume existing frozen packets/futures and runner reports, not a second result schema. */
export function aggregateMatchedResults(planned: PlannedResult[]) {
  if (!planned.length) throw new Error('An explicit planned roster is required');
  const reportDigests = new Set<string>();
  const identities = new Set<string>(), episodePins = new Map<string, string>();
  const units = planned.map(item => {
    const native = item.native, config = native?.configuration;
    if (native) {
      validateSdkNativeSchedule(native.schedule, native.configuration);
      const expected = validateSdkNativeScheduledInput(native.schedule, native.block.blockId, item);
      if (digestOf(expected) !== digestOf(native.block)) throw new Error('Native block substitution');
    }
    const validated = validatePacket(item.packet, item.future, config ? {
      renderedPersistentStateBytes: config.limits.renderedPersistentStateBytes, model: config.roles.proposal.model,
      maxOutputBytes: config.limits.answerBytes.proposal, timeoutMs: config.limits.deadlineMsPerCall } : undefined);
    const { prepared } = validated;
    let episode = validated.episode;
    const cases = native ? native.block.futureTargetOrder.map(id => validated.cases.find(c => c.input.id === id)!) : validated.cases;
    const scheduledDiagnosis = native?.schedule.counting.diagnosis === 'authored-sdk-once-per-inferred-block' && episode.diagnosis.condition === 'inferred';
    if (item.report && scheduledDiagnosis) {
      if (!item.report.diagnosisStage) throw new Error('Missing native diagnosis stage');
      episode = { ...episode, diagnosis: checkNativeDiagnosis(item.report.diagnosisStage, episode, prepared, native!) };
    } else if (item.report?.diagnosisStage) throw new Error('Unscheduled diagnosis stage');
    const repositories = [...new Set(episode.revision.snapshots.map(s => s.snapshot.repository.id))];
    if (repositories.length !== 1 || SemanticRuleVersionSchema.parse(episode.revision.baseRule.rule).scope.repositories.some(r => r !== repositories[0])) throw new Error('Ambiguous repository binding');
    if (!Number.isSafeInteger(item.repetition) || item.repetition < 1) throw new Error('Invalid repetition');
    const repository = repositories[0], family = episode.familyId;
    const stratum = digestOf({ condition: episode.diagnosis.condition,
      ...(native ? { nativeConfigurationDigest: digestOf(config!), scheduleDigest: native.schedule.digest, evaluation: native.evaluation ?? null }
        : { diagnoses: [...new Set(episode.diagnosis.diagnoses.map(d => d.category))].sort(), settings: episode.settings }),
      protocol: episode.protocolRecordDigest });
    const id = JSON.stringify([repository, family, episode.id, episode.diagnosis.condition, item.repetition]);
    if (identities.has(id)) throw new Error('Duplicate paired unit'); identities.add(id);
    const episodeKey = JSON.stringify([repository, family, episode.id, episode.diagnosis.condition]);
    const pin = digestOf([native ? native.schedule.sources.find(s => digestOf(s) === native.block.sourceDigest)!.episodeInputDigest : item.packet.digest, item.future.digest]);
    if (episodePins.has(episodeKey) && episodePins.get(episodeKey) !== pin) throw new Error('Repetitions changed the frozen episode/future');
    episodePins.set(episodeKey, pin);
    const report = item.report;
    if (report) {
      if (reportDigests.has(report.digest)) throw new Error('Same report cannot populate multiple repetition slots');
      reportDigests.add(report.digest);
      if (report.schemaVersion !== 1 || report.kind !== 'matched-revision-fixture-report' || report.execution !== 'completed'
        || report.modelExecution !== 'not_run' || report.empiricalEpisodes !== 0 || report.independentHumanAnnotations !== 0
        || digestOf(report.sharedDiagnosis) !== digestOf(episode.diagnosis)) throw new Error('Expected internally consistent authored runner report');
      const { digest, ...body } = report;
      if (digestOf(body) !== digest || report.packetDigest !== item.packet.digest || report.futureDigest !== item.future.digest
        || report.episodeId !== episode.id || report.condition !== episode.diagnosis.condition
        || report.arms.length !== 4 || new Set(report.arms.map(a => a.arm)).size !== 4
        || report.arms.some(a => !ARMS.includes(a.arm))) throw new Error('Report/paired roster identity mismatch');
      if (native) {
        const profile = report.nativeProfile;
        if (!profile || profile.configurationDigest !== digestOf(config!) || digestOf(profile.configuration) !== digestOf(config!)
          || profile.blockId !== native.block.blockId || profile.repetition !== item.repetition
          || profile.scheduleDigest !== native.schedule.digest || profile.declaredScheduleDigestsVerified !== true
          || digestOf(profile.armOrder) !== digestOf(native.block.armOrder)
          || digestOf(profile.futureTargetOrder) !== digestOf(native.block.futureTargetOrder)
          || digestOf(report.arms.map(a => a.arm)) !== digestOf(native.block.armOrder)) throw new Error('Native profile/paired roster mismatch');
      } else if (report.nativeProfile) throw new Error('Native reports require their frozen native schedule');
    }
    const arms = ARMS.map(arm => {
      const a = report?.arms.find(a => a.arm === arm);
      let observed = observations(cases.map(c => c.input), null, 'not_run');
      if (a) {
        const common = commonRevisionBlock(episode, prepared, config ?? episode.settings);
        if (a.condition !== episode.diagnosis.condition || a.sharedDiagnosisDigest !== digestOf(episode.diagnosis)
          || a.commonRevisionInputDigest !== digestOf(common)) throw new Error('Arm supervision identity mismatch');
        const incumbent = arm === 'M' ? initialMemory(prepared) : initialStructured(prepared);
        const expectedStages = arm === 'F' ? ['gate', 'future'] : ['proposal', 'gate', 'future'];
        if (digestOf(a.calls.map(c => c.stage)) !== digestOf(expectedStages)) throw new Error('Missing or duplicate call roster');
        let proposal: Proposal | null = null;
        let disposition = 'frozen_reference';
        if (arm !== 'F') {
          const proposalCall = a.calls[0];
          if (proposalCall.status !== 'completed') disposition = proposalCall.invoked ? 'failed' : 'not_run';
          else if (!ProposalSchema.safeParse(proposalCall.output).success) disposition = 'schema_invalid';
          else {
            try {
              proposal = validateProposal(proposalCall.output, arm, episode, prepared, config?.limits.renderedPersistentStateBytes);
              disposition = { revise: 'changed', retain: 'retained', abstain: 'abstained', request_context: 'context_requested' }[proposal.action];
            } catch { disposition = 'policy_invalid'; }
          }
        }
        const gateCall = a.calls.find(c => c.stage === 'gate')!;
        const gate = evaluateGate(episode.gate, observations(episode.gate.map(g => g.input), gateCall.output,
          gateCall.status === 'completed' ? null : gateCall.status === 'budget_exhausted' ? 'not_run_budget_exhausted' : gateCall.status));
        const acceptedChange = disposition === 'changed' && gate.passed;
        const effectiveState = acceptedChange ? proposal!.state! : incumbent;
        if (digestOf(a.proposal) !== digestOf(proposal) || a.disposition !== disposition
          || a.acceptedChange !== acceptedChange || digestOf(a.effectiveState) !== digestOf(effectiveState)) {
          throw new Error('Proposal/gate/effective state mismatch');
        }
        for (const call of a.calls) {
          // Oversized raw output is intentionally discarded by the runner, retaining its digest only.
          if ((call.output !== null || call.status === 'completed') && call.outputDigest !== digestOf(call.output)) {
            throw new Error('Raw output digest mismatch');
          }

          if (native) checkNativeCall(call, arm, native);
          if (!native && ((!call.invoked && (call.status !== 'budget_exhausted' || call.usage !== null || call.output !== null))
            || (call.status === 'completed' && !call.invoked))) throw new Error('Call invocation/status/usage mismatch');
          const baseRequest = call.stage === 'proposal' && arm !== 'F'
            ? config ? nativeProposalRequest(arm, common, config) : proposalRequest(arm, common, episode.settings)
            : call.stage === 'gate'
              ? config ? nativeReviewRequest('gate', proposal?.state ?? incumbent, episode.gate.map(g => g.input), config)
                : reviewRequest('gate', proposal?.state ?? incumbent, episode.gate.map(g => g.input), episode.settings)
              : config ? nativeReviewRequest('future', effectiveState, cases.map(c => c.input), config)
                : reviewRequest('future', effectiveState, cases.map(c => c.input), episode.settings);
          const expected = native?.evaluation ? { ...baseRequest, evaluation: native.evaluation } : baseRequest;
          if (digestOf(call.request) !== call.requestDigest || digestOf(call.request) !== digestOf(expected)) throw new Error('Request settings/context identity mismatch');
        }
        const call = a.calls.find(c => c.stage === 'future')!;
        observed = observations(cases.map(c => c.input), call.output, call.status === 'completed' ? null
          : call.status === 'budget_exhausted' ? 'not_run_budget_exhausted' : call.status);
        if (digestOf(observed) !== digestOf(a.future)) throw new Error('Paired future observation mismatch');
      }
      if (observed.length !== cases.length || new Set(observed.map(o => o.targetId)).size !== cases.length
        || observed.some(o => !cases.some(c => c.input.id === o.targetId))) throw new Error('Paired future target identity mismatch');
      // Do not trust cached metrics or paired differences, even if report hash was recomputed.
      const metrics = scoreFuture(cases, observed);
      const costs = a?.calls.filter(c => c.invoked).map(c => c.usage ? UsageSchema.parse(c.usage).costMicros : null);
      const upstream = arm === 'F' ? 0 : episode.diagnosis.provenance.costMicros;
      const costKnown = !native && !!costs && costs.every(c => c !== null) && upstream !== null;
      const lowerBound = (costs ?? []).reduce<number>((s, c) => s + (c ?? 0), 0) + (upstream ?? 0);
      return { arm, metrics, missingReport: !report, standaloneCostMicros: costKnown ? lowerBound : null,
        standaloneCostKnownLowerBound: lowerBound };
    });
    return { id, repository, family, episode: episode.id, repetition: item.repetition, stratum,
      condition: episode.diagnosis.condition, missingReport: !report, arms,
      ...(native ? { blockId: native.block.blockId, scheduleDigest: native.schedule.digest } : {}),
      targetCount: cases.length, unknownReferences: cases.filter(c => ['unknown', 'disputed'].includes(c.label)).length,
      lineages: [...new Set(cases.map(c => c.input.lineageId))] };
  });
  const strata = [...new Set(units.map(u => u.stratum))].sort().map(id => {
    const selected = units.filter(u => u.stratum === id);
    const paired = (['U', 'M'] as const).map(baseline => ({ contrast: `H-${baseline}`,
      metrics: Object.fromEntries(MACRO_METRICS.map(metric => [metric, macroHierarchy(selected.map(u => {
        const h = u.arms.find(a => a.arm === 'H')!.metrics[metric].value;
        const b = u.arms.find(a => a.arm === baseline)!.metrics[metric].value;
        return { ...u, value: u.missingReport || h === null || b === null ? null : h - b };
      }))])) }));
    const armMacros = ARMS.map(arm => ({ arm, metrics: Object.fromEntries(MACRO_METRICS.map(metric => [metric,
      macroHierarchy(selected.map(u => ({ ...u, value: u.missingReport ? null : u.arms.find(a => a.arm === arm)!.metrics[metric].value })))])) }));
    const costs = ARMS.map(arm => {
      const rows = selected.map(u => u.arms.find(a => a.arm === arm)!);
      return { arm, totalStandaloneCostMicros: rows.every(r => r.standaloneCostMicros !== null)
        ? rows.reduce((s, r) => s + r.standaloneCostMicros!, 0) : null,
      knownLowerBound: rows.reduce((s, r) => s + r.standaloneCostKnownLowerBound, 0),
      unknownUnits: rows.filter(r => r.standaloneCostMicros === null).length };
    });
    return { id, condition: selected[0].condition, plannedUnits: selected.length, armMacros, paired, costs,
      uncertainty: { state: 'withheld', interval: null,
        reasons: ['authored-inputs-zero-empirical-episodes', 'no-verified-probability-sampling-or-independent-repository-clusters',
          'no-frozen-confirmatory-inference-plan',
          ...(selected.some(u => u.missingReport) ? ['missing-execution-records'] : []),
          ...(selected.some(u => u.arms.some(a => MACRO_METRICS.some(m => a.metrics[m].value === null))) ? ['zero-required-denominator'] : []),
          ...(selected.some(u => u.unknownReferences > 0) ? ['unresolved-reference-labels-not-covered-by-sampling-interval'] : [])] } };
  });
  const body = { schemaVersion: 1, kind: 'matched-revision-descriptive-macro-report',
    modelExecution: 'not_run', empiricalEpisodes: 0, inference: 'not_estimated',
    plannedUnits: units.length, missingReports: units.filter(u => u.missingReport).length,
    inputIdentities: planned.map(p => ({ packetDigest: p.packet.digest, futureDigest: p.future.digest,
      repetition: p.repetition, reportDigest: p.report?.digest ?? null })), units, strata,
    boundaries: ['Repository hierarchy is a declared descriptive extension of the single-repository protocol',
      'No IID finding/anchor/seed assumption; report strata are never pooled',
      'Complete-case numbers do not replace full-roster nulls; missing-report administrative scores never enter macros',
      planned.some(p => p.native) ? 'Native repetition IDs bind the declared schedule, not independent execution'
        : 'Legacy repetition IDs are caller declarations, not native schedule or execution attestations',
      'Costs are standalone per arm; never sum them as physical shared-diagnosis billing',
      'Observed labels and usage remain declarations; hashes do not attest their truth'] };
  return { ...body, digest: digestOf(body) };
}

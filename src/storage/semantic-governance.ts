import { digestOf } from '../core/identity.js';
import { DigestSchema, IdSchema } from '../core/model.js';
import { matchesRuleScope, type StoredRuleVersion } from '../core/semantic-rule.js';
import type { StoredRevisionComparison, StoredRevisionDecision } from '../core/revision-comparison.js';
import {
  GOVERNANCE_LIMITS, SEMANTIC_GOVERNANCE_NAMESPACE, SemanticGovernanceCommandSchema, SemanticGovernanceEventSchema,
  LocalSemanticSelectionInputSchema, semanticGovernanceTrust,
  type SemanticGovernanceCommand, type SemanticGovernanceState, type StoredSemanticGovernanceEvent,
  type LocalSemanticSelection, type LocalSemanticSelectionInput, type SemanticGovernanceBinding,
} from '../core/semantic-governance.js';
import { acceptedGovernanceEvidence, advanceSemanticGovernance, deriveSemanticGovernanceEvent, emptySemanticGovernance,
  governanceFail as fail, semanticGovernanceBinding } from '../semantic-governance.js';
import type { Database, Queryable } from './database.js';

type Readers = {
  rule(tx: Queryable, digest: string): Promise<StoredRuleVersion>;
  decision(tx: Queryable, digest: string): Promise<StoredRevisionDecision>;
  comparison(tx: Queryable, digest: string): Promise<StoredRevisionComparison>;
};
type EventRow = { digest: string; id: string; rule_id: string; sequence: number; previous_digest: string | null; rule_digest: string; payload: unknown };
type HeadRow = { rule_id: string; digest: string; sequence: number };

/** Reuses the application's transaction interface and immutable evidence readers.
 * Writes lock one small local table; a logical rule has one CAS head even for two-version supersede. */
export class SemanticGovernanceStore {
  constructor(private readonly db: Database, private readonly readers: Readers) {}
  private resources(tx: Queryable) {
    const rules = new Map<string, SemanticGovernanceBinding>();
    const decisions = new Map<string, StoredRevisionDecision>(), comparisons = new Map<string, StoredRevisionComparison>();
    let bytes = 0;
    const count = (value: unknown) => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > GOVERNANCE_LIMITS.bytes) fail('GOVERNANCE_LIMIT', 'Governance evidence exceeds the 16MB bounded read budget');
    };
    const binding = async (digest: string, scopeDigest?: string) => {
      let result = rules.get(digest);
      if (!result) { const stored = await this.readers.rule(tx, digest); count(stored); result = semanticGovernanceBinding(stored); rules.set(digest, result); }
      if (scopeDigest !== undefined && result.scopeDigest !== scopeDigest) fail('GOVERNANCE_SCOPE_MISMATCH', 'Command scope digest must match the exact immutable version scope');
      return result;
    };
    const evidence = async (digest: string, target: SemanticGovernanceBinding, base?: string) => {
      let decision = decisions.get(digest);
      if (!decision) { decision = await this.readers.decision(tx, digest); count(decision); decisions.set(digest, decision); }
      let comparison = comparisons.get(decision.decision.comparisonDigest);
      if (!comparison) { comparison = await this.readers.comparison(tx, decision.decision.comparisonDigest); count(comparison); comparisons.set(comparison.digest, comparison); }
      return acceptedGovernanceEvidence(decision, comparison, target, base);
    };
    return { count, binding, evidence };
  }
  private async derive(command: SemanticGovernanceCommand, state: SemanticGovernanceState, resources: ReturnType<SemanticGovernanceStore['resources']>) {
    const binding = await resources.binding(command.ruleDigest, command.scopeDigest);
    const successor = command.action === 'supersede' ? await resources.binding(command.successor.ruleDigest, command.successor.scopeDigest) : undefined;
    const evidence = command.action === 'bootstrap-shadow' ? { kind: 'unvalidated-root-bootstrap' as const }
      : command.action === 'select-shadow' ? await resources.evidence(command.decisionDigest, binding)
      : command.action === 'supersede' ? await resources.evidence(command.decisionDigest, successor!, binding.ruleDigest) : null;
    return deriveSemanticGovernanceEvent(command, state, binding, successor, evidence);
  }
  private async read(tx: Queryable, ruleId: string, resources = this.resources(tx), frozenHead?: string) {
    IdSchema.parse(ruleId);
    if (frozenHead !== undefined) DigestSchema.parse(frozenHead);
    const heads = frozenHead === undefined
      ? (await tx.query<HeadRow>('SELECT * FROM qe_local_semantic_governance_heads WHERE rule_id=$1', [ruleId])).rows
      : (await tx.query<HeadRow>('SELECT rule_id,digest,sequence FROM qe_local_semantic_governance_events WHERE rule_id=$1 AND digest=$2', [ruleId, frozenHead])).rows;
    if (frozenHead !== undefined && !heads.length) fail('INTEGRITY_FAILURE', 'Frozen governance head is absent from immutable history');
    const rows = (await tx.query<EventRow>('SELECT * FROM qe_local_semantic_governance_events WHERE rule_id=$1 AND ($2::integer IS NULL OR sequence <= $2) ORDER BY sequence LIMIT 251',
      [ruleId, frozenHead === undefined ? null : heads[0].sequence])).rows;
    if (rows.length > GOVERNANCE_LIMITS.events) fail('GOVERNANCE_LIMIT', 'Governance history exceeds 250 events');
    const head = heads[0];
    if ((!head && rows.length) || (head && (!rows.length || head.sequence !== rows.length))) fail('INTEGRITY_FAILURE', 'Governance head and append-only event sequence differ');
    let state = emptySemanticGovernance(ruleId);
    const history: StoredSemanticGovernanceEvent[] = [];
    for (const row of rows) {
      resources.count(row.payload);
      const event = SemanticGovernanceEventSchema.parse(row.payload);
      if (row.digest !== digestOf(event) || row.id !== event.command.id || row.rule_id !== event.ruleId || event.ruleId !== ruleId
        || row.sequence !== event.sequence || event.sequence !== state.sequence + 1 || row.previous_digest !== event.previousEventDigest
        || event.previousEventDigest !== state.headDigest || row.rule_digest !== event.command.ruleDigest) fail('INTEGRITY_FAILURE', 'Governance event hash, identity or chain mismatch');
      const derived = await this.derive(event.command, state, resources);
      if (digestOf(derived) !== row.digest) fail('INTEGRITY_FAILURE', 'Governance event differs from its pinned evidence or derived transition');
      state = advanceSemanticGovernance(state, event, row.digest); history.push({ digest: row.digest, event });
    }
    if (head && (head.digest !== state.headDigest || head.sequence !== state.sequence)) fail('INTEGRITY_FAILURE', 'Governance head digest differs from validated history');
    return { state, history };
  }
  async apply(input: SemanticGovernanceCommand): Promise<StoredSemanticGovernanceEvent> {
    const command = SemanticGovernanceCommandSchema.parse(input);
    return this.db.transaction(async tx => {
      // This PostgreSQL lock serializes absent-head creation as well as same-ID retries.
      // PGlite serializes transactions already; both backends also exercise the explicit CAS below.
      await tx.query('LOCK TABLE qe_local_semantic_governance_heads IN SHARE ROW EXCLUSIVE MODE');
      const resources = this.resources(tx), binding = await resources.binding(command.ruleDigest, command.scopeDigest);
      const previous = (await tx.query<EventRow>('SELECT * FROM qe_local_semantic_governance_events WHERE id=$1', [command.id])).rows[0];
      if (previous) {
        if (digestOf(SemanticGovernanceEventSchema.parse(previous.payload).command) !== digestOf(command)) fail('IMMUTABLE_CONFLICT', 'Governance command ID already has different immutable content');
        const { history } = await this.read(tx, previous.rule_id, resources);
        return history.find(value => value.digest === previous.digest) ?? fail('INTEGRITY_FAILURE', 'Idempotent governance event is not in its current validated history');
      }
      const { state } = await this.read(tx, binding.ruleId, resources);
      if (command.expectedHeadDigest !== state.headDigest) fail('STALE_GOVERNANCE_HEAD', 'Local governance changed; inspect its current head before submitting another command');
      if (state.headDigest === null) {
        const heads = (await tx.query('SELECT rule_id FROM qe_local_semantic_governance_heads LIMIT 100')).rows;
        if (heads.length >= GOVERNANCE_LIMITS.rules) fail('GOVERNANCE_LIMIT', 'Local governance is limited to 100 logical rules; no new stream was created');
      }
      const event = await this.derive(command, state, resources), digest = digestOf(event);
      resources.count(event);
      await tx.query('INSERT INTO qe_local_semantic_governance_events(digest,id,rule_id,sequence,previous_digest,rule_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [digest, command.id, event.ruleId, event.sequence, event.previousEventDigest, command.ruleDigest, JSON.stringify(event)]);
      const result = state.headDigest === null
        ? await tx.query('INSERT INTO qe_local_semantic_governance_heads(rule_id,digest,sequence) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING rule_id', [event.ruleId, digest, event.sequence])
        : await tx.query('UPDATE qe_local_semantic_governance_heads SET digest=$2,sequence=$3 WHERE rule_id=$1 AND digest=$4 AND sequence=$5 RETURNING rule_id', [event.ruleId, digest, event.sequence, state.headDigest, state.sequence]);
      if (result.rows.length !== 1) fail('STALE_GOVERNANCE_HEAD', 'Local governance CAS failed; no event or partial replacement was committed');
      return { digest, event };
    });
  }
  async get(ruleId: string): Promise<SemanticGovernanceState> {
    return this.db.transaction(async tx => {
      await tx.query('LOCK TABLE qe_local_semantic_governance_heads IN SHARE MODE');
      return (await this.read(tx, ruleId)).state;
    });
  }
  async history(ruleId: string): Promise<StoredSemanticGovernanceEvent[]> {
    return this.db.transaction(async tx => {
      await tx.query('LOCK TABLE qe_local_semantic_governance_heads IN SHARE MODE');
      return (await this.read(tx, ruleId)).history;
    });
  }
  async select(input: LocalSemanticSelectionInput): Promise<LocalSemanticSelection> {
    return this.db.transaction(tx => this.selectInTransaction(tx, input));
  }
  /** Caller owns the transaction; the shared table lock freezes the complete registry. */
  async selectInTransaction(tx: Queryable, input: LocalSemanticSelectionInput): Promise<LocalSemanticSelection> {
    const options = LocalSemanticSelectionInputSchema.parse(input);
    await tx.query('LOCK TABLE qe_local_semantic_governance_heads IN SHARE MODE');
    const orphan = await tx.query('SELECT 1 FROM qe_local_semantic_governance_events e WHERE NOT EXISTS (SELECT 1 FROM qe_local_semantic_governance_heads h WHERE h.rule_id=e.rule_id) LIMIT 1');
    if (orphan.rows.length) fail('INTEGRITY_FAILURE', 'A governance event stream is missing its mutable head; selection cannot safely omit it');
    const heads = (await tx.query<HeadRow>('SELECT * FROM qe_local_semantic_governance_heads ORDER BY rule_id COLLATE "C" LIMIT 101')).rows;
    if (heads.length > GOVERNANCE_LIMITS.rules) fail('GOVERNANCE_LIMIT', 'Selection is limited to 100 governed logical rules; no partial selection was returned');
    const resources = this.resources(tx), states: SemanticGovernanceState[] = [];
    for (const head of heads) states.push((await this.read(tx, head.rule_id, resources)).state);
    return this.selection(options, states);
  }
  /** Replay exactly the recorded heads, not today's eligibility. No current-state claim. */
  async historicalSelection(tx: Queryable, input: LocalSemanticSelectionInput, heads: { ruleId: string; headDigest: string }[]): Promise<LocalSemanticSelection> {
    await tx.query('LOCK TABLE qe_local_semantic_governance_heads IN SHARE MODE');
    const resources = this.resources(tx), states: SemanticGovernanceState[] = [];
    if (heads.length > GOVERNANCE_LIMITS.rules || new Set(heads.map(head => head.ruleId)).size !== heads.length)
      fail('INTEGRITY_FAILURE', 'Invalid frozen governance heads');
    for (const head of heads) {
      states.push((await this.read(tx, head.ruleId, resources, head.headDigest)).state);
    }
    return this.selection(LocalSemanticSelectionInputSchema.parse(input), states);
  }
  private selection(options: LocalSemanticSelectionInput, states: SemanticGovernanceState[]): LocalSemanticSelection {
    const selected: LocalSemanticSelection['selected'] = [], excluded: LocalSemanticSelection['excluded'] = [];
    for (const state of states) {
      DigestSchema.parse(state.headDigest);
      for (const version of state.versions) {
        const entry = { ...version, headDigest: state.headDigest! };
        if (version.status !== 'local-shadow') excluded.push({ ...entry, reason: version.status });
        else if (!options.paths.some(path => matchesRuleScope(version.scope, options.repository, path))) excluded.push({ ...entry, reason: 'out_of_scope' });
        else selected.push(entry);
      }
    }
    return { namespace: SEMANTIC_GOVERNANCE_NAMESPACE, ...options, selected, excluded, trust: semanticGovernanceTrust };
  }
}

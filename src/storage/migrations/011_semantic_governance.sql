-- Separate opt-in local review eligibility. These tables never populate qe_active_rules.
CREATE TABLE IF NOT EXISTS qe_local_semantic_governance_events (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE, rule_id text NOT NULL,
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 250),
  previous_digest text REFERENCES qe_local_semantic_governance_events(digest),
  rule_digest text NOT NULL REFERENCES qe_rule_bundles(digest),
  payload jsonb NOT NULL,
  UNIQUE(rule_id, sequence), UNIQUE(rule_id, digest, sequence)
);
CREATE TABLE IF NOT EXISTS qe_local_semantic_governance_heads (
  rule_id text PRIMARY KEY, digest text NOT NULL, sequence integer NOT NULL,
  FOREIGN KEY(rule_id, digest, sequence) REFERENCES qe_local_semantic_governance_events(rule_id, digest, sequence)
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_local_semantic_governance_events_immutable') THEN
    CREATE TRIGGER qe_local_semantic_governance_events_immutable BEFORE UPDATE OR DELETE ON qe_local_semantic_governance_events
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

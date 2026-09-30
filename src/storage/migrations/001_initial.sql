CREATE TABLE IF NOT EXISTS qe_rule_bundles (
  digest text PRIMARY KEY, rule_id text NOT NULL, version text NOT NULL, payload jsonb NOT NULL,
  UNIQUE(rule_id, version), UNIQUE(digest, rule_id, version)
);
CREATE TABLE IF NOT EXISTS qe_case_lineages (
  id text PRIMARY KEY, split text NOT NULL CHECK(split IN ('training','validation','holdout')),
  UNIQUE(id, split)
);
CREATE TABLE IF NOT EXISTS qe_source_splits (
  digest text PRIMARY KEY, split text NOT NULL CHECK(split IN ('training','validation','holdout')),
  UNIQUE(digest, split)
);
CREATE TABLE IF NOT EXISTS qe_problem_cases (
  id text PRIMARY KEY, lineage_id text NOT NULL, source_digest text NOT NULL, split text NOT NULL,
  payload_digest text NOT NULL, payload jsonb NOT NULL,
  FOREIGN KEY(lineage_id, split) REFERENCES qe_case_lineages(id, split),
  FOREIGN KEY(source_digest, split) REFERENCES qe_source_splits(digest, split)
);
CREATE TABLE IF NOT EXISTS qe_runs (
  id text PRIMARY KEY, run_key text NOT NULL UNIQUE,
  bundle_digest text NOT NULL REFERENCES qe_rule_bundles(digest), payload jsonb NOT NULL,
  UNIQUE(id, bundle_digest)
);
CREATE TABLE IF NOT EXISTS qe_findings (
  id text PRIMARY KEY, run_id text NOT NULL, bundle_digest text NOT NULL,
  rule_id text NOT NULL, rule_version text NOT NULL, payload_digest text NOT NULL, payload jsonb NOT NULL,
  UNIQUE(id, bundle_digest, rule_version),
  FOREIGN KEY(run_id, bundle_digest) REFERENCES qe_runs(id, bundle_digest),
  FOREIGN KEY(bundle_digest, rule_id, rule_version) REFERENCES qe_rule_bundles(digest, rule_id, version)
);
CREATE TABLE IF NOT EXISTS qe_feedback (
  id text PRIMARY KEY, finding_id text NOT NULL, bundle_digest text NOT NULL, rule_version text NOT NULL,
  payload_digest text NOT NULL, payload jsonb NOT NULL,
  FOREIGN KEY(finding_id, bundle_digest, rule_version) REFERENCES qe_findings(id, bundle_digest, rule_version)
);
CREATE TABLE IF NOT EXISTS qe_evaluations (
  id text PRIMARY KEY, bundle_digest text NOT NULL REFERENCES qe_rule_bundles(digest),
  payload_digest text NOT NULL, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS qe_proposals (
  id text PRIMARY KEY, rule_id text NOT NULL, bundle_digest text NOT NULL REFERENCES qe_rule_bundles(digest),
  evaluation_id text NOT NULL REFERENCES qe_evaluations(id), payload_digest text NOT NULL,
  evidence_digest text NOT NULL, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS qe_active_rules (
  rule_id text PRIMARY KEY, bundle_digest text NOT NULL REFERENCES qe_rule_bundles(digest)
);
CREATE TABLE IF NOT EXISTS qe_promotions (
  proposal_id text PRIMARY KEY REFERENCES qe_proposals(id),
  actor text NOT NULL, bundle_digest text NOT NULL REFERENCES qe_rule_bundles(digest),
  previous_digest text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE OR REPLACE FUNCTION qe_reject_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FlyReWheel evidence is append-only: %', TG_TABLE_NAME; END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['qe_rule_bundles','qe_case_lineages','qe_source_splits','qe_problem_cases','qe_runs','qe_findings','qe_feedback','qe_evaluations','qe_proposals','qe_promotions'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = name || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation()', name || '_immutable', name);
    END IF;
  END LOOP;
END $$;

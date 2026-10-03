CREATE TABLE IF NOT EXISTS qe_rule_revision_comparisons (
  digest text PRIMARY KEY, id text NOT NULL UNIQUE,
  request_digest text NOT NULL REFERENCES qe_rule_revision_requests(digest),
  candidate_rule_digest text NOT NULL REFERENCES qe_rule_bundles(digest), payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS qe_rule_revision_decisions (
  digest text PRIMARY KEY, id text NOT NULL UNIQUE,
  comparison_digest text NOT NULL REFERENCES qe_rule_revision_comparisons(digest), payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_rule_revision_comparisons_by_request ON qe_rule_revision_comparisons(request_digest, digest);
CREATE INDEX IF NOT EXISTS qe_rule_revision_decisions_by_comparison ON qe_rule_revision_decisions(comparison_digest, digest);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['qe_rule_revision_comparisons','qe_rule_revision_decisions'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = name || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation()', name || '_immutable', name);
    END IF;
  END LOOP;
END $$;

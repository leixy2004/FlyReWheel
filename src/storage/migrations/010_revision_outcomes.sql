-- Completed revision diagnoses may require no rule mutation. Preserve their
-- immutable execution evidence without manufacturing a rule version.
CREATE TABLE IF NOT EXISTS qe_revision_outcomes (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE,
  request_digest text NOT NULL REFERENCES qe_rule_revision_requests(digest),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_revision_outcomes_by_request ON qe_revision_outcomes(request_digest, digest);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_revision_outcomes_immutable') THEN
    CREATE TRIGGER qe_revision_outcomes_immutable BEFORE UPDATE OR DELETE ON qe_revision_outcomes
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

-- Generated proposals reuse immutable request, feedback, case and rule registries.
CREATE TABLE IF NOT EXISTS qe_revision_candidates (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE,
  request_digest text NOT NULL REFERENCES qe_rule_revision_requests(digest),
  rule_digest text NOT NULL REFERENCES qe_rule_bundles(digest),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_revision_candidates_by_request ON qe_revision_candidates(request_digest, digest);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_revision_candidates_immutable') THEN
    CREATE TRIGGER qe_revision_candidates_immutable BEFORE UPDATE OR DELETE ON qe_revision_candidates
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

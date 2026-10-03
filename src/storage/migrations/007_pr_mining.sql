-- Request provenance and candidate links only: cases/rules retain their existing registries.
CREATE TABLE IF NOT EXISTS qe_pr_mining_requests (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE,
  evidence_digest text NOT NULL REFERENCES qe_github_pr_evidence(digest),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_pr_mining_requests_by_evidence ON qe_pr_mining_requests(evidence_digest, digest);
CREATE TABLE IF NOT EXISTS qe_pr_mining_candidates (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE,
  request_digest text NOT NULL REFERENCES qe_pr_mining_requests(digest),
  rule_digest text NOT NULL REFERENCES qe_rule_bundles(digest),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_pr_mining_candidates_by_request ON qe_pr_mining_candidates(request_digest, digest);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['qe_pr_mining_requests','qe_pr_mining_candidates'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = name || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation()', name || '_immutable', name);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS qe_semantic_reviews (
  id text PRIMARY KEY,
  rule_digest text NOT NULL REFERENCES qe_rule_bundles(digest),
  snapshot_digest text NOT NULL REFERENCES qe_change_snapshots(digest),
  payload_digest text NOT NULL, payload jsonb NOT NULL,
  UNIQUE(id, rule_digest, snapshot_digest)
);
CREATE TABLE IF NOT EXISTS qe_semantic_review_findings (
  id text PRIMARY KEY, review_id text NOT NULL, rule_digest text NOT NULL, snapshot_digest text NOT NULL,
  rule_id text NOT NULL, rule_version text NOT NULL, payload_digest text NOT NULL, payload jsonb NOT NULL,
  UNIQUE(id, review_id, rule_digest, rule_version),
  FOREIGN KEY(review_id, rule_digest, snapshot_digest) REFERENCES qe_semantic_reviews(id, rule_digest, snapshot_digest),
  FOREIGN KEY(rule_digest, rule_id, rule_version) REFERENCES qe_rule_bundles(digest, rule_id, version)
);
CREATE TABLE IF NOT EXISTS qe_semantic_review_feedback (
  id text PRIMARY KEY, finding_id text NOT NULL, review_id text NOT NULL, rule_digest text NOT NULL,
  rule_version text NOT NULL, payload_digest text NOT NULL, payload jsonb NOT NULL,
  FOREIGN KEY(finding_id, review_id, rule_digest, rule_version) REFERENCES qe_semantic_review_findings(id, review_id, rule_digest, rule_version)
);
CREATE TABLE IF NOT EXISTS qe_rule_revision_requests (
  digest text PRIMARY KEY, id text NOT NULL UNIQUE,
  base_rule_digest text NOT NULL REFERENCES qe_rule_bundles(digest), payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_semantic_reviews_by_rule ON qe_semantic_reviews(rule_digest, id);
CREATE INDEX IF NOT EXISTS qe_semantic_reviews_by_snapshot ON qe_semantic_reviews(snapshot_digest, id);
CREATE INDEX IF NOT EXISTS qe_semantic_review_findings_by_review ON qe_semantic_review_findings(review_id, id);
CREATE INDEX IF NOT EXISTS qe_semantic_review_feedback_by_finding ON qe_semantic_review_feedback(finding_id, id);
CREATE INDEX IF NOT EXISTS qe_rule_revision_requests_by_base ON qe_rule_revision_requests(base_rule_digest, digest);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['qe_semantic_reviews','qe_semantic_review_findings','qe_semantic_review_feedback','qe_rule_revision_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = name || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation()', name || '_immutable', name);
    END IF;
  END LOOP;
END $$;

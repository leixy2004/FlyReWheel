CREATE TABLE IF NOT EXISTS qe_github_pr_evidence (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  snapshot_digest text NOT NULL REFERENCES qe_change_snapshots(digest),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_github_pr_evidence_by_snapshot ON qe_github_pr_evidence(snapshot_digest, digest);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_github_pr_evidence_immutable') THEN
    CREATE TRIGGER qe_github_pr_evidence_immutable BEFORE UPDATE OR DELETE ON qe_github_pr_evidence
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

-- Local bounded progress, not a scheduler or queue. Discovery identity is immutable;
-- progress revisions use compare-and-swap to reject concurrent batch operators.
CREATE TABLE IF NOT EXISTS qe_github_pr_history (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  repository text NOT NULL,
  plan jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
  items jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qe_github_pr_history_repository ON qe_github_pr_history(repository,digest);
CREATE OR REPLACE FUNCTION qe_history_plan_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.digest IS DISTINCT FROM OLD.digest OR NEW.repository IS DISTINCT FROM OLD.repository OR NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'History plan identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_github_pr_history_identity') THEN
    CREATE TRIGGER qe_github_pr_history_identity BEFORE UPDATE ON qe_github_pr_history
      FOR EACH ROW EXECUTE FUNCTION qe_history_plan_immutable();
  END IF;
END $$;

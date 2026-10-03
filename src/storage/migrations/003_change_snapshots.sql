CREATE TABLE IF NOT EXISTS qe_change_snapshots (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  repository_id text NOT NULL,
  payload jsonb NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_change_snapshots_immutable') THEN
    CREATE TRIGGER qe_change_snapshots_immutable BEFORE UPDATE OR DELETE ON qe_change_snapshots
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

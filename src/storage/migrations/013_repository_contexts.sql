CREATE TABLE IF NOT EXISTS qe_repository_contexts (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  repository_id text NOT NULL,
  head_sha text NOT NULL CHECK(head_sha ~ '^[a-f0-9]{40}$'),
  payload jsonb NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_repository_contexts_immutable') THEN
    CREATE TRIGGER qe_repository_contexts_immutable BEFORE UPDATE OR DELETE ON qe_repository_contexts
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

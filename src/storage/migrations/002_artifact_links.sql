CREATE TABLE IF NOT EXISTS qe_artifact_links (
  evaluation_id text NOT NULL REFERENCES qe_evaluations(id),
  kind text NOT NULL CHECK(kind IN ('input', 'result')),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL CHECK(object_key = 'sha256/' || digest),
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0 AND size_bytes <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(evaluation_id, kind)
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_artifact_links_immutable') THEN
    CREATE TRIGGER qe_artifact_links_immutable BEFORE UPDATE OR DELETE ON qe_artifact_links
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

-- Frozen local selection manifests and per-claim admissions. Never production activation.
CREATE TABLE IF NOT EXISTS qe_governed_review_plans (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE, input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS qe_governed_review_admissions (
  job_digest text NOT NULL REFERENCES qe_application_jobs(job_digest),
  attempt integer NOT NULL CHECK(attempt >= 1),
  plan_digest text NOT NULL REFERENCES qe_governed_review_plans(digest),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'), payload jsonb NOT NULL,
  PRIMARY KEY(job_digest, attempt)
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_governed_review_plans_immutable') THEN
    CREATE TRIGGER qe_governed_review_plans_immutable BEFORE UPDATE OR DELETE ON qe_governed_review_plans
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_governed_review_admissions_immutable') THEN
    CREATE TRIGGER qe_governed_review_admissions_immutable BEFORE UPDATE OR DELETE ON qe_governed_review_admissions
      FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
  END IF;
END $$;

-- Durable application-job claims and outcomes. Domain records and a terminal
-- outcome are committed together; no model execution runs in this transaction.
CREATE TABLE IF NOT EXISTS qe_application_jobs (
  job_digest text PRIMARY KEY CHECK(job_digest ~ '^[a-f0-9]{64}$'),
  job_payload jsonb NOT NULL,
  job_payload_digest text NOT NULL CHECK(job_payload_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('running', 'retryable', 'finished')),
  owner uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL CHECK(attempts >= 1),
  result jsonb,
  result_digest text CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  CHECK (
    (state = 'running' AND owner IS NOT NULL AND lease_expires_at IS NOT NULL AND result IS NULL AND result_digest IS NULL)
    OR (state IN ('retryable', 'finished') AND owner IS NULL AND lease_expires_at IS NULL AND result IS NOT NULL AND result_digest IS NOT NULL)
  )
);
CREATE OR REPLACE FUNCTION qe_application_job_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Application job identities and outcomes cannot be deleted';
  END IF;
  IF NEW.job_digest IS DISTINCT FROM OLD.job_digest
    OR NEW.job_payload IS DISTINCT FROM OLD.job_payload
    OR NEW.job_payload_digest IS DISTINCT FROM OLD.job_payload_digest THEN
    RAISE EXCEPTION 'Application job identity is immutable';
  END IF;
  IF OLD.state = 'finished' THEN
    RAISE EXCEPTION 'Finished application job outcomes are immutable';
  END IF;
  IF OLD.state = 'running' AND NEW.state IN ('retryable', 'finished') AND NEW.attempts = OLD.attempts THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'retryable' AND NEW.state = 'running' AND NEW.attempts = OLD.attempts + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid application job state transition';
END;
$$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'qe_application_jobs_transition') THEN
    CREATE TRIGGER qe_application_jobs_transition BEFORE UPDATE OR DELETE ON qe_application_jobs
      FOR EACH ROW EXECUTE FUNCTION qe_application_job_transition();
  END IF;
END $$;

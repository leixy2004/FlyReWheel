-- Preserve each observed result before a later retry clears the current ledger.
-- Old overwritten attempts cannot be recovered. Backfill only an existing result.
CREATE TABLE qe_application_job_attempt_history (
  job_digest text NOT NULL REFERENCES qe_application_jobs(job_digest),
  attempt integer NOT NULL CHECK(attempt >= 1),
  state text NOT NULL CHECK(state IN ('retryable','finished')),
  result jsonb NOT NULL,
  result_digest text NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  origin text NOT NULL CHECK(origin IN ('migration-current-result','recorded-transition')),
  PRIMARY KEY(job_digest,attempt)
);
INSERT INTO qe_application_job_attempt_history(job_digest,attempt,state,result,result_digest,origin)
  SELECT job_digest,attempts,state,result,result_digest,'migration-current-result'
  FROM qe_application_jobs WHERE result IS NOT NULL;
CREATE TRIGGER qe_application_job_attempt_history_immutable BEFORE UPDATE OR DELETE ON qe_application_job_attempt_history
  FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
CREATE FUNCTION qe_record_application_job_attempt() RETURNS trigger AS $$
BEGIN
  IF NEW.result IS NOT NULL THEN
    INSERT INTO qe_application_job_attempt_history(job_digest,attempt,state,result,result_digest,origin)
      VALUES(NEW.job_digest,NEW.attempts,NEW.state,NEW.result,NEW.result_digest,'recorded-transition');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qe_application_job_attempt_result AFTER INSERT OR UPDATE ON qe_application_jobs
  FOR EACH ROW EXECUTE FUNCTION qe_record_application_job_attempt();

-- Authored experiment recovery uses the existing transactional domain-ledger
-- pattern. Claims coordinate drivers, never permit a dispatched slot to retry.
CREATE TABLE qe_matched_studies (
  study_digest text PRIMARY KEY CHECK(study_digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('running','finished')),
  owner uuid,
  fence integer NOT NULL CHECK(fence >= 1),
  lease_expires_at timestamptz,
  result jsonb,
  result_digest text CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  CHECK((state='running' AND owner IS NOT NULL AND lease_expires_at IS NOT NULL AND result IS NULL AND result_digest IS NULL)
    OR (state='finished' AND owner IS NULL AND lease_expires_at IS NULL AND result IS NOT NULL AND result_digest IS NOT NULL))
);
CREATE TABLE qe_matched_study_events (
  study_digest text NOT NULL REFERENCES qe_matched_studies(study_digest),
  block_id text NOT NULL CHECK(block_id ~ '^[a-f0-9]{64}$'),
  event_key text NOT NULL,
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  fence integer NOT NULL CHECK(fence >= 1),
  payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(study_digest,block_id,event_key)
);
CREATE TRIGGER qe_matched_study_events_immutable BEFORE UPDATE OR DELETE ON qe_matched_study_events
  FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();
CREATE FUNCTION qe_matched_study_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Matched study identities cannot be deleted'; END IF;
  IF NEW.study_digest IS DISTINCT FROM OLD.study_digest OR NEW.manifest IS DISTINCT FROM OLD.manifest
    OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest THEN
    RAISE EXCEPTION 'Matched study manifest is immutable';
  END IF;
  IF OLD.state='finished' THEN RAISE EXCEPTION 'Finished matched study results are immutable'; END IF;
  IF NEW.state='finished' AND NEW.fence=OLD.fence THEN RETURN NEW; END IF;
  IF NEW.state='running' AND NEW.owner=OLD.owner AND NEW.fence=OLD.fence THEN RETURN NEW; END IF;
  IF NEW.state='running' AND NEW.owner IS DISTINCT FROM OLD.owner AND NEW.fence=OLD.fence+1
    AND OLD.lease_expires_at <= clock_timestamp() THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Invalid matched study claim transition';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qe_matched_studies_transition BEFORE UPDATE OR DELETE ON qe_matched_studies
  FOR EACH ROW EXECUTE FUNCTION qe_matched_study_transition();

CREATE TABLE qe_review_continuations (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE,
  outcome_digest text NOT NULL REFERENCES qe_revision_outcomes(digest),
  payload jsonb NOT NULL
);
CREATE INDEX qe_review_continuations_outcome ON qe_review_continuations(outcome_digest,digest);
CREATE TRIGGER qe_review_continuations_immutable BEFORE UPDATE OR DELETE ON qe_review_continuations
  FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();

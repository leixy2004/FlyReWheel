CREATE TABLE qe_review_batches (
  digest text PRIMARY KEY CHECK(digest ~ '^[a-f0-9]{64}$'),
  id text NOT NULL UNIQUE,
  payload jsonb NOT NULL
);
CREATE TRIGGER qe_review_batches_immutable BEFORE UPDATE OR DELETE ON qe_review_batches
  FOR EACH ROW EXECUTE FUNCTION qe_reject_mutation();

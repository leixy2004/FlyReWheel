# Independent temporal frame validation

This entry point reuses `scripts/verify-temporal-frame.mjs` from PR #5 checkpoint
`d8c89d85e7e4d5c12fab5028fa6fbf54e6114ae3`. It adds an isolated runner and independent
negative tests, not a second validation policy. The original metadata checkpoint
is `973a9b7cccef1615b7e11ee1b9318965f9131a7f`.

From the repository root, with Node installed:

```sh
node scripts/validate-temporal-frame.mjs
node scripts/validate-temporal-frame.mjs /path/to/candidate-frame.json
npx vitest run tests/temporal-frame-validator.test.ts --maxWorkers=2
```

Use the project's existing installed test dependencies. The validator itself uses
only Node built-ins. It prints JSON on success and exits nonzero on invalid input.
It reads the fixed local collector and canonical verifier, copies them with the
candidate frame into a unique temporary directory, and executes only the verifier.
The collector is hashed, never executed. The child has a 10-second timeout, a 1 MiB
output limit and an empty environment to avoid credential or Node preload
inheritance. Temporary files are removed on completion or error. This is file
isolation for report generation, not a security sandbox for untrusted verifier code.
No API requests, model execution, upstream content reads, or saved readiness report
writes are performed by this path.

The canonical verifier checks fixed identity/windows/query, exact metadata field
allowlists, PR identity, timestamps, commit metadata, page termination/counts,
collector hash and declared evidence limitations. Negative tests mutate synthetic
in-memory copies; they are not human annotations or model outcome data.

The saved frame yields 70 PRs: W0=38, W1=13, W2=19. Its SHA-256 is
`07c1ded10a03002eed7b3f25d75c33e161876d72f71371b4cbfc1652022f477b`.
Successful output explicitly says `evaluationReady: false` and
`independentLabels: 0`. Count agreement establishes internal consistency with the
recorded API audit, not independent upstream enumeration, historical public
visibility, lineage independence or preregistration. Parent totalCount is not
retained, so parent completeness cannot be independently rederived offline.

The inherited verifier conservatively rejects duplicate merge SHAs and empty
parent lists. These are stricter than generic Git/PR metadata requirements and do
not fail this saved frame. A future legitimate collision or root commit needs the
canonical verifier owner's review; do not drop that PR or silently change the
sample to pass validation.

W0 source identity verification is a separate existing artifact, not rerun here.
W1/W2 source and labels remain unopened. Human annotators and adjudicator, lineage
and availability audits, rule freeze, research models and budgets remain separate
gates. Integrity validation neither assigns humans nor releases those gates.

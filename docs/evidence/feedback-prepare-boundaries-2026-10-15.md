# Supplementary feedback prepare boundary acceptance

Verified code HEAD: `8db3f87da89e1de561a956ae9c96ece2cc1d6441`, original branch `codex/explicit-review-continuation`. This evidence-only follow-up does not change product behavior or the shared output writer.

On 2026-10-15, `npm run build` succeeded and the actual compiled CLI was executed in freshly allocated temporary directories. The [reproducible driver](../../scripts/verify-feedback-prepare-boundaries.mjs) creates all output files, symbolic links and PGlite databases itself. No previously existing user file/database was used. The existing synthetic review demo supplied the review/finding; no project model or independent human judgment was involved.

## Measured results

**11 CLI invocations: 4 successful, 7 expected failures.** These are supplementary scenario calls, not a rerun of the prior test suite.

| Scenario | Observed result |
| --- | --- |
| New `--out` file | Exit 0, empty stdout, exact finding/review/rule binding, file mode 0600 |
| Existing isolated output | Exit 0, replaced its previous sentinel content with prepared JSON |
| Isolated symbolic link | Exit 0, link remained a link and its isolated target was overwritten |
| Invalid kind/label combination | Exit 1; existing output sentinel remained unchanged |
| Nonexistent finding | Exit 1; existing output sentinel remained unchanged |
| Output path is a directory | Exit 1 with EISDIR |
| Output parent directory absent | Exit 1 with ENOENT |
| Current database across the output scenarios | Every domain table's row count and content digest unchanged; migration state unchanged |
| New database, invalid label | Exit 1, no output; database nonetheless initialized through migration 018; all 36 domain tables empty |
| New database, nonexistent finding | Exit 1, no output; database nonetheless initialized through migration 018; all 36 domain tables empty |
| Pending-migration database, invalid label | Exit 1, no output; migration 018 nevertheless applied; all pre-existing domain rows/digests preserved; new attempt-history table empty |

The pending-migration fixture was constructed legitimately through migration 017 using copies of the project's existing migration files in a temporary prefix directory. It contained one synthetic `qe_case_lineages` training sentinel. No real database was downgraded or tampered with. Before invocation the migration inspector reported 17 applied / 1 pending; afterward it reported 18 applied / 0 pending. The sentinel survived unchanged.

Raw PGlite inspection bypassed `QualEvoStore.initialize`: schema migration inspection itself did not apply migrations. Before/after domain comparisons used sorted row digests and counts for every public domain table, excluding migration bookkeeping tables. This supports measured domain-record claims, not byte-for-byte database-file immutability; database engines can write their own housekeeping state.

## Interpretation and limits

Preparation is **not strictly database-read-only at the CLI boundary**. Store opening precedes feedback validation and may initialize or migrate storage even when the command later fails. This is the documented common storage lifecycle, not a newly discovered feedback write. No feedback, revision or governance record was created by the tested preparation calls.

The output overwrite and symlink behavior is now observed, rather than inferred solely from `writeFile`. Existing drafts are replaced when explicitly selected as `--out`; callers should choose a fresh output path if they need to preserve an existing draft. No general output policy was changed.

No incorrect association, unexpected domain loss or feedback preparation defect requiring a code repair was found in these scenarios. The following remain **static conclusions or untested boundaries**, not experimental results:

- Shared `writeFile` is non-atomic. A mid-write failure could leave truncated content; this run did not induce disk exhaustion, partial writes or abrupt termination.
- Only PGlite was tested, not PostgreSQL.
- The 017 fixture had no application-job results. Migration 018's intentional backfill for populated job histories was not exercised; the absence of new domain rows here must not be generalized to all pending-migration databases.

The [structured evidence](feedback-prepare-boundaries-2026-10-15.json) includes actual command statuses, errors, scenario results and database migration/domain snapshots. Temporary paths are parameterized. Source blobs, databases and session data are not archived.

Reproduce from the repository root:

```sh
npm run build
node scripts/verify-feedback-prepare-boundaries.mjs
```

The driver prints its newly allocated output directory and writes `verification.json` there. No credentials, login, network/model calls, W1 data, publication or deployment are needed. This follow-up ends with local evidence archival only.

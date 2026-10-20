# Fixed vLLM input compatibility — 2026-10-13

**Result: the exercised import-to-governed-review/export path passed, using real
vLLM source bytes.** There were 28 successful compiled CLI calls, zero failed CLI
calls, and no observed product defect in this bounded path. No production code,
schema or test changes were necessary; this commit records evidence only.

Tested FlyReWheel commit: `665aa5491750cecd62146fb61dafdfe55973af80`.
Runtime: Node `v24.19.0`; fresh local PGlite database. No full test-suite rerun was
performed because the task was this concrete compatibility flow, not a code change.

## Fixed official source

Repository: [vllm-project/vllm](https://github.com/vllm-project/vllm).
The inspected local /workspace and /tmp inventory contained research-named vLLM
files, but no independent checkout was found. Existing research inputs were not
reused; HTTPX W1 and other frozen experiment data were not read.

- Head: [`953d9c820b0d8f9a55ee455814287536a498498c`](https://github.com/vllm-project/vllm/commit/953d9c820b0d8f9a55ee455814287536a498498c)
- Direct parent: `33b06a6f24be632e99c19cadb5004a27cf9605a0`
- Commit date: `2025-11-28T12:40:47Z`
- Subject: `[mypy] Pass type checking for vllm/utils and vllm/v1/pool (#29666)`
- Official reported diff: 9 modified paths, 37 additions, 43 deletions.

The public GitHub commit API, content API at each exact SHA and official `.diff`
were fetched read-only without a GitHub Authorization header. Every downloaded
blob's SHA-1 was recomputed with the Git blob header and matched the content API;
all after-side blob IDs also matched the commit's changed-file list. SHA-256,
length, mode, URL and exact parent/head are recorded for every file version.
All 9 changed paths and both sides were imported: 18 versions / 131,744 bytes,
zero excluded snapshot sides. No vLLM checkout, fake Git commits or manually
reassembled source projection was used.

| Path | Mode | Before / after bytes | Review coverage |
| --- | --- | ---: | --- |
| `tools/pre_commit/mypy.py` | `100755` | 4469 / 4487 | imported; out of rule scope |
| `vllm/utils/async_utils.py` | `100644` | 11061 / 11193 | imported; out of rule scope |
| `vllm/utils/jsontree.py` | `100644` | 3840 / 3755 | imported; out of rule scope |
| `vllm/utils/mem_utils.py` | `100644` | 8834 / 8850 | imported; out of rule scope |
| `vllm/utils/nccl.py` | `100644` | 1927 / 1915 | imported; out of rule scope |
| `vllm/utils/network_utils.py` | `100644` | 10058 / 10076 | reviewed signature |
| `vllm/utils/registry.py` | `100644` | 1504 / 1555 | imported; out of rule scope |
| `vllm/utils/torch_utils.py` | `100644` | 21521 / 21217 | imported; out of rule scope |
| `vllm/v1/pool/metadata.py` | `100644` | 2735 / 2747 | imported; out of rule scope |

`tools/pre_commit/mypy.py` is executable in Git (`100755`); that real mode is
preserved as data. It was not executed. The other files retain `100644`.

## Import boundary

The current native `snapshots capture` implementation requires complete local
history and refuses shallow or partial/promisor repositories
(`src/git-evidence-repository.ts`). A full vLLM history checkout was not obtained,
and native local capture was **not run or certified**. Instead this exercise used
the already supported `snapshots import` path with the authentic fixed-commit
bytes. The persisted receipt remains **`package-integrity-only`**, and repository
identity remains caller-supplied/unverified in the FlyReWheel schema. External
GitHub acquisition provenance does not upgrade that receipt into local Git proof.
The direct-parent metadata supplies the base for this imported parent-to-child
diff; the complete ancestry/tree was not independently reconstructed.

## Actual compiled CLI flow

All persistence, selection, execution and export operations below went through
`node dist/cli.js`, in separate processes, with explicit `--db` selection:

1. Import the real nine-file snapshot; reopen it by its digest.
2. Import a manually authored annotation-inspection rule and one source case bound
   to the actual `network_utils.py` head bytes. The case's safe expectation is an
   authored test declaration, not independently assessed ground truth.
3. Inspect target coverage, explicitly register/bootstrap the local root rule, then
   create and execute an authored-fixture-bound governed baseline plan.
4. Add and discover a fixture FP declaration at the real typed signature. Freeze
   that exact feedback into a revision request.
5. Import a manual candidate clarifying the already-typed-signature exception;
   run its explicitly authored response and compare the exact paired reviews.
6. Record an explicit fixture accept decision; explicitly register the candidate
   and supersede the selected base using that comparison-backed decision.
7. Create and execute the subsequent governed offline plan directly. Verify rule,
   snapshot, fixture and admission bindings; rerun across processes and reuse the
   same completed job with a single recorded attempt.
8. Explain the feedback/version/evaluation/selection chain. Register the exact
   already-executed job in the existing batch catalog for JSON and CSV export;
   verify both exports identify the same governed review and candidate digest.

The rule selects one actual Python signature, `test_loopback_bind`, at the exact
head commit. Eight other changed files are imported but explicitly out of rule
scope. The baseline deliberately uses an authored violation response and the
candidate an authored safe response to exercise feedback and comparison handling.
The compatible comparison has one case observation and one feedback observation
at this same source anchor; they are **not two independent quality measurements**.
Neither result is a claim of a real vLLM bug or a measured rule improvement.

| Artifact | Exact identity |
| --- | --- |
| Snapshot | `079496cb39edaf6b4879d5649669a3f61dedcbd1e79217dd5b35e4421f7a99e2` |
| Candidate rule | `5e63a6a64f2afd33ef563ad05c319620a25a16da1e52281b02f0b2bd1a402789` |
| Comparison | `877b950ee6f1b0510306e431ea8e5842242c617ec1e3d5d5a7a630f831fc7a8c` |
| Follow-up plan | `c70d4803aa928018200188b440db66150ec5bd96d7d323d1cd854b19bf951506` |
| Follow-up review | `review_f158439cb184611fe491031459856334926076f1d59d92f529040275ca9337bb` |
| Export batch | `570e8968d0446ec629462db9817035c71f9cc791ce66f36f678607bb62691482` |

## Evidence and reproduction material

[Exact provenance, commands, hashes and results](evidence/vllm-953d9c8-cli-compatibility-2026-10-13.json)
contains all 28 CLI argument lists, output hashes, all 18 blob identities, public
source URLs, selection/admission identities and export rows.
[Authored inputs](evidence/vllm-953d9c8-authored-inputs.json) preserves the manually
specified rules, responses, feedback, request, comparisons, decisions and plans.
It is input evidence, not a new executable or product feature.

Raw API metadata, official diff, original source byte files, acquisition script,
flow script, all CLI JSON/CSV files and the local database remain under
`/tmp/flyrewheel-vllm-compat`. The exact executed flow script is
`/tmp/flyrewheel-vllm-compat/run.mjs`; the retained flow database is
`/tmp/flyrewheel-vllm-compat/flow/db`. Temporary artifacts are session-local; the
committed provenance and authored input bundle remain independently reviewable.
To reproduce elsewhere, fetch the listed public content URLs at their exact SHAs,
check their Git blob and SHA-256 identities, reconstruct the recorded snapshot
package, write the authored inputs, and invoke the recorded CLI commands against a
fresh database. Do not treat the imported snapshot as a complete checkout.

## Explicit exclusions

- No vLLM Python module was imported or executed; no vLLM tests/build, pip installation, GPU,
  inference or dependency runtime was used.
- No complete repository context, other history, other vLLM releases, or files
  outside these nine changed paths were downloaded as source.
- The rule is detectorless. Python AST detector compatibility is not established
  by this run; it exercises byte anchors, scope, persistence and execution lineage.
- Rule/candidate text, semantic responses, feedback and decisions are authored.
  There are no real model calls, substitute runtime receipts, genuine developer
  correctness judgments, automatically mined rules or quality conclusions.
- No credential files/values were read or supplied, no W1/frozen protocol data was
  touched, and nothing was pushed, deployed, published or commented externally.

This confirms compatibility for the fixed input and exercised existing CLI path;
it is neither full vLLM integration nor production runtime certification.

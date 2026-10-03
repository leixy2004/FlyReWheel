# Pilot boundaries: two source-bound local reproductions

**Developmental author analysis, 2026-10-02, baseline `4d87dda`.** Both narrow mechanisms now have executed local evidence: #9034's zero-token suffix returns cached prompt/output before the fix, and #2570's unguarded comparison raises on `None`. The evidence also limits the claims: the zero guard does not validate offsets or cache consistency, and the optional guard does not enforce integer types.

This supplements, rather than rewrites, the earlier [static case cards](pilot-case-cards.md). It uses the same two already-inspected PRs and the same [materials manifest](pilot-materials-manifest.json). Author-written input variations are not independent PRs, independent labels, formal benchmark cases, recurrence, rule-maintenance episodes, or evidence of model benefit. Research labels remain unknown.

## Reproduce and verify

- [Stdlib-only script](reproduce-pilot-boundaries.py)
- [Machine results and complete input/expectation rows](pilot-boundary-results.json)
- [Byte-identical rerun, source-binding, and report-link verification](pilot-boundary-verification.json)

From the repository root:

```sh
python -I paper/reproduce-pilot-boundaries.py > paper/pilot-boundary-results.json
python -I paper/reproduce-pilot-boundaries.py --verify > paper/pilot-boundary-verification.json
```

The first command executes only reviewed, authored method literals. It reads upstream modules as data, checks the manifest's pinned SHA-256, and rechecks 14 source, test, metadata, and license records using byte length and SHA-256, plus Git blob SHA-1 where recorded. Before execution, each of 16 method bindings must match the source's exact line text after dedenting and its AST after the stated adaptations. Commits are the recorded squash-parent/merge pair, not reconstructed review checkpoints. These local checks do not reauthenticate upstream history.

The second command runs two isolated subprocesses and requires both JSON outputs and the saved results to be byte-identical. It rechecks all 16 method/source bindings, the 14 material records, and local report links/line ranges and JSON pointers, and records script, results, report, and manifest hashes. In a temporary minimal copy it also verifies an identical baseline, then confirms that separate manifest, source-file, and authored-method mutations each fail closed before method execution. Repository materials are untouched. External URLs are not fetched. Runtime version is in the results; the final verification records the exact delivered bytes.

### Executed units and explicit adaptations

**#9034:** Exact `Sequence.get_output_token_ids_to_return` at [before lines 516–535](../experiments/vllm/fixtures/pr-9034/before/vllm/sequence.py#L516-L535) and [after lines 516–538](../experiments/vllm/fixtures/pr-9034/after/vllm/sequence.py#L516-L538). Six unchanged helpers reproduce cache construction and getter forwarding from each source side. The cache constructor uses the source's `list(prompt_array + output_array)` body; it therefore contains prompt and output tokens. Authored adapter classes initialize `array('l')` fields and the chosen offset; upstream `Sequence`/`SequenceData` constructors and lifecycle are not run. Only class indentation is removed; the getter's `property` decorator is reapplied on the adapter. Dedenting changes whitespace inside the main method's docstring, whose cleaned text is checked; executable statements, signatures, and annotations are unchanged. Raw method, adapted text, and original body AST hashes are retained.

**#2570:** Exact complete `_verify_args`, [before](../experiments/vllm/fixtures/pr-2570/before/vllm/sampling_params.py#L160-L194) and [after](../experiments/vllm/fixtures/pr-2570/after/vllm/sampling_params.py#L160-L194), runs on an authored `SimpleNamespace`. Constructor defaults, assignments, verifier call, and the `int` → `Optional[int]` annotation are statically checked. Fields use those defaults plus explicit per-input overrides, including the source's `best_of` default resolution. No upstream constructor or subsequent beam/greedy validation runs. Only class indentation is removed. A third variant is explicitly **author-created**, replacing the `is not None` condition with a truthiness condition; it is not a historical revision.

## Observations and boundaries

There are **35 authored snapshot inputs and one repeated-call scenario**: #9034 has 18 snapshots (12 contract-domain states, 6 deliberately unsupported states) and a two-call scenario; #2570 has 17 snapshots, including 8 unsupported-type probes. All **91 primary method invocations** match predeclared author expectations: 74 source-bound before/after calls and 17 counterfactual calls. Helper invocations are not included. A “passed” check means the observed outcome matches the expectation, including expected pre-fix failures; it does not mean the old method satisfies the corrected contract.

Expected return values/types and error categories are literal rows, not comparisons only against the other variant. Checks also assert offset transitions, unchanged token/cache contents, and unchanged validation state. `ValueError` messages are checked exactly; `TypeError`/`IndexError` types are checked and their observed messages retained. List, tuple, and scalar returns have separate type tags in JSON.

### #9034: zero guard works within the delta contract

| Input/state | Before | After |
| --- | --- | --- |
| Prompt `[10,11]`, no output, delta, offset 0 | `[10,11]` | `[]` |
| Prompt `[10,11]`, output `[20,21,22]`, delta, offset 3 | Entire prompt/output cache | `[]` |
| One new output token | Scalar last token | Same |
| Two or three new output tokens | Correct output suffix | Same |
| Non-delta call | Tuple of all output IDs, offset unchanged | Same |
| Repeated delta call with no append | First returns scalar 20; second returns `[10,11,20]` | First returns scalar 20; second returns `[]` |

The empty-cache/zero-token input returns `[]` on **both** sides and by itself would miss the bug. Within the 12 contract-domain snapshots, three change; the fourth changed snapshot deliberately injects a stale cache. Suffix slicing with a positive new-token count remains a legal neighbor: banning all such suffix slices would reject working cases.

**Negative findings:** with output `[20,21]` and offset 3, both sides return `[11,20,21]`, leaking a prompt token under an unsupported offset-ahead state. Negative offsets likewise can include prompt data. A too-short cache returns too little; an empty cache with one new token still raises `IndexError`. The zero guard does not establish `0 <= offset <= output_len`, cache consistency, or callers' append-only lifecycle. These probes do not establish that such states are reachable in vLLM.

Full rows: JSON `/vllm_pr_9034/input_rows` and `/vllm_pr_9034/repeated_delta_call`.

### #2570: sentinel permission is not truthiness or type enforcement

- `None` reaches `TypeError` before and returns normally after, both with default fields and with the [retained direct test's parameters](../experiments/vllm/evidence/pr-2570/after/tests/test_sampling_params.py#L6-L8). That test file is byte-checked, **not executed**
- `-1` and `0` still raise `ValueError`; `1` and `16` still return normally
- The authored truthy-guard variant wrongly admits zero. It also admits unsupported falsey probes `0.0`, `False`, and `[]`
- Earlier `n=0` validation still fails before reaching the optional guard. After the fix, `None` with `logprobs=-1` reaches the later `ValueError`; bypassing this comparison does not bypass subsequent checks
- **Negative finding:** the actual before/after method accepts `1.5` and `True` locally. The annotation change is not a runtime integer check. Strings and empty lists still raise `TypeError` after the fix; these unsupported probes do not define API permission

Full rows: JSON `/vllm_pr_2570/input_rows`. Local `_verify_args` acceptance does not prove complete constructor acceptance, generation success, or an “unlimited generation” interpretation of `None`.

## What remains unverified

No vLLM imports, whole-repository execution, upstream tests, dependency installation, model/server calls, networking, authentication changes, or product-code edits were used. The serving changes accompanying #9034 and the model-based generation test accompanying #2570 remain unexecuted. **#2664 remains static**: no mocked actor result is presented as Ray execution. The next stronger runtime claim would need its actual version-bound actor context.

These results support a narrow local mechanism and boundary explanation. They neither supply missing historical feedback/checkpoints and independent later targets nor establish that repository memory or sophisticated learning is necessary: #2570 remains a weak/control case, and #9034's immediate defect remains generic Python `-0` slicing with a repository-specific delta/cache contract.

# Existing evaluator notes: author-created, not independent labels

These notes summarize already-saved developmental analyses and bounded reproductions. This packet does not rerun them. Their authored inputs/expectations are not independent PRs, human labels, future recurrence, or a model-effect experiment. Full results are under `reproduction/`; their scope/adaptation fields take priority over a loose interpretation of “passed.” Exact report identities are in the coordinator's audit.

## A

The saved local reproduction evaluates the captured validator function on ordinary dictionaries: 35 authored inputs across four source/counterfactual variants, with 140 expected-outcome checks. It does not import vLLM, run the complete Pydantic request model, or execute the upstream tests. See `reproduction/vllm-8568-behavior-results.json`, especially `/scope`, `/summary`, `/cases`, and `/review_hunk_binding`.

For missing `tool_choice`, the earlier function defaults to `auto` when a `tools` key exists. With `tools=None` it then raises; with `tools=[]` it does not locally reject that default. The captured final function leaves the choice key absent for both inputs. Explicit `auto` with an empty list is a different path and is not rejected by that function. Thus null and empty do not exhibit the same earlier behavior. Field default declarations and later tests suggest the intended request-level default, but complete request-model execution remains absent.

The reviewer asks to retain a subsequent independent `if` rather than `elif`; the captured early hunk and final code show this structural issue. The authored `if`/`elif` counterfactuals produced no observable outcome difference on the 35 selected inputs. This is neither universal equivalence nor execution of the missing complete earlier commit. It does not prove a second correctness defect or an actual historical review-rule update.

## B

This case remains static. Construction and neighboring dispatch are present in the source, and the saved PR body reports an actor-method direct-call error. There is no retained version-bound Ray implementation/dependency evidence, upstream test, or executed actor/local path. An annotator may infer a conditional dispatch pattern from source while leaving the external contract/runtime consequence unknown. Do not turn an assumed Ray convention into recorded execution.

## C

The recorded isolated method reproduction finds that zero new tokens can return the entire prompt-plus-output cache before the change and an empty list afterward. Positive new-token suffix behavior, the one-token scalar path, and non-delta output behavior remain relevant boundaries. The saved test is integration-level and unexecuted. See `reproduction/pilot-boundary-results.json` at `/vllm_pr_9034/input_rows`, `/vllm_pr_9034/repeated_delta_call`, `/source_method_bindings`, and `/scope`.

This reproduction uses authored state adapters, not the upstream constructors/callers. Probes with invalid offsets or inconsistent caches show that the zero guard does not establish those invariants; they do not establish that those states occur in the real runtime. An empty cache by itself can hide the zero-slice defect. The generic Python `-0 == 0` mechanism and the repository's delta/cache contract should be distinguished.

## D

The recorded complete `_verify_args` method is run on an authored namespace, not the complete upstream constructor or generation path. `None` reaches a `TypeError` before and returns locally afterward; zero and negative integers retain the lower-bound failure. A deliberately author-created truthiness guard incorrectly admits zero. This counterfactual is not a historical revision. See `reproduction/pilot-boundary-results.json` at `/vllm_pr_2570/input_rows`, `/authored_counterfactual`, and `/scope`.

The same local verifier accepts some unsupported types such as `1.5` and `True`; the annotation change is not runtime type enforcement. Neither local acceptance nor the source report proves an “unlimited generation” meaning for `None`. First-pass readers saw a narrower `int` annotation and lacked the later direct test admitting `None`, so uncertainty about intended domain is legitimate.

## Common limits

The C/D report contains 35 authored snapshot inputs plus a repeated-call scenario and 91 primary invocations across source-bound and counterfactual variants. A matched expected failure is counted as an expectation match, not old-code correctness. This denominator is not a sample size of independent cases. All four cases lack independent human adjudication, an established future target, and historical old/new review-rule artifacts. No proposed update-cause label is supplied as truth.

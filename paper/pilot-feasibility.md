# Offline vLLM pilot feasibility

**Study-route update, 2026-10-02 at `250a242`.** The selected next research pilot is the [one-repository three-window generated-rule experiment](discriminating-experiment.md), not a search for naturally complete old-rule histories. Generate W0 rules from earlier real PRs and freeze them before W1 content/labels enter construction; human-verify actual W1 review findings as experimental feedback; evaluate F/U/H/M on independent W2 PRs with matched conditions. Repository, windows, counts and execution configuration are not yet frozen; no fresh study data, model outputs or human labels exist. The inventory below remains evidence about already-exposed development materials only.

At FlyReWheel `219f553`, the local materials support **three more bounded developmental analyses now: #2664, #9034, and #2570**. They do not support a new holdout experiment or an estimate of feedback-driven rule improvement. Four real source-backed fixes besides #8568 are available; the limit is historical review and independent target evidence, not absence of source code.

The [machine-readable manifest](pilot-materials-manifest.json) records exact repository-relative files, byte lengths, SHA-256, Git blob SHA-1, source URLs, original PR refs, squash-parent/squash commits, selection decisions, and blockers for all five cases. Selection is a convenience choice based on material availability and contrasting mechanisms. All five fixes were already inspected to design their patterns. None is a probability sample, independent human label, or formal holdout.

## What is actually present

| Material | Count and meaning | What it does not establish |
| --- | --- | --- |
| Real source snapshots | Five PRs, ten full selected production files at each squash commit and its first parent | Complete repositories or feedback-before review checkpoints |
| Real upstream test source | Four files: two for #2570, one each for #8568 and #9034 | Tests passed; #9034's integration test directly isolates the selected method |
| Current discussion capture | Only #8568: three issue comments, seven reviews, five inline comments | Five independent corrections, historical visibility, or an old/new review-rule pair |
| Authored seed expectations | AST patterns, input scenarios, expected counts, rationales, and static replay results in `experiments/vllm/` | Independent semantic ground truth; the captured production source itself is not synthetic |
| Fully fictional example | `phase0-annotation.synthetic.json` and authored implementation-test episodes | Any additional real vLLM case |
| History preview and failed capture | The latest batch selected #8568 and stopped at its first GET with HTTP 403 and zero fresh captures | Additional cases; rejected #1–#5 search metadata is not an analyzable sample |

This pass recomputed and matched byte length, SHA-256, and Git blob SHA-1 for **19 existing files**: ten production files, five licenses, and four tests. It also decoded and verified all three source sides in `.flyrewheel/github-pr8568.json`. These checks establish local consistency with the saved identifiers, not online provenance authentication or correctness. The earlier static detector results were read, not rerun. No upstream code, model evaluation, network request, authentication change, install, publication, or source-code edit occurred.

## The three selected cases

### 1 PR 2664 conditional Ray dispatch

[PR #2664](https://github.com/vllm-project/vllm/pull/2664) has full `vllm/engine/async_llm_engine.py` before/after files. The immutable pair is `ab406446691f289ef51d1abd8d1ff66760eda36f` → `d79ced3292445d8471b3c4e5ce2dbf311834ec1b`; the original PR head was a different commit, `c5c755eeea3ac6552b01d2fcc765c6f684110a2b`.

- **Mechanism available:** `_init_engine` (lines 347–365) connects the flag to ordinary versus actor construction. After lines 451–463 branch between `.remote()` and an ordinary direct call
- **Boundary candidate:** the direct call remains under the non-Ray `else` at after lines 458–463. The prior broad AST replay found one candidate on each side. The fixed branch is a source-supported candidate exception to an unconditional ban; it is not yet a verified false-positive label
- **Real feedback:** the saved PR body reports a concrete actor-call error. No raw review/comment history or old/new review rule is present
- **Next offline question:** can a source-cited explanation distinguish actor-only dispatch from the retained ordinary call while stating its receiver and flag assumptions?
- **Blockers:** no added upstream test, version-bound external Ray contract, executed actor path, historical review checkpoint, independent later target, or independent human label

### 2 PR 9034 zero-count delta slicing

[PR #9034](https://github.com/vllm-project/vllm/pull/9034) has full `vllm/sequence.py` at `22f8a69549d30b9b00464141797d274fb6b7e65f` → `ba30942240d35eb26b503e139eb4b01ccbbeb954`. These are not the saved original PR base/head refs. The retained integration test and all four changed-file patches identify the larger serving fix.

- **Mechanism available:** before/after lines 516–539 expose delta mode, token-count subtraction, offset mutation, the single-token scalar return, and the zero-count guard
- **Boundary candidate:** the suspicious negative slice still exists at after line 538, after the zero-count return at lines 535–536. The prior replay found one candidate on each side. Guard-sensitive reasoning is possible without calling every negative slice erroneous
- **Real feedback:** a PR body and researcher-written issue #8988 summary are present. The latter is not a raw issue/review capture
- **Next offline question:** can the explanation isolate `-0` behavior and preserve one-token, multi-token, and non-delta behavior, without assuming unverified offset invariants?
- **Blockers:** the two serving production files are patch-only; the GPU integration test was not run and is not a direct oracle for this method. Full offset lifecycle, raw feedback, historical visibility, and independent later targets remain missing

A later merge date than #8568 does not make #9034 a later application of #8568's tool-default rule. It is a different mechanism and an already-inspected seed.

### 3 PR 2570 optional max tokens control

[PR #2570](https://github.com/vllm-project/vllm/pull/2570) has full `vllm/sampling_params.py` at `1e4277d2d1eceedbe0d00ba9e2c1bef88145df7b` → `3209b4903376fd723858b256dcfabb8420a0cc64`, plus a small direct unit test and a GPU regression test.

- **Mechanism available:** line 186 changes an unguarded numeric comparison to `is not None` followed by the comparison; the constructor and call into `_verify_args` are in the same captured file
- **Boundary candidate:** `None` versus numeric zero/positive values supplies an authored contract contrast. The direct upstream test explicitly declares `None` acceptable. This is a useful small control, not observed feedback against a review rule
- **Real feedback:** a PR-body crash report is present; no review/comment stream or rule-maintenance episode is captured
- **Next offline question:** separate the optional-input contract, Python comparison behavior, and still-invalid numeric values. Keep direct test declarations separate from actual execution
- **Blockers:** tests unexecuted, no historical review reconstruction, no independent later target, no independent human label

## Existing cases kept outside the next three

**#8568 remains a developmental reference and excluded from formal holdout.** Its separate current API capture binds PR base `72fc97a0f100b92f1ff6c6a16e27d12f1c7569aa` to head `eae161c33f47a0b760701769f56fc249563f8ed0`; the older seed files instead use squash parent `e2f6f26e8636b8a23e5c0cda533a70c40ade01ec` and squash commit `ee2da3e9efb38add804e2023d47e9f42f38bd638`. Do not mix these line numbers or byte identities. The original review commit `7aa40bf05fa7cc502c4648d89eeff26b8c97918e` is known only through discussion metadata and a hunk, not a full local source checkpoint. The existing [analysis](developmental-case-vllm-8568.md) and [isolated behavior results](vllm-8568-behavior-findings.md) retain their narrower claims. The current capture is local and ignored by Git; the manifest does not make that package portable.

**#14352 is source-backed but not selected.** Full protocol files exist at `414919138b74ec2e654a25548e031c8fa4b02e64` → `dd732028f59dd149cfdd4e6ca899d50c5839051e`. Default-zero versus positive `top_logprobs` validation is statically analyzable, but there is no retained direct test or raw review history. Issue #14351 is only summarized. Keep this already-inspected case in the same conservative ChatCompletionRequest lineage as #8568; neither its later date nor a different field makes it independent heldout transfer.

## Current next steps and blockers

1. **Permitted local preparation:** inventory the already captured files, check hashes and packet separation, prepare empty W0/W1/W2 frame/exposure/lineage records and neutral prompts. The three case cards and isolated developmental reproductions are already available; repeating them adds no independent case. All four developed cases, plus the already-inspected #14352 lineage, stay outside formal evaluation
2. **Fresh source frame:** identify one non-developmental repository based on access/expertise, then freeze chronology, sampling/counts, acquisition/annotation budget and stop rule before outcome inspection. Keep all in-frame and sampled PRs, zero-yield and failed PR × family pairs. The selected route requires real earlier/middle/later sources and actual review-time visibility, but does not require historical developer rules or naturally occurring rule-revision feedback
3. **Execution and labels remain pending:** W0 generated rules must be locked before W1 exposure, actual W1 review traces must precede human-verified experimental feedback, and W2 targets must be in independent later issue lineages. Models must be equally configured and funded across arms. Two independent humans and an arbitrator are unassigned; nobody has been contacted. Without these, local assistant analyses are preparation, not human annotation or efficacy evidence
4. **Known blockers:** the recorded fresh capture is HTTP 403 with zero fresh captures; its cause remains undiagnosed. At `9e4f4a6`, the [matched F/U/H/M runner](../experiments/matched-revision/README.md) exercises shared supplied diagnoses, neutral proposals, U/M validators and a local-delta memory/common-gate interface with authored fixtures. Its production real-model adapter remains unconfigured and memory-baseline competence unverified; empirical episodes and independent human annotations are both zero. Choosing this study route does not authorize auth changes, new transport/access workarounds, paid API calls, uploads or annotator contact

Missing raw history for the existing #2664 development case can remain documented; obtaining it is no longer the mandatory first gate for the selected experiment. Natural episodes may be a separately labeled optional cohort if later available. The next empirical decision comes from full-frame rule/feedback/recurrence yield, not a promise that more selected anecdotes will complete a benchmark.

This revision performs local specification work only. No new capture or network retry occurred. The recorded HTTP 403 remains undiagnosed between access denial and rate limiting; neither credentials nor transport were changed.

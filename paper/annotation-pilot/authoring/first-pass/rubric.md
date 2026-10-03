# Practical human rubric

Use this same rubric in both passes. Review the specified operation in its available context, not every line in the file. There is no required positive finding count. Do not equate a later repair, merge, reviewer approval, or existing test with an independent correctness judgment.

## 1. A useful rule is conditional

Write **when [preconditions], require [behavior], because [mechanism/contract]**, within [scope]. Separate what the language does from what this API permits. Cite specific lines that establish the input domain, receiver/state, control flow, or contract. If the contract or preconditions cannot be established, leave the rule unfinished, say why, and choose unknown as appropriate.

“Avoid bugs,” “validate inputs,” and a literal pattern ban are too broad. A proposed code edit is not automatically a reusable review rule. Equivalent implementations can satisfy the same rule without using identical syntax.

## 2. Applicability and exceptions

List the concrete facts that must be true before applying the rule. Give one similar-looking legal case or exception if the evidence supports one; otherwise say none is established. Distinguish an actual source example from an imagined input. An authored hypothetical is useful reasoning, but is not an independent real case or executed result. Record assumptions about callers, state consistency, types, and external libraries instead of silently treating them as proven.

## 3. Generic versus repository-conditioned knowledge

- `generic`: ordinary language/library behavior explains the proposed rule and its domain without a locally distinctive contract
- `repository_conditioned`: the conclusion or applicability would change without a specific local construction, lifecycle, or API contract; name and cite that decisive local fact
- `mixed`: generic mechanism plus local facts needed to scope or justify the conclusion; explain both
- `unknown`: available evidence cannot establish the distinction
- `disputed`: credible interpretations conflict; preserve both and say why you cannot resolve them

Code located in a repository is not automatically repository-specific. Recognizing an external API convention is not proof that repository memory or a sophisticated learning system is needed. Explain what extra context changes the decision; do not infer necessity from the existence of context.

## 4. Judgment and uncertainty

The top-level judgment concerns **whether a concrete issue is supported in the supplied target under your stated assumptions**, not whether the whole module is safe:

- `issue_supported`: give a mechanism, consequence, input/state conditions, and citations
- `no_issue_supported_within_scope`: explain the inspected scope and why the suspected problem is not supported there; never claim universal safety
- `unknown`: missing contract/context, inability to establish reachability, incomplete time, or other evidence gap prevents a decision
- `disputed`: conflicting credible evidence/interpretations remains unresolved; state the alternatives

For `reusable_rule_supported`, choose yes/no/unknown/disputed separately; a local issue can exist without evidence for broad reuse. For `context_sufficiency`, choose sufficient_for_bounded_claim/insufficient/unknown/disputed. Confidence low/medium/high describes your own stated claim, not a numerical probability. A well-explained unknown is not a failed annotation.

Evidence items have `kind`: `source_fact`, `source_report`, `static_inference`, `recorded_local_execution`, `assumption`, or `missing_evidence`. Include a locator and a short claim. First pass has no supplied execution record; your reasoning is not `recorded_local_execution`. A test declaration is a source fact about what the test asserts, not evidence that it passed. Later recorded isolated execution applies only to its documented adapters and inputs, not the entire upstream runtime.

## 5. Later evidence and proposed update causes

In pass 2 preserve your pass-1 answer and describe the change, if any. A changed code line does not establish a changed contract, and a reviewer comment does not establish an old rule was wrong. In `update_cause_hypotheses`, consider alternatives only when relevant:

- `no_change_needed`: your proposed rule already handles the revealed evidence
- `missing_precondition`: a condition was omitted
- `overbroad_scope`: the proposed scope includes unsupported cases
- `contract_change`: actual old and new intended contracts plus ordering are needed, not just a new annotation or test
- `implementation_defect`: code contradicts a supported stable contract
- `insufficient_evidence`: not enough information to decide a cause
- `other`: describe a different hypothesis

These are **proposed diagnoses of your interpretation/revision**, unless actual historical rule artifacts are supplied. Multiple alternatives or unknown/disputed are permitted. Name evidence for and against each proposal and what would distinguish them. Do not preassign a cause from a case's reputation, changed syntax, a source-author claim, or the answer key. “Not observed” is different from “proved never happened.”

## Response format

The blank form has no answers or annotator. Fill all top-level judgment fields and explanations; empty rule/exception lists are allowed if explained. Keep `evidence` and `exceptions_or_legal_neighbors` as lists. Use the same case IDs. Record `historical_as_of_claim` as `not_established` unless genuinely supplied evidence establishes historical visibility; an exact commit alone does not. The allowed first/second-pass release here does not itself establish that history.

Every case needs a `limitations` explanation, actual timing, familiarity/exposure response, and at least one evidence entry. For missing evidence an entry can use locator `not_supplied`, or `time_limit` if appropriate. Use your own words. Copying the key is neither independent annotation nor adjudication.

For JSON list entries, use these field names:

- `evidence`: objects with `kind`, `locator`, and `claim` (all strings). Locators use `A/source.txt:L378-L393` style, or `not_supplied`, `time_limit`, or `prior_knowledge`. In pass 2, later references can use `A/later-source.txt:L378-L393`, `A/discussion.json#/reviewComments/0`, or `reproduction/<filename>.json#/scope` style
- `applicability_preconditions` and `missing_context`: lists of explanatory strings
- `exceptions_or_legal_neighbors`: objects with `condition`, `explanation`, and `locator` strings; an empty list is allowed if no supported example is established
- `update_cause_hypotheses` in pass 2: objects with `cause`, `status`, `supporting_evidence`, `competing_explanation`, and `needed_to_resolve` strings. `cause` uses the categories above; `status` is proposed/unknown/disputed. State “none established” with a reason rather than inventing an alternative or missing fact

In pass 1 leave `prior_response_sha256`, `change_from_first_pass`, and `update_cause_explanation` null and `update_cause_hypotheses` empty: no later update evidence has been released. In pass 2 explain “unchanged” where appropriate; an empty hypothesis list still needs `update_cause_explanation`. Record UTC timestamps with a trailing Z and numerical active/pause minutes. Use “none” for no deviations, rather than leaving that field null.

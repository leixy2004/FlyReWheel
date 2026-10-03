# Four-case annotation training / pilot packet

**Prepared from existing local materials at `08bc3a8`, 2026-10-02. No human annotations have been collected.** This is a convenience-selected training exercise using four already-inspected vLLM development cases. It is not a formal holdout, historical review replay, opportunity-rate sample, or inter-rater study result. Existing research labels are unchanged.

## Relationship to the selected research pilot

The selected [three-window study](../discriminating-experiment.md) will generate and freeze W0 rules before W1 labels, obtain human-verified experimental feedback on actual W1 reviews, and compare updates on independent W2 PRs. This four-case packet is only annotation training and packaging practice. Completing it, including with two humans, does not supply formal W0/W1/W2 cases, independent future outcomes or benchmark labels. No naturally complete developer rule-maintenance chain is required for the selected study, but honest experimental provenance, source visibility and later-lineage independence are required. Assignment/contact of participants remains pending; the study-route decision does not authorize contacting anyone.

## Run it

1. From the repository root, check the prepared bytes: `python -I paper/annotation-pilot/prepare_packet.py --verify`. This is a stdlib-only local data/hash check. It does not execute vLLM, reproduction methods, upstream tests, model calls, networking, authentication, or deployment.
2. Arrange two actual human annotators who can read Python. Give each a private copy of **only `first-pass/`**, outside this repository. Do not give them this README, the generator, `authoring/`, `second-pass/`, `facilitator/`, or `audit/` before their first submissions. Ask them to record prior case familiarity and accidental exposure. Do not ask the author/assistant to impersonate an annotator.
3. Each independently copies `answer-form.blank.json`, reads `START_HERE.md` and `rubric.md`, and fills the copy. Preserve the distributed blank and original response. Record actual time rather than a prescribed minimum. No discussion, web lookup, code execution, or searching sibling repository files during this exercise; log any departure.
4. Collect and hash both first-pass submissions before releasing `second-pass/`. Preserve immutable originals in a location chosen by the coordinator; do not rebuild over or edit submissions. Each then independently fills a **new** second-pass form, records the original first-pass SHA-256, and explains any change. The second pass deliberately reveals later source, reports, and authored evaluation notes. It cannot be described as fix-blind.
5. Only after both second-pass submissions are locked, open `facilitator/answer-key.md` and discuss differences. Record unresolved disagreements in `facilitator/adjudication.blank.json`; do not silently force consensus or replace original answers. The key is a defeasible author interpretation, not ground truth.

Optional structural check of a filled form: `python -I paper/annotation-pilot/prepare_packet.py --check-answer /absolute/path/to/response.json --stage 1` (or `--stage 2`). It checks shape/enums, basic timing consistency, identity/freeze fields, completed judgments, and source-reference syntax. It cannot verify who filled it, independence, evidence validity, or honest timing. Unknown and disputed are valid completed judgments. A blank form intentionally fails this filled-form check.

To regenerate the distributed directories from the pinned local inputs, use `python -I paper/annotation-pilot/prepare_packet.py --build`, then `--verify`. Build refuses unexpected files in the generated directories and never writes outside this packet. Case A requires the already-present, Git-ignored `.flyrewheel/github-pr8568.json`; the prepared distributed packet remains readable without it, but re-generation/full source verification requires that exact local input. No acquisition is attempted if it is absent. Audit records are separate from participant materials.

Local validation tests: `python -B -I paper/annotation-pilot/test_packet.py`. These check byte separation, rejection of added/substituted later source, missing-file detection, blank-form preservation, and source-pair identity. They exercise this packet's own preparation/checking code only; no synthetic completed annotator responses are saved or presented as human data.

Source presentation adds line numbers, omits an added separator space on empty lines, and visibly marks any **preserved original** trailing whitespace with `⟦EOL⟧`. That marker is not source. Original source bytes and audit hashes are untouched. Pair diffs use valid zero-context unified format; full numbered source supplies the surrounding context.

## Proposed session, not an effort result

A first try can budget roughly **60 minutes per person**: 8 minutes onboarding/rubric, 24 minutes first pass (about 6 per case), 16 minutes second pass (about 4 per case), and 12 minutes discussion. This is a planning estimate, not a measured annotation cost or guarantee. Pause or extend if needed; record unfinished cases as unknown with the missing evidence or time limit. A 60-minute stop does not turn incomplete work into a negative label. Record pauses separately. For two people this is roughly two person-hours, plus coordinator setup/adjudication time, all unmeasured until performed.

## Selection and historical visibility

- A = #8568, PR base/head from the saved current API capture; **not** its separate squash-parent/merge fixture pair
- B = #2664, C = #9034, D = #2570, each the saved squash-parent/merge pair
- B is the strongest candidate for repository-conditioned applicability, but missing version-bound Ray context can legitimately leave runtime correctness unknown
- D is deliberately a weak/control case: ordinary optional-value handling may explain it without sophisticated repository-specific knowledge. Before-only contract evidence can be insufficient

Neutral letters and withholding reduce direct outcome exposure; **they do not guarantee blinding**. File names, code, selected line ranges, source attribution, or version recognition can identify a case. All cases were selected with their repairs already known to the packet author. Familiarity or prior access to fixes/results disqualifies a claim that that participant's response was formally blind; it need not disqualify training. Record this per case, without pretending the response is independent discovery.

“First pass” describes what this exercise releases, not what a historical reviewer could see. A's early review commit is available only as a hunk; its current PR base/final head and edited discussion do not reconstruct earlier visibility. B–D have no raw review stream/checkpoint. Capture time, provider-created time, edited-body time, commit identity, and first public availability are distinct. All four historical as-of eligibility claims remain unknown/not established. The audit manifest records exact mappings and timestamps where available, without making those claims.

## What can be reported afterward

With real participants, report training usability, actual times, item-level differences, uncertainty reasons, and changes after later evidence. If computing exploratory descriptive agreement, first define units, categories, missing/unknown handling, and denominator, and retain independently frozen pre-discussion responses. Two annotators and four selected training cases cannot establish a reliable general inter-rater estimate. Revisions within the same annotator are not inter-rater reliability. Adjudicated agreement is not independent agreement. **There are currently zero human responses, so no inter-rater metrics may be reported.**

No count here measures recurrence, future transfer, review gains, feedback-caused rule improvement, or validated update diagnoses. Case D does not become stronger evidence by agreeing with the key. Case B does not become wrong merely because a cautious annotator chooses unknown. Update causes are proposed alternatives, never preassigned truths; none of these materials supplies an actual old/new historical review-rule pair.

## Contents and next decision

- `first-pass/`: neutral tasks, before-only code/context, blank response form, rubric, attribution/license
- `second-pass/`: later code and exact local pair diffs; retained test source; source reports/discussion; evaluator notes and existing bounded reproduction results; new blank response form
- `facilitator/`: author answer key, disagreement guide, blank adjudication form, held until both passes are frozen
- `audit/`: exact source mapping, input pins, output hashes, release allowlist, validation report; never first-pass material
- `authoring/`: editable text templates used by the generator; not participant materials

A remaining execution decision is whether to assign **two real annotators and a coordinator/adjudicator** for this training run, or keep the packet as preparation only. The research route itself has already been selected; this training assignment does not choose or execute it. No one has been contacted. Separate fresh cases, an agreed sampling/visibility protocol, and fresh independent labels would still be needed for a later formal study.

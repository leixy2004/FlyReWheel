# OpenAI API backend reuse review (read-only)

Reviewed implementation baseline: `3ff76d346ef5326614c6d9c30a5f1ca2a00931e9`.
No API/model call, key configuration, runtime replacement or new framework was
performed. This is an alternative-path assessment, not a successful model receipt.

## Reusable implementation and smallest honest integration

[`src/adapters/openai-compatible.ts`](../src/adapters/openai-compatible.ts) already
uses the official OpenAI SDK Chat Completions API for synthesis and adjudication.
It disables SDK retries, sends no tools, sets output-token and input-byte bounds,
requests explicit schema/JSON mode, parses with Zod, and validates evidence. The
existing code can target the official OpenAI endpoint with an authorized model
and API key; its self-hosted-compatible name is not a fundamental API limitation.
Official Structured Outputs supports schema-constrained answers, but the chosen
model and exact generated schemas still need compatibility validation. No silent
fallback from strict schema mode should be introduced.
[Official structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs).

This is not currently a wired end-to-end backend:

- [`pipeline.ts`](../src/pipeline.ts) accepts only `CodexExecutionConfig` for live
  replay; [`model-runtime.ts`](../src/model-runtime.ts) freezes `codex_sdk` identity.
  Injecting an API adjudicator while retaining Codex provenance would be false.
- [`pr-mining-model.ts`](../src/adapters/pr-mining-model.ts) requires supervised
  workspace transport and explicitly rejects bare model transport. This path
  cannot be bypassed merely by choosing another provider adapter.
- Current adapter has timeout but no caller cancellation propagation or explicit
  response-byte cap. Adjudication records token usage; synthesis currently drops
  it. Currency is null, not zero, and timeout does not prove remote billing stop.

The shortest honest milestone is a separately identified **API synthesis → native
detector → API adjudication replay**: reuse this adapter and evidence validators,
add an explicit API frozen configuration/receipt type, persist exact model/route,
prompt/schema/settings identities and usage, and implement bounded cancellation,
response handling and accounting. Keep Codex as a distinct backend. This can
establish a real core model loop without depending on nested CLI authentication;
it does not establish application PR-mining or matched-study runtime isolation.
The latter need separately versioned transport integration preserving existing
workspace/provenance/lifecycle checks. No implementation was started pending the
parent's backend choice and file ownership assignment.

## Actual authorization gaps

Presence-only checks found `OPENAI_API_KEY`, `QE_CODEX_API_KEY` and `CODEX_API_KEY`
absent; no values or credential files were read. To dispatch, supply an authorized
API project credential through an approved host-side mechanism, explicitly select
a supported model/route and permit the relevant evidence transmission. Do not
extract existing ChatGPT authentication into API configuration. ChatGPT subscription
and API usage are separately billed.
[Official billing distinction](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus).

The user permits the OpenAI stack/external models, but a billable run still needs
an explicit cost arrangement. An output token cap and disabled retries limit
some work; they do not create a hard dollar quota or cover input/aborted-request
billing. If a hard spending cap is required, use a separately enforceable mechanism
with in-flight exposure rules, or leave the run blocked. No prices or zero-cost
claims are inferred here.

## Paper fairness

The [SDK-native amendment](../paper/experiment-protocol/sdk-native-study-amendment.md)
freezes role-specific models, routes/settings and matched exposure across arms.
An API backend is a new profile/block/amendment, not a drop-in continuation of old
Codex results. Apply the same role-specific API model and settings across compared
arms, preserve byte-identical shared evidence/diagnosis, gate and future roster,
and record model snapshot, route, schema, settings, timing and available usage.
Do not mix old Codex and new API arms or label different routing as a controlled
model comparison. Token caps do not imply equal realized compute or dollar cost.
A core feasibility loop is not paper efficacy evidence; external study/data and
monetary gates still apply.

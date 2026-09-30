# Scanner and semantic adapters

The base demo uses native ast-grep and explicitly named offline replay fixtures. It does not contact a model. Fixture replay proves pipeline behavior, not model quality or a human ground-truth label.

- `detectAstGrep` scans a whole supplied JavaScript/TypeScript/JSX/TSX/Python file. It never filters to changed lines. It executes native AST matching, not regular expressions. Language parsing, pattern semantics and recall are those of the pinned ast-grep version. A pattern is not a complete semantic or binding resolver. In particular, this initial simple pattern contract does not normalize every comment-placement variant. Scanner/parser errors and exceeded bounds throw explicit `DetectorError`s rather than silently truncating coverage.
- Python uses the official pinned `@ast-grep/lang-python@0.0.6` prebuilt native grammar via `registerDynamicLanguage`, registered centrally once. No Python parser is implemented here and source Python is never executed. Native ERROR nodes and zero-width recovery descendants fail closed; the latter conservatively catches missing delimiters/blocks because the pinned NAPI does not expose tree-sitter `isMissing`. This is a syntax-recovery guard, not a Python compiler or type checker. Python is also an allowed synthesis language.
- Candidate offsets are 0-based UTF-16 string indices, with 1-based line/column positions and an end-exclusive span. Source text, source digest, exact span and rule-version identity are checked before semantic adjudication. Semgrep/OpenGrep byte offsets are converted from UTF-8 and verified against source positions.
- `parseSemgrepJson` imports Semgrep/OpenGrep JSON. It does not spawn a scanner or a project command. Callers must attest a full-file invocation and supply the exact source snapshots used by that scan. `paths.scanned` must cover those sources; errors or missing coverage set `complete:false`. Imported CLI output is not independently authenticated.
- Context kinds in `skill.requiredContext` must be present in the supplied evidence. Missing context produces an `unknown` adjudication before a fixture or model can run. Source-anchored evidence must match its supplied snapshot. Decisive judgments must cite supplied evidence for every required kind. Evidence correctness still depends on its producer; evidence is never silently invented by the adapter.

## Codex SDK

`createCodexAgentAdapter` uses the official `@openai/codex-sdk`: one new thread and one streamed turn per adjudication or synthesis. It passes `outputSchema`, validates the resulting JSON, checks evidence references, and rejects unexpected command/file/MCP/web activity. Source text is supplied in the prompt; the target repository is never made its working directory. Temporary work/home directories, read-only sandboxing, disabled shell/unified-exec/hooks/subagents/apps/web search, and an explicit environment avoid ordinary repository and user configuration inheritance. Administrator-managed runtime settings and host/kernel isolation must still be assessed in deployment; these flags are not a substitute for a container policy.

Live calls require `enabled:true`, an explicit model, timeout and postflight token acceptance ceiling. The SDK does not expose an enforced USD cap here. `maxReportedTokens` is checked after reported usage and is not a spending cap. `costUsd:null` means unavailable, never zero/free. Use provider-side billing limits for API-key mode. The wall-clock timeout aborts the SDK signal; cancellation is best-effort and may not prevent already incurred usage.

Auth modes:

- `api_key`: an explicitly supplied API credential, never inferred from ambient environment
- `dedicated_login`: an explicitly supplied absolute login-only `CODEX_HOME` already provisioned by the user. It must contain file-backed `auth.json`; the adapter inventories names but never reads/parses/copies the credential contents. Configuration/plugins/hooks are rejected. Its replacement environment omits `OPENAI_API_KEY` and `CODEX_API_KEY`, avoiding accidental API-key fallback. This implementation does not create logins, copy tokens, use the user's ordinary home automatically, or guarantee that a subscription/provider permits a particular deployment

The inference connection is still required. `networkAccessEnabled:false` restricts the CLI sandbox option; it is not a blanket block on inference traffic. Enforce allowed model endpoints and other egress at the container/cluster boundary.

## Optional self-hosted model endpoint

`createOpenAICompatibleAdapter` uses the official `openai` SDK with an explicitly configured base URL, credential/placeholder, model, output-token cap, timeout and byte cap. It makes a single tool-free Chat Completions request with retries disabled. This adapter can target an API-compatible local inference service but actual provider compatibility has not been tested. `responseFormat:'json_schema'` requests strict structured outputs. Providers supporting only JSON mode require explicit `responseFormat:'json_object'`; local Zod validation remains mandatory. Unsupported schemas/parameters are execution failures; there is no automatic downgrade.

Both live adapters allow zero proposed rules: an `insufficient_evidence` model result returns successful `status:no_rule` with reasoning and missing evidence, no draft, and no detector replay. Synthesis transport wraps its discriminated union in a root `{result: ...}` object for strict structured-output compatibility. Candidate results return reviewable synthesis drafts after replaying actual native before/after matches on explicit training bug-fix pairs. A pre-fix miss invalidates the draft. Post-fix matches remain allowed: fixes adding a dominating guard or choosing the correct dispatch branch can preserve a valid high-recall structural candidate. Each replay row records `beforeMatches`, `afterMatches`, and `requiresSemanticValidation` (true when post-fix candidates survive). That flag requires contextual semantic regression checks of those surviving candidates; it is never evidence that the fix failed. All candidate drafts, including those with zero post-fix matches, still require independent semantic adjudication and held-out evidence before production promotion. Held-out inputs are rejected. This structural training replay is not semantic validation, an evaluation certification, automatic bundle activation or publication.

Tests use the real native detector and mocked official SDK APIs. The actual Codex native executable has not been invoked or tested live; Codex coverage is SDK contract testing with mocks only. No live model, subscription login, credentials, scanner CLI, or production sandbox has been exercised. Official references checked against installed types:

- https://learn.chatgpt.com/docs/codex-sdk
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://github.com/openai/openai-node

Python registration reference: https://ast-grep.github.io/guide/api-usage/js-api.html#use-other-language

# Codex effective configuration: offline evidence

Issue: https://github.com/leixy2004/FlyReWheel/issues/2

Run from the repository root:

```sh
node --import tsx scripts/verify-codex-effective-config.mjs
```

The script imports current source through the installed `tsx`; it does not reuse
`dist`, build images, read authentication files, initialize a live gateway, or run
the real Codex executable. The official SDK invokes a temporary authored executable
that records arguments and emits fixed JSONL. Temporary files are removed on exit.
This is authored offline evidence, not evidence of model acceptance, sandbox
isolation, billing enforcement, or actual deployment.

Observed on 2026-10-03: exit 0; SDK `0.159.2`; 9 authored SDK invocations;
9 operational requests rejected before runtime verification. Declaration SHA256:
`954d28bec3db17316c2f6acbbd157210ded9f75143c50827215739110327c7ac`.
Real model calls: **0**. Gateway calls: **0**.

| Setting | Actual verification | Scope / remaining gap |
| --- | --- | --- |
| `model` | Matched builder → JSON wire → parsed worker → actual SDK-generated `--model` argument | Explicit fixture model; no provider acceptance claim |
| `modelReasoningEffort` | Omission and all eight installed SDK enum values → actual `model_reasoning_effort` CLI override and process evidence | Omission remains absent; `none` rejected; no default inferred |
| `limits` | All six byte/artifact/time fields survive encoded request round trip unchanged | Successful fixture output is within the forwarded-byte bound; this check does not exercise overflow or timeout failures |
| No-tools policy | SDK arguments disable shell/unified execution and web search; read-only mode retained | External runtime isolation remains necessary |
| `providerCallsPerArm`, `maxCostMicros` | Extra worker fields rejected by strict schema | Research configuration ceilings do not become worker or provider admission controls |
| Temperature / seed / output-token cap | Absent from installed typed `ThreadOptions` and generated fixture arguments | Unsupported controls must not be guessed as CLI keys |
| Operational admission | All pending-admission requests rejected before the trusted boundary verifier can run | Authored execution uses a separate explicitly marked copy; production gate remains closed |

The request/worker path has no operational provider-call ceiling or monetary-policy
field. `experiments/matched-revision/sdk-native-contracts.ts` defines research
configuration declarations such as `limits.providerCallsPerArm`,
`limits.dispatchedAttemptsPerArm`, `runtimePins.providerRoute`, and
`monetaryPolicy`; parsing those declarations does not authorize dispatch. A single
observed SDK invocation does not prove a single provider or billable call.

Before a real-model session, the missing deliverable is deployment-bound gateway
admission with verified route, runtime/CLI pins, authenticated authority for the
chosen role models, and a specifically authorized monetary arrangement. The
existing contract distinguishes a hard ceiling (`currency`, `maxCostMicros`,
whole-study including-in-flight scope) from explicit exposure authorization
(`stopPolicyDigest`, `reconciliationPolicyDigest`). Neither arrangement is
implemented by this script or conveyed in the worker wire request. Real requests
must remain blocked until the chosen arrangement and provider-call accounting are
actually enforced by the authorized runtime/gateway path.

Do not substitute fixture model names, declaration hashes, request digests, or an
authored boundary for model permission. Do not loosen the pending-admission gate
to obtain a live result. Re-run this script after changes to request encoding,
worker settings, SDK pin, or CLI argument construction; its assertions fail if
explicit supported settings disappear or unsupported controls are silently added.

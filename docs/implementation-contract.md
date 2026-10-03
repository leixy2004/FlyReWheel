# FlyReWheel rebuild: first vertical slice

This is a fresh implementation of an evidence-backed quality-learning workflow. It includes no private source code or authentication material.

## Product contract

Learn from explicit Problem Cases/Bug-Fix Pairs; keep semantic Skill, applicability/exception context, deterministic detector and regression examples in one immutable RuleBundle version. Execute full-file structural detection before semantic adjudication. Preserve candidate coverage, abstention, execution failure, evidence and version lineage. A model decision is never a human ground-truth label.

Production direction: TypeScript, official OpenAI Codex SDK, self-hosted pg-boss/PostgreSQL background execution, and a self-hosted S3-compatible object store inside one k3s cluster. External model inference is allowed; no Claude Agent SDK. Local development must not require accounts or services: use PGlite (real embedded PostgreSQL) and explicit offline fixture adjudication. Offline fixtures prove plumbing, not model quality. External adapters are opt-in and must never activate from ambient credentials during tests/demo.

## Implementation boundaries

- Core: Zod schemas, immutable identities, PostgreSQL persistence, feedback append-only semantics, promotion and evaluation policies; separate opt-in local semantic-v2 governance with per-rule CAS history
- Detectors: reuse ast-grep for an executable structural example; OpenGrep/Semgrep JSON adapter for multi-language extensions; no regex imitation of a static analyzer
- Agent: official Codex SDK structured outputs, narrow read-only tool policy; no custom CLI transcript parser, no shell/Bash grants, no automatic model calls in tests
- Jobs: one mature PostgreSQL-backed queue adapter; do not implement a scheduler, lease service or retry engine
- Integration: CLI plus JSON/SARIF/reviewdog-compatible results; outbound comments are plans only, not auto-published
- Evaluation: Vitest + native scanner fixtures; promptfoo documented as an optional future model-regression runner. Frozen manifests and case lineage are domain-owned

## Minimum acceptance

1. A real native detector hits a synthetic pre-fix sample and stays silent on its fixed sample
2. A hard-negative structural match is rejected only when the required contextual evidence exists; missing context produces Unknown
3. Duplicate rule version imports are idempotent; same logical version with different content is rejected
4. Changed versions create new records and retain provenance; feedback refers to exact finding and version
5. No feedback, resolve, or merge alone promotes a finding to TP
6. Candidate state distinguishes not_recalled, not_verified, rejected, passed, abstained and execution_error
7. Promotion requires known labeled evidence, explicit denominators, no execution errors, and minimum declared policy thresholds; training examples cannot certify heldout quality
8. Task/run identities bind commit, bundle digest and configuration; same key with different payload fails
9. Stale proposal approval/promotion is rejected using the expected active version
10. No automatic account setup, credentials, deployment, repository push or third-party communication

## Local semantic-v2 governance boundary

The `local-semantic-review` namespace records local experimental review eligibility,
not production activation or broad semantic correctness. Immutable version import,
revision generation and accepted comparison decisions never change eligibility
implicitly. Explicit commands register candidates, bootstrap an unvalidated root,
select a comparison-backed revision, suspend, retire or atomically supersede a
version. Retired and superseded versions are terminal; at most one version per
logical rule is selected as `local-shadow`.

Every mutation pins the exact rule and canonical scope digests and the expected
head of that logical rule's append-only event stream. Revised selection requires
an accepted compatible current per-anchor comparison with nonempty scored
observations. Supersession additionally requires an already registered successor
of the same logical rule, its direct parent to be the exact old version, and a
comparison of that exact pair. Eligibility pins that immutable decision/comparison;
later feedback or separate accept/reject/defer decisions never automatically select,
revoke or renew it. Any such change requires a new explicit action and current CAS
head, not a latest-feedback consensus. History validation preserves hashes,
provenance and legal transitions; failed CAS or validation cannot partially replace
a rule.

Exact repository/path selection returns eligible local-shadow versions and
exclusion explanations without running or publishing anything. Digest-pinned
review APIs remain available for explicit historical/research replay; only opt-in
registry selection is gated. The v1 active registry and promotion flow remain
independent. Fixture and local-human-declared provenance are never authenticated
approval, and neither bootstrapping nor comparison acceptance grants certification.
See the [commands, states and trust limits](semantic-rule-governance.md).

## Source privacy and execution limits

Use generic newly authored examples only. Keep all original presentation/research source files outside this repository. Git worktrees provide filesystem separation, not a security sandbox. Never execute cloned repository scripts, generated plugins or tests on the host. Scanner execution is limited to a trusted installed scanner and bounded input. Production arbitrary-code execution requires an explicitly configured isolated execution worker or sandbox with no publication/storage credentials. k3s integration, live LLM quality, crash recovery across hosts and repository-provider publication must be reported as unverified unless actually exercised.

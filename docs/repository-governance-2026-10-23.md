# Repository governance audit — 2026-10-23

Baseline main: `d749e3acd997514208b8b83a8b35c6095288a565`.
All 55 remote branches were fetched explicitly (the original fetch tracked main
only). Initial inventory: 54 non-main branches, 0 open PRs, 2 open issues (#2/#3).
Main reported unprotected and no repository rulesets; no protection was changed.

## Preservation and integration

39 branch tips are already ancestors of baseline main. The other 15 tips have
29 distinct commits in total, all reachable from
`73e61dff7890f7daa486cd95c88e4dd5104e952e`
(`codex/memory-active-state-20261005`). A normal two-parent merge brings that
entire chain into main history, preserving original commits and provenance.
No squash, force push, branch protection bypass or wholesale old-tree replacement.

Reviewed unique implementation groups:

- PGlite setup/teardown ownership and a separate setup timeout; serial test option.
- Pure evaluation-annotation validation, private blinded packet/submission and
  adjudication workflow, authored guarded-family admission and explicit blocking
  of unsupported empirical promotion.
- Matched evaluation contract, mechanism coverage and complete-roster descriptive
  macro reports; unknown costs and unestimable endpoints remain explicit.
- Active memory rendering/capacity parity, with execution-policy digests in native
  recovery identity so a changed policy cannot silently reuse old execution.
- Historical CLI smoke, source-literature audit, application convergence and
  construction/inspection planning documentation and preserved receipts.

Conflict resolutions: keep baseline main's worker launch/service/CLI and worker
launch tests, which already contain the older bootstrap route plus PR #41's
inspection and compatibility fixes. Combine both manuscript literature sections,
renumbering Chen/Stratton to reference 12. Preserve main's newer construction
implementation, feedback/workspace features and synthetic temporal-frame tests.
The imported W0 planning test is changed to authored inputs and a pure planning
function; the production `generate` entrypoint retains exact input digest checks.
Routine tests must not read retained research frame or admission files.

The parser/quote/span checks and authored screening already implemented by PR #42
are no longer listed as unimplemented in the paper status/method. Independent
semantic assessment, real-source provenance and authenticated study exposure
remain pending. Issues #2/#3 are migrated to [TODO.md](TODO.md), not declared done.

## Audit boundary and recovery

The selected saved cloud workspace started clean at baseline main on local branch
`work`, with one worktree and no local-only commits on that branch. No AGENTS.md
or repository `.agents/skills` was present; `/workspace/.agents` was empty.
The old denied task environment was not accessed. Its uncommitted/unpushed work is
outside this audit; “latest” means this saved workspace plus current remote refs.
Ignored build/dependency/runtime directories were not treated as unpublished source.
No real model, deployment, upstream comment or frozen research-data inspection was
performed. Historical research blobs are retained by Git integration without being
used as fresh study inputs or revalidated empirical evidence.

After the PR passes CI and is normally merged, verify every recorded SHA with
`git merge-base --is-ancestor <sha> origin/main` before deletion. Recover any former
branch using `git switch -c recovered-branch <sha>`. The governance PR head is also
preserved by its normal merge commit. The full per-branch unique-commit lists are
in [the machine-readable audit](repository-governance-2026-10-23.json).

## Verification

Local typecheck and production build pass. Full-suite results and the remote CI
link are recorded in the governance PR before merge. CI now validates main pushes
as well as PR merge commits, so the final merged SHA receives its own acceptance.
Historical run 39619357772 is not used as current validation.

## Original branch tips

| Branch | Original SHA | Commits outside baseline main | Disposition |
| --- | --- | ---: | --- |
| `codex/blinded-annotation-workflow` | `5e9ea02035c1f5d7c5ada0db2d09ead4efd77ecb` | 9 | Integrated via preserved memory-active-state ancestry |
| `codex/cli-smoke-audit` | `54a2f4dfebc9a3a5e7c03930ac9997b19db8d96e` | 1 | Integrated via preserved memory-active-state ancestry |
| `codex/construction-raw-response-validation` | `0af24f3d66e3823897368dc078c1543b6dd78b12` | 0 | Already in main history |
| `codex/converged-admission-20261004` | `e410339414f42292f14f938d877a58308e997c25` | 22 | Integrated via preserved memory-active-state ancestry |
| `codex/converged-application-20261004` | `2727dcf987dfe1c254b0bb8475da4db1b318bd16` | 20 | Integrated via preserved memory-active-state ancestry |
| `codex/deterministic-construction-protocol` | `05dfcf6f2746b17369b5dfc858d9ad27d66844db` | 25 | Integrated via preserved memory-active-state ancestry |
| `codex/development-family-admission` | `905ece08911b882c76cd606b5ddfaaa759747c8e` | 21 | Integrated via preserved memory-active-state ancestry |
| `codex/entrypoint-identity-followup` | `82bdad9efc09912f7200959fcda7750fcee67c80` | 0 | Already in main history |
| `codex/evaluation-cli-registration` | `029917926d577430febcab1654f440d31bc1f01f` | 0 | Already in main history |
| `codex/explicit-review-continuation` | `48d6bb8c4e8006bf1c2c1d848a1afbe4a6122c53` | 0 | Already in main history |
| `codex/feedback-governance-loop` | `3a427f3911b605f506be23057697c6b73ae917c8` | 0 | Already in main history |
| `codex/governance-committed-recovery` | `eefd35c3814684e22046022df248429789bccb33` | 0 | Already in main history |
| `codex/integration-candidate-2026-10-03` | `0471c0b2e69c187c7907a9d1ade396b310cb6f3d` | 0 | Already in main history |
| `codex/integration-context-composition` | `9f51467e9135389bc86f616a6c303c86a22ee95c` | 0 | Already in main history |
| `codex/integration-matched-paper-20261004` | `89d1cfdc7a3d06d5164176fb52e0edba93f2ba0a` | 6 | Integrated via preserved memory-active-state ancestry |
| `codex/integration-native-macro-20261004` | `a05af56c4427859a2e003e7581f129c75aafb73b` | 8 | Integrated via preserved memory-active-state ancestry |
| `codex/integration-w0-candidate` | `0b476d9f6835fec63b3b924c0de3120d3c79922f` | 0 | Already in main history |
| `codex/issue-1-real-postgres` | `3fdb63bb767622c9177a3f4d6283126496154277` | 0 | Already in main history |
| `codex/issue-1-recovery-review-fixes` | `e296ae8f17f569f0b694464273dcc45ef28c41e2` | 0 | Already in main history |
| `codex/issue-11-bounded-pr-ci` | `2f19dc3427249a2253061b5570d8ebde7fb56829` | 0 | Already in main history |
| `codex/issue-2-authorized-runtime-retry` | `8dc8070d22b26291d978aa58a4fd59a375a350df` | 0 | Already in main history |
| `codex/issue-2-bounded-runtime-image` | `036e64ae1182348491d6587d028a156d17f0f8be` | 0 | Already in main history |
| `codex/issue-2-deploy-contract-audit` | `6c2185c7eb47e3856fd86f5aeb56d8ba7f3aed5f` | 0 | Already in main history |
| `codex/issue-2-explicit-worker-bootstrap` | `1bc2afffdd28c5ebde64f81e39944d816fdca8f7` | 0 | Already in main history |
| `codex/issue-2-pinned-kubernetes-render` | `d5f0b49db7da7cb53c5c8528433c8b3fc295651f` | 0 | Already in main history |
| `codex/issue-2-runtime-readiness` | `daa72fd7b6d423bd68032432fe7fef045b7a9560` | 0 | Already in main history |
| `codex/issue-2-stop-recovery-resolver` | `6a1a8ac1d56f659f2e7d96b000739025f9755672` | 0 | Already in main history |
| `codex/issue-3-evaluation-resolver-cli` | `8f26428d6723dd8792d8733301a4098c57138b06` | 0 | Already in main history |
| `codex/issue-3-evidence-boundaries` | `d8c89d85e7e4d5c12fab5028fa6fbf54e6114ae3` | 0 | Already in main history |
| `codex/issue-3-frame-validation` | `7ecaefdef30d7cc903c850fb4f5c6f58aff98257` | 0 | Already in main history |
| `codex/issue-3-native-evaluation-bridge` | `498e704dd91c76dd846fb64183df3ed20b887ec0` | 0 | Already in main history |
| `codex/issue-3-offline-evaluation-route` | `ba319f64eafc06b816975ee159c510a8404e0644` | 0 | Already in main history |
| `codex/issue-3-w0-behavior-validation` | `ce9b9fbfc3abf5d1d542652e0b19ca01fca8e4fc` | 0 | Already in main history |
| `codex/issue-3-w0-evaluation-inputs` | `1565fade76e4fe640bcfc810415e491d7ac6e13b` | 0 | Already in main history |
| `codex/issue-3-w0-evidence` | `671e57dd0f41099260d9d50c8cbac15b631a6c9f` | 0 | Already in main history |
| `codex/issue-3-w0-full-context` | `dfee04c00674371551153c71c02473b2205a44de` | 0 | Already in main history |
| `codex/issue-3-w0-mining-preparation` | `f02c9c483abd79533b29e52f41aca51f979c1320` | 0 | Already in main history |
| `codex/issue-3-w0-permission-diagnosis` | `a7adb0ee4c86fd6e72f5a1327ff2ac0e0a8ec760` | 0 | Already in main history |
| `codex/issue-3-w0-producer` | `528d4bb1d21aaa6588bf9b88c6ecc2e761724c2f` | 0 | Already in main history |
| `codex/issue-3-w0-proxy-capture` | `04155f2d4fafa7063e55caedaa3f2353b85fc268` | 0 | Already in main history |
| `codex/issue-entrypoint-symlink` | `f1f2f61523eb82cafd2af09827ca6e73b8cb6792` | 0 | Already in main history |
| `codex/matched-macro-uncertainty` | `4445cb65a548cf6c3c3b58b9f7b66953672adf2c` | 7 | Integrated via preserved memory-active-state ancestry |
| `codex/memory-active-state-20261005` | `73e61dff7890f7daa486cd95c88e4dd5104e952e` | 29 | Integrated via preserved memory-active-state ancestry |
| `codex/minimal-matched-evaluation-contract` | `6c25eac50ccb05223a024a52a521b60d8f738d20` | 4 | Integrated via preserved memory-active-state ancestry |
| `codex/native-macro-report` | `a05af56c4427859a2e003e7581f129c75aafb73b` | 8 | Integrated via preserved memory-active-state ancestry |
| `codex/offline-construction-freeze` | `f729dc638e69824bed03fdcbd7ed7e6b68680a85` | 0 | Already in main history |
| `codex/offline-reproducibility-followup` | `9d98197fa6183f98e5da15d5c207167f8d3dbcb2` | 0 | Already in main history |
| `codex/opensandbox-plan-entrypoint-fix` | `e777ec0302ec960b5aa552ececf1855ac41e8672` | 0 | Already in main history |
| `codex/paper-primary-source-gap-audit` | `7eb922bf91e4c5ee0fd1f51088ff6d2348597bec` | 1 | Integrated via preserved memory-active-state ancestry |
| `codex/pglite-setup-budget-9043274-20261004` | `90432743d2a8ff316aecf862e42c0613d35ff9a6` | 3 | Integrated via preserved memory-active-state ancestry |
| `codex/remaining-w0-inspection-plan` | `f69dbb0091e7fc7a7b29daf87d4f5cf9d9d98505` | 24 | Integrated via preserved memory-active-state ancestry |
| `codex/repository-integration-20261020` | `b09f3afe39479795e8f70ecc5beaf131b77cf6a6` | 0 | Already in main history |
| `codex/revision-preflight-readonly` | `28a567a96eb2331fdd2be22f7154623a8a28bd59` | 0 | Already in main history |
| `codex/worker-launch-compatibility` | `5589505549cdd23d7eb91ac460c95f822538d805` | 0 | Already in main history |

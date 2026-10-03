# Cloud runtime integration follow-up

This inventory follows GitHub handoff `237056acaaa3c21684fd63772eaca119e2af5f3a`
(tree `3e21d1d39b5da1a63b608508edac2dfee772712a`). It supplements the older
[runtime readiness report](runtime-readiness.md); that report's missing-Docker
observation belongs to its earlier environment and must not describe this cloud
session. Database evidence is collected separately by `scripts/verify-postgres.mjs`.

## Repeatable offline inventory

Run from any working directory:

```sh
node /workspace/FlyReWheel/scripts/verify-runtime-readiness.mjs
```

The command reports HEAD/tree, executable presence, installed package versions,
presence-only environment flags and the checked-in gateway template's kind. It
uses filesystem reads and local `git rev-parse`; it does not initialize SDKs,
contact the Docker daemon, probe endpoints, read credential files, or allocate
resources. It does not print environment values, URLs or configuration bodies.
Its exit code `0` means inventory completed, not runtime ready. Missing binaries
are observations rather than errors. `--require-ready` emits the same report
and exits `78` because this offline tool cannot establish live readiness;
unsupported arguments exit `64`. The current filesystem may contain uncommitted
changes: the recorded HEAD/tree identifies the baseline, not all observed bytes.

## Concrete remaining integration work

| Boundary | Present implementation | Required real evidence |
| --- | --- | --- |
| Service bootstrap | `src/worker.ts` deliberately supplies no trusted application runtime/resolver; the service supports injected dependencies | A reviewed deployment bootstrap supplying the repository workspace resolver and OpenSandbox backend |
| Sandbox allocation | Official OpenSandbox SDK adapter, bounded transport, Sandcastle transfer and strict worker protocols | Available control plane, audited digest-pinned image, real checkout verification and isolation/quota checks |
| Lifecycle | `OpenSandboxLifecycleAuthority` interface and authored tests | Deployment implementation of admission fencing, late/unknown allocation reconciliation, whole-runtime stop, frozen out-of-band evidence and independent physical destruction verification |
| Request ingress | Adapter creates mode `0700` directory and uploads mode `0600` request; image reserves root-owned `0750` control parent | Trusted ownership/ingress yielding worker-readable but repository-unmodifiable input and protected supervisor/evidence storage |
| Model gateway | Strict credential-free image profile; committed template remains `blocked` | External authentication, exact host routing, enforced deny-default policy, bypass rejection and credential isolation |

Installing Docker or passing real PostgreSQL tests does not implement these
boundaries. In particular, replacing lifecycle receipts with API success flags
or granting repository descendants control-directory write access would not
satisfy the existing contracts. The offline inventory deliberately cannot turn
these gates green based on installed tools or declared configuration.

Reuse the existing official SDK, Sandcastle transfer, worker protocol and image
recipe. The next independent runtime milestone is a real image build and
credential-free blocked-profile/checkout smoke, followed by a deployment-specific
authority and protected ingress integration. Model authentication, credentials
and changes to runtime security remain separate authorization boundaries. Keep
the native worker and gateway profile blocked until those dependencies and live
evidence exist.

## Evidence classification

The inventory itself is **offline filesystem/process metadata**, not an
integration test. Image-recipe tests are **source-only assertions**. Existing
adapter tests use **authored transports/SDK executables**. Report PostgreSQL,
PGlite, actual container execution, actual gateway/model calls and actual
deployment as separate categories; none is implied by another.

At the 2026-10-03 check on the handoff baseline, Docker and runc executables
were present; podman, k3s, kubectl, runsc and host PostgreSQL executables were
absent from PATH. Installed package versions were OpenSandbox `1.1.0`,
Sandcastle `0.12.0`, Codex SDK `0.159.2`, pg `8.23.1` and pg-boss `12.35.0`.
This does not describe container contents or whether services are running.

Validation passed: Node syntax check; execution from `/tmp`; JSON parsing;
normal exit `0`; readiness-gate exit `78`; unsupported-argument exit `64`;
sentinel endpoint/database values absent from stdout/stderr; all live-check
flags false. The existing image-recipe suite also passed **9/9 source-only
tests** (`node --test deploy/workspace-worker/validate-recipe.mjs`). No image
was built in that initial offline check, and no gateway/model request was made.

## Actual Docker build attempt (2026-10-03)

A subsequent authorized attempt used the unmodified workspace-worker recipe
with output tag `flyrewheel-runtime-verify:237056a`. The official
`node:22-bookworm` pull resolved to
`node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7`,
and that immutable reference was passed as `WORKSPACE_WORKER_BASE_IMAGE`.
Image inspection reported amd64, no inherited volumes or ONBUILD commands,
and only PATH/Node/Yarn version environment entries. This limited inspection
is **not** a complete supply-chain/security audit or production base approval.

Two disposable **base-image** containers ran successfully with `--network none`,
`--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, no mounts
and no published ports. They established Node `22.23.3`, Git `2.39.5`, npm
`10.9.9` and CA-certificate file presence. Both were automatically removed.
This is actual container execution, but not execution of the FlyReWheel image.

The first build invocation could not create `/home/agent/.docker/buildx` on
the read-only filesystem. Setting only the build client's temporary state
directory with `BUILDX_CONFIG=/workspace/scratch/flyrewheel-buildx-237056a`
resolved that filesystem issue; no credentials or daemon/security settings
were changed. The recipe's `check-base` then passed. The actual application
build failed at Dockerfile line 13:

```text
npm ci --include=dev --include=optional --ignore-scripts --no-audit --no-fund
npm error Exit handler never called!
```

One unchanged retry reproduced the failure (first attempt 73.86 seconds at
this step; retry 79.83 seconds). Both exited `1`. The combined pull/build log
is `/workspace/scratch/runtime-build.log` in the selected cloud session.
The two original attempts did not surface npm's detailed log. A subsequent
diagnostic build used a temporary Dockerfile under `/tmp`, changing only that
RUN instruction to print relevant debug-log lines on failure and preserve its
nonzero exit. It used the same base, lockfile, context allowlist, build network
and permissions; the committed recipe was not changed. The detailed output
established repeated registry TLS verification failures:

```text
http fetch GET https://registry.npmjs.org/zod/-/zod-4.6.5.tgz attempt 1 failed with SELF_SIGNED_CERT_IN_CHAIN
```

The same error occurred across multiple dependencies (including TypeScript,
Vitest and yaml) and retries 1–3, followed by npm's generic exit-handler error.
The diagnostic attempt exited `1` after 80.80 seconds at this step. All 240
resolved dependency URLs in the lockfile use `registry.npmjs.org`. This
identifies a **build-environment TLS trust-chain blocker**, not evidence of a
missing architecture package or a need to change the lockfile. The identity
and provenance of the untrusted certificate chain were not inspected.

No `flyrewheel-runtime-verify:237056a` image was produced. Consequently the
planned real worker blocked-profile and exact-checkout smoke **did not run**.
A separate clean full-history checkout at the handoff SHA was prepared under
`/workspace/scratch/runtime-checkout-237056a` for that later smoke; preparing
it does not constitute runtime verification. No model/gateway requests,
privileged containers, host networking, socket mounts or PG-container changes
were made. The next prerequisite is an authorized, provenance-checked build
CA/trust configuration if retaining the online-in-container install. This attempt did not import a CA, disable TLS or npm
`strict-ssl`, switch to HTTP, change the registry, or use host networking.

## Authorized offline-cache build and session handoff

A subsequent authorized alternative retained the original trust policy: fetch
public locked dependencies using the host's already configured HTTPS route,
then install them offline inside the build. No host certificate or proxy
configuration was copied into the image. All build inputs were fixed to source
SHA `237056acaaa3c21684fd63772eaca119e2af5f3a`, even though the shared worktree's
HEAD advanced during the experiment.

The host install used a new private scratch directory containing only copies
of that revision's `package.json` and `package-lock.json`. Its child environment
contained PATH, a fresh HOME, distinct empty user/global npm configuration
files, and the existing host `NODE_EXTRA_CA_CERTS` path and HTTP(S) proxy /
NO_PROXY settings. Proxy URLs were checked to contain no username/password;
no npm tokens or other ambient credential variables were forwarded. Existing
host trust and proxy settings were neither modified nor copied into the cache.
An initial attempt omitting the proxy timed out; the existing configured route
then installed **161 packages in 12 seconds, exit 0** using:

```text
npm ci --cache <private-cache> --ignore-scripts --include=dev --include=optional --registry=https://registry.npmjs.org --no-audit --no-fund
```

Only `<private-cache>/_cacache` was copied into the build context as
`npm-cache/_cacache`. The host node_modules, logs, HOME, empty npm configuration
files, proxy environment and certificate path/content were excluded. The
context contained only package/lock/tsconfig, `src`, `deploy/tsconfig.build.json`,
the workspace-worker recipe inputs and the public cache. A Dockerfile-specific
allowlist retained the recipe's exclusions and admitted this cache.

The temporary recipe retained the original pinned base and all other commands,
with only these functional changes:

1. Insert `COPY npm-cache /build-cache` immediately before `npm ci`.
2. Append `--offline --cache /build-cache` to both `npm ci` and `npm prune`.

It was built with `docker build --network none`, the same verified base digest,
tag `flyrewheel-runtime-verify:237056a`, and the isolated BUILDX_CONFIG directory.
The build passed offline `npm ci` (161 packages), TypeScript compilation,
migration staging, Codex native-asset staging and offline pruning. The original
committed Dockerfile and lockfile remained unchanged. This workaround is a
separate build experiment, not a claim that the original online recipe now works.

Local reconstruction inputs are retained at
`/workspace/scratch/flyrewheel-offline-237056a-95GBtf/`; its `context/Dockerfile.offline`
and matching ignore file describe the temporary recipe. Combined logs remain
at `/workspace/scratch/runtime-build.log`. These are **session-local paths**,
not GitHub deliverables. A new session must reconstruct its own public cache
and build context using GitHub source and its authorized HTTPS route; it must
not assume these files, Docker layers or the local image exist there.

The offline build subsequently **failed** while copying node_modules into the
runtime stage (`Dockerfile.offline:36`), with `ResourceExhausted` / `no space left
on device`. No final image or final image digest exists. The host's 32 GiB root
filesystem filled; the Docker storage driver is `vfs`, and inode utilization
was only 39%. The build had 25 reclaimable cache records, created during this
task. Docker's logical cache sizes did not reflect sufficient capacity for the
multi-stage VFS copies. The install, compile and native-asset-stage successes
above remain valid intermediate results, not a successful image build.

Only this task's redundant host node_modules (703 MiB) and host cache copy were
removed; the public cache under `context/npm-cache`, recipe, source inputs and
logs were retained. That cleanup alone did not restore space. Cache IDs and
creation times were handed to the coordinator for bounded reclamation, with no
global Docker prune by this worker and no changes to PostgreSQL resources.
Ordinary shell execution resumed once space was recovered. Do not repeat this
multi-layer build on the constrained VFS filesystem without a capacity plan.

The planned actual worker blocked-profile / exact-checkout smoke remains
**not run**. No real worker execution, OpenSandbox lifecycle, protected request
ingress, gateway authentication or model inference is established by these
intermediate build checks. The public-cache route resolves the observed TLS
install blocker without changing trust; runtime image completion is separately
blocked by build-storage capacity.

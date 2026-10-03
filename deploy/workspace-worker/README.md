# OpenSandbox workspace-worker image recipe

This is a **build recipe**, not a published image or a verified deployment. It packages the fixed worker entrypoint used by the [OpenSandbox adapter](../../docs/opensandbox-workspace-adapter.md). The checked-in gateway profile is deliberately blocked. No image build, registry pull/push, live OpenSandbox/k3s run, gateway authentication, or model inference has been performed for this recipe.

The existing root `Dockerfile` and `deploy/base` worker are a different service. Do not substitute their account-authenticated image, credential mounts, or settings for this credential-free workspace worker.

## Immutable build inputs

An operator must supply `WORKSPACE_WORKER_BASE_IMAGE` as a real, independently verified image reference ending in `@sha256:` and 64 lowercase hexadecimal digits. There is no default tag and no invented example digest. The build rejects tag-only references. Digest syntax is only an input check; it does not establish registry provenance or safety.

Prepare and audit the base separately. It must provide:

- Linux amd64 or arm64 and Node **22** at the canonical regular path `/usr/local/bin/node`, with npm available during the build
- `/usr/bin/git`, `/usr/bin/env`, `/bin/sh`, `/bin/sleep`, standard file utilities, and `/etc/ssl/certs/ca-certificates.crt`
- Root-owned runtime executables and parent directories, interpreter libraries, and configuration that UID/GID 10001 cannot change
- No credentials, authentication caches, private npm configuration, credential helpers, project `.codex` configuration, inherited volumes, or `ONBUILD` commands; inspect inherited environment and all layers as well as the visible filesystem
- Runtime compatibility with the chosen OpenSandbox installation, including its execd integration; this recipe does not install or start execd

OS packages belong in the audited digest-pinned base. This Dockerfile does not run `apt`, download ad hoc executables, log in, or accept a secret build argument. Rebuilding the base requires a newly reviewed digest. The base's registry provenance, SBOM, vulnerability assessment, and admission policy remain operator responsibilities.

The application uses the committed `package-lock.json` through `npm ci --include=dev --include=optional --ignore-scripts`. The recipe checks exact Codex SDK and CLI **0.159.2** plus the platform-specific CLI lockfile integrity, then copies the native CLI's complete vendor directory. It retains the sibling helpers/resources and invokes the native executable directly. There is no global npm installation, `latest` version, or install at runtime. npm package integrity and a base digest do not by themselves prove bit-for-bit reproducible output or a trusted software supply chain.

The Dockerfile-specific `.dockerignore` admits only source/build inputs and these image files. It excludes local `node_modules`, `.git`, `.env*`, auth files, and `.codex`. The build does not copy the current checkout's compiled `dist` directory. Still review the admitted source and base for committed secrets before building.

## Build, after approval and input verification

Run from the repository root using a Docker/BuildKit version that supports Dockerfile-specific ignore files. Set both variables to operator-selected values; do not replace the base digest with a mutable tag.

```sh
: "${WORKSPACE_WORKER_BASE_IMAGE:?Set the audited base reference including its verified sha256 digest}"
: "${WORKSPACE_WORKER_IMAGE_TAG:?Set a local output image tag}"
docker build \
  --file deploy/workspace-worker/Dockerfile \
  --build-arg WORKSPACE_WORKER_BASE_IMAGE="$WORKSPACE_WORKER_BASE_IMAGE" \
  --tag "$WORKSPACE_WORKER_IMAGE_TAG" \
  .
```

The base must match the build's target architecture. Only Linux amd64 and arm64 are supported. To produce each target with a multi-platform builder, independently verify the selected base digest/platform and test the resulting platform image. The recipe checks the installed platform package rather than silently downloading a missing executable later.

The output still has its gateway disabled. A registry publication is a separate authorized step. Once the required deployment checks pass, record the built image's immutable registry digest and configure the adapter's `image` with that digest, never only the local output tag. Keep build provenance, source revision, lockfile, base digest and validation evidence with the resulting digest.

## Fixed image contract

| Item | Value |
| --- | --- |
| Runtime UID/GID | `10001:10001` |
| Worker command | `/opt/flyrewheel/bin/workspace-worker` |
| Compiled entrypoint | `/opt/flyrewheel/dist/workspace-worker-entrypoint.js` |
| Native CLI | `/opt/flyrewheel/codex/bin/codex` |
| Trusted config | `/opt/flyrewheel/workspace-worker.json` |
| Request | `/run/flyrewheel/request.json` |
| Checkout | `/workspace/repo` |

All application files, SDK dependencies, CLI assets, wrapper and config are root-owned and non-writable. The wrapper clears the inherited environment, sets a restrictive umask and uses the fixed Node/entrypoint paths. It passes arguments unchanged. It does no initialization, install, configuration writes, network calls, or credential lookup. A read-only root filesystem and externally enforced process/filesystem boundaries are still required; clearing the worker's environment does not establish that execd or other processes are credential-free.

The image default command is `/bin/sleep infinity`, matching the adapter's sandbox entrypoint. The adapter invokes:

```text
/opt/flyrewheel/bin/workspace-worker verify EXPECTED_SHA EXPECTED_BRANCH all-local-refs-v1
/opt/flyrewheel/bin/workspace-worker run /run/flyrewheel/request.json
```

The shipped config is exactly:

```json
{"schemaVersion":1,"gateway":{"kind":"blocked"}}
```

A deployment can only replace that profile through a reviewed, immutable image/config change after independently establishing the external authenticated gateway boundary. The accepted non-secret profile shape is:

```json
{"schemaVersion":1,"gateway":{"kind":"credential-isolated-gateway","baseUrl":"https://gateway.example.invalid/v1","allowedHost":"gateway.example.invalid"}}
```

That reserved `.invalid` hostname is illustrative, not a working gateway. No arbitrary headers, credentials, environment keys or job-selected provider configuration belong in the profile. A profile declaration does not certify gateway isolation or authorize enabling it. This recipe exposes no build argument that enables the gateway and keeps the blocked template checked in.

## Required self-hosted/k3s integration

The lifecycle authority must independently establish these properties before allocating a runnable workspace:

1. Verify the resulting immutable image, the actual UID/process layout, and the control-plane execution path. Set `runAsNonRoot`, UID/GID 10001, no privilege escalation, dropped capabilities, a read-only root filesystem and an appropriate seccomp/runtime isolation profile. Verify those controls in the actual OpenSandbox runtime; a generic manifest or image `USER` is insufficient.
2. Provision bounded writable checkout and temporary storage, while protecting request, policy, supervisor and evidence data against every repository/CLI descendant. Protect parent directories and mount replacement as well as file contents. Enforce CPU, memory, process and disk quotas; exclude host mounts, service-account tokens, credentials, metadata endpoints and host/container control sockets.
3. Reconcile the adapter's file API with that protected storage. The current adapter creates `/run/flyrewheel` with mode `0700` and uploads the request with mode `0600`. This image reserves the parent as root-owned `0750`, group 10001. A deployment must supply and verify a trusted ingress/ownership mechanism that yields a request readable by the worker but unmodifiable by repository descendants. For example, root/control-owned mode `0440` with a protected parent can serve the read side; the public adapter alone does not establish the necessary ownership transition. Do **not** solve an upload failure by giving the repository UID write access to the control directory.
4. Establish an authenticated credential-isolated HTTPS model gateway and real deny-default ingress/egress. Only its exact configured host may be reachable for model traffic. Test both allowed traffic and attempted bypasses, DNS/redirect behavior and direct API access. Credentials must remain outside the sandbox, including environment, filesystem, process arguments, logs and inherited execd state.
5. Implement allocation admission fencing, late/unknown-create reconciliation, whole-runtime stop verification, immutable frozen evidence, out-of-band bounded regular-file collection, and independently verified physical destruction. UID separation or a successful CLI exit does not prove this lifecycle contract. A missing or uncertain authority must continue to block allocation and retain the execution lease when cleanup is unverified.

The image alone cannot isolate a supervisor/request/evidence path from other same-UID processes. The existing in-process supervisor's temporary files and process-group checks are also not a replacement for the required external control boundary. The build recipe does not supply Kubernetes lifecycle authority, gateway authentication, a runtime storage controller, or frozen artifact collection.

## Verification status and release gate

Source-only checks for this recipe can run without Docker or network access:

```sh
node --test deploy/workspace-worker/validate-recipe.mjs
node --check deploy/workspace-worker/prepare-image.mjs
sh -n deploy/workspace-worker/workspace-worker
```

These check input validation, lockfile pins, config defaults and static recipe/wrapper contracts. They are **not container execution tests**. Also run the repository's typecheck, build, worker/adapter tests and full regression suite against the final source.

Before production, actually build and inspect the image, verify SDK/CLI assets and ownership as UID 10001, confirm the blocked profile refuses model execution, and exercise exact-SHA/branch/history/cleanliness and hostile-repository failures with the real image. Then independently test the gateway and all lifecycle/storage/network controls above in the chosen self-hosted deployment, including interrupted/late allocations and cleanup failures. None of those live image/deployment checks has been performed by adding this recipe. The adapter must remain fail-closed until they are satisfied.

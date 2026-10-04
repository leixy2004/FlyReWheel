# Bounded worker image: actual local container evidence, 2026-10-03

## Result and scope

The bounded single-stage recipe produced a real local image. The final no-model
ordinary-runc container smoke passed. No model was called, credentials copied,
authentication configured, network exposure added, registry image published, or
production lifecycle authority implemented. Source runtime files were unchanged.

Base PR #6 was fetched and verified at
`daa72fd7b6d423bd68032432fe7fef045b7a9560`, descending from checkpoint
`6266d29596a33fbc32013eaea5381d204d461a98`.
Two independent read-only subagents reviewed recipe/negative cases and security.

## Build provenance and capacity

- Official base: `node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7`;
  Linux amd64, Node 22.23.3. Inspection rejected inherited volumes/hooks and
  unexpected environment keys. This is limited inspection, not supply-chain certification.
- Actual build source: `596fd91f52f60e136cee943d2403a6b38202829e`.
- Final local image ID: `sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed`.
  This is a local image content ID, not a registry manifest digest.
- Image logical size: 1,720,090,143 bytes. Driver: VFS. Initial available root
  space: 32,034,594,816 bytes. No images/containers/cache existed initially.
- Fresh host install fetched 161 locked public packages in 6 seconds using the
  existing HTTPS route and clean npm configuration. Only public `_cacache`
  (231,903,720 content bytes) was exposed to the build; the 703 MiB temporary
  host install was deleted. No host node_modules entered the context.
- Build command used `--network none`, the dedicated allowlist, one RUN and a
  transient named cache bind. Install and prune were offline and scripts-disabled.
  Staging preserved native sibling helpers while removing the redundant package
  vendor copy. The final image has one native asset tree; generic npm CLI launch
  is intentionally not supported, only the fixed native worker path.
- Conservative admission estimate: 13,885,831,208 bytes plus 5 GiB reserve.
  A retry was actually refused before build at 19,182,886,912 free bytes.
  Only the first task-labeled broken image and its two identified inactive cache
  records (`ig49v448rf3jlp8ew7lipwaa7`, `ei6i5cpb55nf1ec3bglyvn3k2`) were reclaimed.
  No global prune, base-image removal, volume cleanup or other task mutation occurred.
- During the successful image's initial smoke, minimum observed root free space
  was 14,065,860,608 bytes. During the complete final smoke it was
  14,065,770,496 bytes (~13.10 GiB); scratch remained above 8.78 GiB.
  500 ms sampling with a 6 GiB cancellation threshold is a guard, not a hard quota.

## Real findings and corrections

1. First image built but its config inherited host mode 0600 and was unreadable
   to UID 10001. The bounded recipe now normalizes read/traverse bits while
   removing all application write bits. The corrected image passed real checks.
2. Independent review corrected the expected fixed JSON blocked error code,
   reconciled uncertain create outcomes using exact task name/label, isolated
   scratch cleanup in finally, and added signal cancellation.
3. Docker rejected `cp` into a container with read-only rootfs. The verifier now
   streams at most 16 MiB through stdin to UID-owned bounded tmpfs.
4. The first checkout smoke used a development branch rejected by the existing
   runtime branch policy. The verifier now creates `attempt/runtime--smoke` at
   the exact source SHA. Runtime validation was not weakened.
5. Only verifier/docs/tests changed after the successful build source. Reuse
   compared every allowlisted build input before testing the immutable image;
   no unnecessary third image build was performed.

## Checks and remaining limits

Passed actual checks: UID 10001; no network/host binds/published ports; read-only
root; root-owned non-writable worker/config/native/control parent; native CLI
startup; no duplicate native vendor/cache/dev TypeScript/source directory in the
visible application filesystem; compiled wrapper returns exit 78 and fixed
`WORKSPACE_WORKER_PRODUCTION_BLOCKED` with empty stdout; real full Git bundle
exact SHA and attempt branch; wrong SHA and dirty-tree refusal; observed stop
and removal of the exact task container.

The blocked profile returns before request-file inspection, so exit 78 does not
prove protected ingress. Same-UID supervisor protection, durable admission
fencing, frozen evidence, unknown-allocation reconciliation, verified physical
resource destruction, OpenSandbox execd, effective network policy and an isolated
authenticated gateway remain unimplemented/unverified production gates. A Docker
container removal observation does not satisfy that full lifecycle contract.

Focused checks: five new Vitest tests passed (including real cache-directory
rejection, capacity boundary and uncertain-create selection); nine existing
recipe tests passed; TypeScript typecheck and verifier syntax check passed.
No full test-suite repetition was needed because application/runtime source did
not change. Parent PR's existing effective-settings verifier was reused as
context, not duplicated or rerun as model evidence.

## CLI login observation, separate from image access

Official ambient CLI `0.159.0-alpha.3` and repo CLI `0.159.2` both returned
`Logged in using ChatGPT` from `login status`; installed SDK is `0.159.2`.
Commands succeeded with a read-only PATH-alias warning. No auth file/token
contents were inspected or copied and no login/model command was issued.
This establishes CLI-recognized host login and ChatGPT authentication type;
effective model provider, token freshness, quota, actual model access and
compatibility with the credential-free gateway remain unconfirmed. The worker
image does not inherit the host login.

## Original build/source association record

This run built the corrected image and passed the first three smoke checks, then
failed at Docker cp. Preserve its `failed` status; the following later run is the
complete passing evidence.

```json
{
  "task": "flyrewheel-bounded-e6dd78d0-818f-4413-b3ed-751820554013",
  "image": "flyrewheel-bounded-e6dd78d0-818f-4413-b3ed-751820554013:verify",
  "classification": "local-runc-no-model-not-production-isolation",
  "checks": [
    "nonroot-10001-network-none-readonly-no-host-binds",
    "immutable-assets-single-native-copy-native-cli-starts",
    "compiled-entrypoint-blocked-exit-78-no-output",
    "task-container-removal-observed"
  ],
  "reserveBytes": 5368709120,
  "sourceSha": "596fd91f52f60e136cee943d2403a6b38202829e",
  "driver": "vfs",
  "base": {
    "reference": "node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7",
    "id": "sha256:b37a4d56eedb5e42bca59c8d4782fa550e741fba5dbce943c53767d3ceee57e6",
    "size": 1131749125,
    "architecture": "amd64"
  },
  "estimatedBuildBytes": 13885831208,
  "imageId": "sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed",
  "imageBytes": 1720090143,
  "imageRetainedForInspection": "flyrewheel-bounded-e6dd78d0-818f-4413-b3ed-751820554013:verify",
  "status": "failed",
  "minimumObservedFreeBytes": 9436901376,
  "minimumRootFreeBytes": 14065860608,
  "minimumScratchFreeBytes": 9436901376,
  "buildCacheRetained": true
}
```

## Complete passing smoke record

```json
{
  "task": "flyrewheel-bounded-84c36d60-ea72-40f4-9a1e-70ff03606321",
  "image": "sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed",
  "classification": "local-runc-no-model-not-production-isolation",
  "checks": [
    "nonroot-10001-network-none-readonly-no-host-binds",
    "immutable-assets-single-native-copy-native-cli-starts",
    "compiled-entrypoint-blocked-exit-78-no-output",
    "real-git-bundle-exact-sha-wrong-sha-dirty-refusal",
    "actual-container-stop-observed",
    "task-container-removal-observed"
  ],
  "reserveBytes": 5368709120,
  "sourceSha": "fd19356229f8499ffa70bb06618174da74da7c5b",
  "driver": "vfs",
  "imageSourceSha": "596fd91f52f60e136cee943d2403a6b38202829e",
  "reusedImage": true,
  "imageId": "sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed",
  "imageBytes": 1720090143,
  "imageRetainedForInspection": "sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed",
  "runtimeBranch": "attempt/runtime--smoke",
  "status": "passed",
  "minimumObservedFreeBytes": 9436905472,
  "minimumRootFreeBytes": 14065770496,
  "minimumScratchFreeBytes": 9436905472,
  "buildCacheRetained": true
}
```

The image, public cache and remaining build cache are local inspection artifacts,
not cross-session deliverables. Reconstruct from GitHub source if they are absent.
No containers remain. The branch and this evidence are the transferable deliverables.

# Pinned offline rendering and official schema validation

Source manifests: PR #30 `6c2185c7eb47e3856fd86f5aeb56d8ba7f3aed5f`, stacked on
PR #24 `b3cb77a70ddc406eba2d521eda68a43016ab5100`. No manifest changes were needed.
The earlier two skips are preserved in PR30's historical report and closed here.

## Actual result

- Official **kubectl v1.34.1**, linux/amd64, embedded **Kustomize v5.7.1**:
  base rendered **10 resources**, single-node-dev rendered **19 resources**.
- Existing deployment contract suite: **14 passed, 0 skipped** using that binary.
- Native **openapi-schema-validator 0.6.3**: all 29 resource checks passed against
  official Kubernetes v1.34.1 OpenAPI 3.0 schemas at commit
  `93248f9ae092f571eb870b7664c534bfc7d00f03`. These are two profiles, not 29 unique
  resources to deploy together.
- Schema/negative suite: **9 passed, 0 skipped**, including malformed YAML redaction,
  stale receipt replacement, empty input, wrong types/required fields/int-or-string
  union, unknown GVK, hash tampering and remote-reference rejection.
- Independent review checked the actual rendered selectors, probe/service ports,
  PVC/mount references, command, merged database/S3 env and disabled model state.
  No concrete render or manifest defect was found.

[Receipt](receipt.json), [schema result](schema-result.json),
[base render](base.yaml), [dev render](single-node-dev.yaml).

## Provenance and installation

[Official kubectl installation instructions](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)
identify the release binary and SHA-256 endpoint. Both were fetched over verified
HTTPS from `dl.k8s.io/release/v1.34.1/bin/linux/amd64/`; the binary was executed only
after its hash matched:

`7721f265e18709862655affba5343e85e1980639395d5754473dafaadcaa69e3`

The official GitHub v1.34.1 annotated tag was peeled to the commit above, matching
kubectl's reported build commit. Three schemas (`api__v1`, `apis__apps__v1`, and
`apis__networking.k8s.io__v1`) were fetched from that immutable commit under
[api/openapi-spec/v3](https://github.com/kubernetes/kubernetes/tree/93248f9ae092f571eb870b7664c534bfc7d00f03/api/openapi-spec/v3).
Each matches both its official Git blob SHA-1 and the recorded SHA-256.

All exact tool URLs, file sizes, schema hashes and the complete ten-wheel Python
closure are in [pins](../../../deploy/kubernetes-validation-pins.json).
Wheels came from official PyPI release metadata and `files.pythonhosted.org`, were
checked against their release SHA-256, then installed with `--no-index`,
`--only-binary=:all:` and `--require-hashes` using the
[lock](../../../deploy/kubernetes-validation-requirements.txt). No source builds
or third-party install scripts ran. The lock covers this Linux amd64/Python 3.12
platform; the actual interpreter was Python 3.12.14. A venv without system packages
plus an isolated target directory excluded ambient optional validation plugins.
Only project scratch paths were used; no global executable or CA store changed.
Verified unique binary/schema/wheel artifacts total **65,392,689 bytes**; this is
not a billed-cost estimate or the complete network-transfer count.

One preparation attempt used `pip download` in a cleared environment and failed
with **`[Errno 101] Network is unreachable`**. No pass was inferred. The same official
PyPI wheels were then downloaded using curl with the existing environment, hashed,
and installed entirely offline. No proxy value was inspected or persisted, and no
proxy, TLS or network setting was changed.

## Reproduction after verified cache preparation

`TOOLS` below is the local cache containing the verified `kubectl`, three original
`*_openapi.json` files, isolated venv and hash-locked packages. It is not a kubeconfig.
The repository's existing Node dependencies are required for project contract tests.

```sh
TOOLS=/workspace/scratch/flyrewheel-kube-tools
env -i PATH=/usr/bin:/bin KUBECONFIG=/nonexistent/flyrewheel-offline \
  "$TOOLS/kubectl" kustomize deploy/base > "$TOOLS/base.yaml"
env -i PATH=/usr/bin:/bin KUBECONFIG=/nonexistent/flyrewheel-offline \
  "$TOOLS/kubectl" kustomize deploy/overlays/single-node-dev > "$TOOLS/single-node-dev.yaml"
PATH="$TOOLS:$PATH" npx vitest run tests/deployment-contract.test.ts --maxWorkers=2
node deploy/validate.mjs --rendered base "$TOOLS/base.yaml"
node deploy/validate.mjs --rendered single-node-dev "$TOOLS/single-node-dev.yaml"
PYTHONPATH="$TOOLS/python-isolated" "$TOOLS/venv/bin/python" -B \
  deploy/validate-kubernetes.py --schema-dir "$TOOLS" --output "$TOOLS/schema-result.json" \
  "$TOOLS/base.yaml" "$TOOLS/single-node-dev.yaml"
PYTHONPATH="$TOOLS/python-isolated" "$TOOLS/venv/bin/python" -B \
  tests/test_kubernetes_schema.py "$TOOLS"
```

Schema loading verifies hashes before use and refuses external references. The
validator registry also has no remote retrieval fallback. It selects schemas by
exact apiVersion/kind while retaining their complete local components. It enables
the native format checker. `int-or-string` has no format checker, but the official
`oneOf(integer,string)` is enforced and its boolean rejection is tested.

## What this does not prove

Official OpenAPI schemas do not generally reject unknown fields and do not encode
all Kubernetes semantic constraints. Kubernetes-specific extensions, API defaulting,
server validation, admission, installed CRDs, storage provisioning, image behavior,
NetworkPolicy enforcement and cluster-version compatibility were not exercised.
Pinning v1.34.1 is a reproducible validation target, not a recommendation to deploy
an old release or a claim about the user's cluster version. Match the target
cluster's schema/version before an eventual deployment.

There was no cluster connection, apply, deployment, credential access/change,
security-policy change, image/container execution or model call. The application
runtime remains blocked; the separate real sandbox retry still awaits authorization.

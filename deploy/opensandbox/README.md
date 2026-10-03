# Pinned local OpenSandbox hardening

This is a **local modification**, not an upstream release or official deployment
receipt. Upstream commit and original/patched file SHA-256 are in
`upstream-pin.json`. Apply `execd-never-start.patch` only to that exact checkout;
verify original SHA, `git apply --check`, apply, and verify patched SHA before use.

The patch removes helper `start()`/`reload()` and gives the archive-only helper
network none, drop ALL, no-new-privileges and read-only root. Docker archive reads
work on unstarted containers. Platform selection, cache keys, lock, archive paths,
optional missing-asset handling and final removal remain upstream behavior.

The fixed official execd image was independently exercised using Docker's archive
API via `docker cp`, with no process started; all five assets were present.
See [actual receipt](../../docs/evidence/execd-metadata-2026-10-03/stopped-container-receipt.json).
This supports the fixed image only: custom images requiring startup-generated
files are not covered. No image executable or bwrap capability was exercised.

`python3 scripts/verify-stopped-execd.py` is dry-run. Its explicit `--execute`
mode pulls the fixed digest only if absent, creates one restricted labeled
container, inspects never-started state, streams bounded archives, then removes
the exact owned container and newly pulled image. This mode was authorized for
the recorded experiment; it is not authorization for a control plane or models.

The patch does not provide durable allocation reconciliation or fix every upstream
cleanup race. The surrounding executor must retain exact ownership and report
uncertain daemon operations/removal failures. Neither archive success nor a local
patch establishes production lifecycle or model/runtime readiness.

# Prepared environment — awaiting API-key/TLS/startup approval

**Later outcome:** approval was received and one actual SDK allocation was attempted.
TLS/auth passed, readiness timed out, and all live resources were independently
verified removed. See [the live evidence](evidence/opensandbox-live-2026-10-03/README.md).
The pending/next-step language below records the earlier preparation stage.

No API key, certificate, listening service or model request was created. The
previous helper asset test was not repeated. This preparation is distinct from
an actual OpenSandbox server or SDK lifecycle receipt.

## Fixed inputs and bounded installation

- Source: `/workspace/scratch/flyrewheel-control-prep/source`, sparse checkout of
  official commit `c7dc78a4090e5de2b9119e9bd93952cae24f87bd`. Only the previously
  reviewed never-started-helper patch differs from upstream; patched runtime SHA
  is `6b2037ccb1be25b0c3fb8e7a1de56d4e84030326250b1d81c208e3675a8142db`.
- Venv: `/workspace/scratch/flyrewheel-control-prep/venv`, Python 3.13.5, outside the
  checkout. Public cache: sibling `cache` directory. Existing host uv cache was
  only 4 KiB; host pip cache was unavailable. No node_modules or credentials copied.
- Used upstream `server/uv.lock` unchanged (SHA-256
  `c8b44e17239af530ae935ce5a19468ac32147f37faa67e0e8ab92828c8f070d7`). Exported production
  dependencies with `uv export --frozen --no-dev --no-emit-project`; committed
  [requirements and installed package list](evidence/opensandbox-preparation-2026-10-03/).
- Installed 49 packages with `uv pip install --require-hashes --only-binary :all:
  --no-deps --link-mode hardlink --index-url https://pypi.org/simple` from those
  exact requirements, using ordinary verified TLS and no new credentials. No
  project/editable installation or source build backend/hook ran. Source is used
  through the explicit PYTHONPATH only when performing the approved safe imports.
- Preparation guard: 1 GiB task-tree logical-byte threshold, 180 seconds per
  preparation operation, free-space stop at 6 GiB, sampled every 500 ms. The
  corrected wheel install completed in 1.54 seconds; minimum sampled free space
  was 17,624,887,296 bytes. The first invocation was rejected by uv because
  `--no-build` and `--only-binary` are mutually exclusive; no installation occurred
  on that rejected invocation. The successful invocation used wheel-only.
- Recorded unique allocated bytes (counting hardlinks once): **123,228,160**;
  summed file logical sizes including hardlinks: **212,545,952**. Both remain
  below 1 GiB. The directory is retained for the authorized future trial. Hardlink
  sharing avoids duplicate package copies; do not mutate files in the venv/cache.
  These measurements and thresholds are not a hard filesystem quota.

[Preparation receipt](evidence/opensandbox-preparation-2026-10-03/preparation-receipt.json).

## Compatibility and error-path checks completed

`uv pip check` reports all 49 installed packages compatible. Independently reviewed
safe imports succeeded for `opensandbox_server`, `constants`, `config`, `api.schema`
and `startup_guard`. No call to `load_config`, `get_config`, service factories or
startup guards was made. In particular, `main`, `api.lifecycle` and `services.*`
were excluded: lifecycle imports can create service objects and background work.

The **full official AppConfig** accepted the generated TOML with a plainly named
nonsensitive fixture string, including the corrected 49000..49100 allocation pool
and local proxy routing. The official `CreateSandboxRequest` accepted the SDK
1.1.0 wire-field fixture with 300-second TTL, CPU 1, memory 512Mi, empty volumes and
no network policy/credential proxy. The SDK module itself imported successfully;
no client was constructed and no API request was issued. This is static field and
import compatibility, not end-to-end wire/startup/TLS compatibility.
[Import/schema receipt](evidence/opensandbox-preparation-2026-10-03/import-check.json).

The official request schema requires TTL >=60 seconds; the local plan validator
now enforces 60..300 and rejects 59. Eight plan/health tests and eight supervisor
fixture/inert-process tests pass. They cover real TCP error paths, fake credential
file mode, deadline/parent EOF, low disk and incomplete stop/listener cleanup;
they do not create real API/TLS material or claim a permission receipt.

## Commands retained for after explicit approval — not executed

The image was deliberately removed after the earlier archive test; it must be
loaded again by exact digest for a real trial. Do not repeat the asset extraction
or rebuild a worker image. Apply the same capacity guard to that bounded pull.
The control-plane startup command is:

```bash
python3 -B scripts/opensandbox-control-plane.py --execute \
  --approval-ref EXPLICIT_PARENT_FORWARDED_USER_APPROVAL \
  --source /workspace/scratch/flyrewheel-control-prep/source \
  --python /workspace/scratch/flyrewheel-control-prep/venv/bin/python \
  --execd-image opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a \
  --dedicated-daemon
```

The approval reference is audit context, not permission by itself. Until the
parent explicitly forwards approval, run only the default dry-run. Startup remains
blocked by that authorization, not by dependency availability. No request was sent
to the user again from this environment.

The executor reports task directory and loopback port without secret values. A
subsequent approved SDK driver must load the task key locally, use only the public
certificate for scoped verified TLS, allocate at most one 300-second sandbox,
execute the fixed no-model command and verify stop/delete/late-allocation cleanup.
The current executor manages the control-plane process only. Those lifecycle
requests and a successful server health/authentication check remain unperformed.

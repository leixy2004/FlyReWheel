# W0 Ruff permission diagnosis and bounded recheck

PR 3031 now has a real paired tool check: Ruff 0.1.6 on the fixed before tree and
0.1.9 on the fixed after tree both return 0 for the official `ruff format httpx tests
--diff` and `ruff check httpx tests` commands. Each formatting check covers 60 files.
This establishes availability for one chosen W0 tooling pair, not defect repair,
semantic labels, model mining yield or general CI compatibility. The original PR #23
failures and its historical ledger are unchanged.

## Root cause and correction

Read-only wheel inspection established executable mode 0755, amd64 ELF and interpreter
`/lib64/ld-linux-x86-64.so.2`. A metadata-only diagnostic container then reproduced the
original tmpfs options. Its effective `/proc/self/mountinfo` shows `/tmp noexec`.
The hash-locked installed Ruff file has the correct bytes, mode 0755 and owner UID
65534; parent traversal and interpreter access succeed, but binary X_OK is false.
No Ruff process was executed in that diagnostic. The old container was already
removed, so this is a controlled reproduction supporting the explanation, not a
retroactive inspection of the deleted container.

The correction changes only tool packaging. The local Dockerfile starts from the
already present immutable official Python image ID and copies two verified wheel
ELFs, mode 0555, into `/opt/ruff/before` and `/opt/ruff/after`. Base and derived image
ONBUILD are empty. There is no RUN, remote ADD, source build, dependency download,
image pull or dynamic-loader bypass. Runtime `/tmp` explicitly remains noexec.

Both executions retain UID 65534, network-none, read-only root/source/harness,
cap-drop ALL, no-new-privileges, one CPU, 512 MiB memory, 64 PIDs, a 128 MiB tmpfs,
60-second command and 120-second container deadlines. No credential or host socket
mount exists. Each source staging tree is independently hash-checked against all
114 fixed export files before and after commands. Both tests and the diagnosis
container have been removed. The local Docker image footprint is 169.3 MB after the
COPY-only build; no containers, volumes or build cache remain.

Read individual command records in result-before.json and result-after.json.
The harness/container exit status denotes completion of the recording process;
it does not aggregate nonzero Ruff findings. All six recorded commands (including
version queries) were independently checked and returned zero in this run.

## Documentation dependency

Official PyPI metadata says mkautodoc 0.2.0 is not yanked and provides exactly one
4827-byte sdist, no wheel. The exact SHA256-verified archive was inspected in memory,
without extraction or execution. It uses legacy setuptools setup.py, declares
Markdown, and has no observed custom build hooks. Nevertheless setup.py is executable
Python, and its build backend/transitive dependency versions are not frozen and
validated in this stage. No build or installation was attempted. PR 3035 documentation
behavior remains unknown; PR 3036 action behavior also remains unknown. Static
workflow checks remain static evidence.

## Code and reproduction

- scripts/diagnose-w0-ruff.py: one metadata-only container, frozen offline wheel input.
- scripts/w0-readonly-ruff-check.py: hash and isolation checks plus only the declared
  Ruff commands, with per-command output flushed immediately.
- scripts/rerun-w0-ruff.py: two exclusive before/after attempts, fixed image ID at
  container creation, security inspection and cleanup.
- Dockerfile, binary-metadata.json and image-build.log bind the exact local tool image.
- diagnosis.json, result-*.json and mkautodoc-static-audit.json preserve raw evidence.

The published plan predates execution. All scripts use exclusive attempt paths and
are records/reproducers for this finite stage, not automatic retry loops. Building
requires the existing base image and the exact two wheel ELF members in a new local
build directory, checked against binary-metadata.json and chmod 0555 before COPY:

```sh
DOCKER_BUILDKIT=0 docker build --pull=false --network=none --no-cache \
  --tag flyrewheel-w0-ruff-tools:local --file BUILD_DIRECTORY/Dockerfile BUILD_DIRECTORY
```

No new HTTPX API/Git reads, sample changes, model calls or human labels occurred.
API acquisition stays 48/50. The sole new external inspection was the official PyPI
mkautodoc metadata and hash-verified sdist; it is not charged as HTTPX acquisition.
Both native agents independently reviewed source hashes, image layers, isolation,
command results and remaining unknowns.

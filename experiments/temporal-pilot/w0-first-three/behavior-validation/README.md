# W0 tool behavior and input availability

No paired upstream behavior result was obtained. The original samples remain
unchanged. The retained results are availability evidence, not defect labels,
model mining outcomes or evidence that the tool upgrades pass/fail.

| PR | Before | After | Interpretation |
|---|---|---|---|
| 3035 | docs dependencies unavailable | docs dependencies unavailable | `mkautodoc==0.2.0` has no matching wheel under this frozen selector; no docs build ran |
| 3031 | container permission failure before Ruff execution | not run after stage stopped | no lint or formatting result, compatibility unknown |
| 3036 | workflow syntax/ref checks pass | workflow syntax/ref checks pass | setup-python implementation is outside this tree; action behavior unknown |

The official `scripts/check` contains `ruff format httpx tests --diff` and
`ruff check httpx tests`. The official `scripts/build` contains `mkdocs build`.
These are the direct checks selected instead of unrelated pytest suites. Docs would
also require complete locked HTTPX runtime dependencies because mkautodoc imports
HTTPX; the dependency failure occurred before any build or imports. We did not fall
back to sdists, editable installs, alternative indexes or install/build hooks.

## Execution evidence

The initial plan was pushed in 9354b04 and exact official commands corrected in
f38cdc5 before image/dependency acquisition. Docker had no cached images. One
Docker Official Python image was pulled and pinned by image ID and registry digest
(see ledger). No image build was performed. Pip downloaded only public PyPI wheels;
actual names, sizes and SHA-256 hashes are in dependency-acquisition.json and the
Ruff lock files. No mutable tag was used for container creation.

The first non-root container could not read the assistant-owned harness because
its staging directory/file modes were 0700/0600. Original output is preserved in
container-results.json. A single staging-readability correction was declared and
pushed in 1f4a69d, without changing source, assertions or isolation. In the second
container, the harness passed all 114 source SHA-256 comparisons and proceeded past
the hash-checked offline pip installation, then Python received PermissionError 13
when starting `/tmp/deps/bin/ruff` for `--version`. No Ruff process output was
obtained. The reason for that denial beyond the observed error is not established;
it must not be asserted to be a proven noexec mount or tool incompatibility.

The harness buffered its intermediate output, so the final traceback—not a complete
pip installation log—is the retained original output. Reaching the Ruff launch
implies the earlier harness checks returned successfully; it does not provide an
independently recorded installed distribution inventory. Both acquired wheels are
hashed, but the after version was never installed or executed.

Both containers retained uid 65534, network none, read-only root/source/wheels/
harness mounts, no added capabilities, no-new-privileges, one CPU, 512 MiB memory,
64 PIDs and 128 MiB tmpfs. No credentials or host socket were mounted. Both were
removed, leaving zero containers, volumes or build cache. The local image occupies
133.2 MB. These were ordinary Unix permission failures, not additional-authorization
prompts or automatic approval-review rejections. No subsequent execution retry or
isolation/certificate weakening occurred.

## Offline deliverables

input-quality.json rederives all three complete-repository mining templates using
the existing pure builder. Eight cases remain unknown. Both fixed workflow files
parse and bind exactly to setup-python v4 before/v5 after. The templates remain
non-executable until their cleaned probe workspaces are rederived. No model or action
runtime is invoked and no semantic oracle is introduced.

```sh
node --import tsx scripts/check-w0-behavior-inputs.ts /tmp/new-w0-input-quality.json
npx vitest run tests/w0-behavior-inputs.test.ts tests/w0-materialization.test.ts --maxWorkers=1
npx tsc --noEmit
```

scripts/run-w0-behavior.py records the bounded attempt with exclusive staging paths;
it refuses reuse of those paths and is not an automatic retry command. Re-running
containers requires a new declared attempt and investigation of the recorded execution
permission failure while retaining the same isolation. No further HTTPX API/Git reads
were made; its API ledger remains 48/50. Image/PyPI traffic is separately acknowledged,
with wire bytes/request counts uninstrumented rather than claimed zero.

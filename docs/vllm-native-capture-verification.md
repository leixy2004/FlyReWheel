# Fixed vLLM native capture verification — 2026-10-13

**Outcome: genuine bounded Git acquisition succeeded; the unchanged native CLI
capture was blocked by its existing complete-history requirement.** No native
snapshot or database was created, and no downstream flow is attributed to native
capture. This is an evidence-only change, not a product fix or a relaxed contract.

Tested FlyReWheel commit: `0edff99f5c502877c3f651c47e312fc02fbf041e`.
Official remote: `https://github.com/vllm-project/vllm.git`.

## Actual acquisition and object verification

No existing native vLLM Git object store was present in the previous sample's
artifact directory. A new bare store was initialized at
`/tmp/flyrewheel-vllm-native/official.git`. Public objects were fetched with:

```sh
git -c credential.helper= -c core.hooksPath=/dev/null -c protocol.file.allow=never \
  -C /tmp/flyrewheel-vllm-native/official.git fetch \
  --depth=2 --filter=blob:none --no-tags https://github.com/vllm-project/vllm.git \
  953d9c820b0d8f9a55ee455814287536a498498c
```

Fetch exited 0. User/system Git configuration was disabled, authentication prompts
and credential helpers were disabled, and no worktree checkout or target code
execution occurred. Only the two requested generations were fetched. The existing
18 official source blobs from the preceding fixed sample were installed using
`git hash-object -w --stdin` after checking their SHA-256. Every resulting blob ID
matched the previously verified official Git blob SHA and was read back unchanged.
This created no commits, replacement objects, grafts or invented ancestry.

The original commit payloads were obtained with `git cat-file commit`; recomputing
`SHA1("commit <length>\0" + payload)` verified each exact original object ID:

| Commit | Bytes | Original parent header |
| --- | ---: | --- |
| `953d9c820b0d8f9a55ee455814287536a498498c` | 1165 | `33b06a6f24be632e99c19cadb5004a27cf9605a0` |
| `33b06a6f24be632e99c19cadb5004a27cf9605a0` | 1151 | `5c2b5cb422182ae2a0c22a17532d465174396613` |

The third SHA is an original parent header, **not a downloaded commit**. Local
object inventory contains exactly 2 commit, 400 tree and 18 blob objects. Git
reported 141 KiB of packed objects and 80 KiB of loose-object disk use. No earlier
commit history was traversed or downloaded. Partial/shallow repository metadata
was retained verbatim; it was never deleted to bypass capture validation.

Git's actual `merge-base --all` for the pinned parent/head returned the parent.
Its actual raw recursive `diff-tree` returned 9 modified files. Every path,
old/new mode and full old/new blob SHA matched the prior official API/.diff sample,
including executable mode `100755` for `tools/pre_commit/mypy.py`. The other eight
paths retained `100644`. All 18 changed-file blobs were available locally, but this
does not make the remaining repository blobs or ancestry complete.

## Actual production CLI result

With network/lazy object fetching disabled for verification, the existing compiled
entry was invoked exactly as follows:

```sh
node dist/cli.js snapshots capture \
  --repo /tmp/flyrewheel-vllm-native/official.git \
  --repository-id github.com/vllm-project/vllm \
  --base-tip 33b06a6f24be632e99c19cadb5004a27cf9605a0 \
  --head 953d9c820b0d8f9a55ee455814287536a498498c \
  --db /tmp/flyrewheel-vllm-native/capture-db \
  --out /tmp/flyrewheel-vllm-native/captured.json
```

Exit code: **1**. Exact stderr:

```text
FlyReWheel: Snapshot capture requires complete local commit history
```

`captured.json` and `capture-db` both remained absent. The native capture attempt
was **blocked**, not passed. The surrounding verification successfully asserted
that this is the actual behavior and that no success artifact was produced.

`src/git-evidence-repository.ts` checks shallow status before reading the diff and
also rejects partial/promisor configuration. This store is truthfully shallow at
`33b06a6f24be632e99c19cadb5004a27cf9605a0` and retains its public remote's
`promisor=true` / `partialclonefilter=blob:none` configuration. Although the direct
parent/head and complete changed-file diff are genuine and available, the current
entry has no bounded direct-parent exception. Network/object transport is **not**
the blocker; the input contract is.

Fetching complete nonpartial history would exceed this task's bounded-history
scope. Removing shallow/promisor markers, replacing a parent, synthesizing a root,
or using the prior imported snapshot as if capture produced it would misstate the
evidence and was not attempted. Supporting bounded direct-parent capture would
require a separately designed contract change; this task does not make that change.

## Independent capture contract checks

The existing checks were run in fresh authored test repositories, independently of
the real vLLM object store:

```sh
npm test -- tests/git-evidence.test.ts tests/change-snapshot.test.ts \
  tests/change-snapshot.cli.test.ts --reporter=json \
  --outputFile=/tmp/flyrewheel-vllm-native/contract-tests.json
```

**10 passed, 0 failed, 0 skipped, 0 todo**, across 3 files. These cover bounded
capture/CLI behavior and rejection of incomplete or manipulated history; they do
not turn the blocked vLLM sample into a capture success. No production source,
packaged migration or test file was changed. The refusal is consistent with the
existing explicit contract, so no compatibility defect was patched.

[Full acquisition commands, object identities, nine-file diff, CLI stderr and test counts](evidence/vllm-953d9c8-native-capture-2026-10-13.json)
are committed. Original object store, raw diff, scripts and test JSON are retained
under `/tmp/flyrewheel-vllm-native`. The prior
[import-path compatibility result](vllm-fixed-cli-compatibility.md) remains separate
historical evidence; its successful review chain is not counted as native capture.

No vLLM modules, tests or build tools were run or installed. No model calls,
credential access, W1 reads, frozen research protocol changes, push, deployment,
publication or external comments occurred.

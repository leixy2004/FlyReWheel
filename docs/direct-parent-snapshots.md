# Verified direct-parent snapshots

`snapshots capture-direct-parent` captures a fixed original parent/child commit pair from a local Git object store, including a shallow or promisor store. It makes no claim about complete history, PR ancestry, historical visibility, source-provider identity, or semantic quality. The existing `snapshots capture` interface and its complete-history/partial-clone gates are unchanged.

```sh
node dist/cli.js snapshots capture-direct-parent \
  --repo /path/to/original.git --repository-id github.com/owner/repository \
  --parent <40-character-parent-sha> --head <40-character-child-sha> \
  --db /path/to/local-db --out /path/to/snapshot.json
```

The head must have exactly one original parent, matching `--parent`. Merge commits are deliberately unsupported. Both original commit objects and every subtree reachable from their root trees must be present and pass Git object hash verification. The parent's own ancestors need not be available. The reader never removes shallow/promisor markers, grafts ancestry, downloads missing objects, checks out files, executes repository code, or invokes a model. Nonempty graft files are rejected; replacement objects and all Git transports are disabled by the bounded process runner.

The complete direct tree diff uses the existing exact-content rename policy. Every present changed side must be an available regular UTF-8 blob whose bytes and object identity verify. Binary files, symlinks, gitlinks, unsupported modes, excluded bytes, missing objects, corruption, or exceeded limits fail the entire capture before database creation. Unchanged blobs are not required. Tree verification is bounded to 5,000 unique trees, 16MiB total tree bytes, 1.5MB per object-command output, and the shared 120-second aggregate deadline; normal snapshot limits still apply.

## Persisted scope and downstream boundary

The existing snapshot envelope gains an explicit `comparison: "direct-parent-to-head"` and required `evidenceScope: "verified-direct-parent-only"`. `baseTip` and the legacy `mergeBase` field both hold the verified direct parent; the latter is not an independently computed merge-base assertion in this mode. Schema validation requires those fields to match and zero excluded sides. The scope marker is part of the snapshot digest, survives storage/export/import, and appears in snapshot lists. Existing merge-base packages retain their old shape and hashes.

Capture returns `local-direct-parent-check`. Imported and reopened packages return `package-integrity-only`; imports never adopt a file's verification receipt. As with existing snapshots, declarations in imported packages are not authentication.

Local structural/offline review, feedback, revision comparison and governed offline execution accept these snapshots and retain their exact digest bindings. GitHub PR evidence, frozen paired-evaluation datasets and evaluation workspace recapture reject the limited scope. Configured model adapters still require their existing merge-base recapture match; this feature does not authorize or implement model execution against partial stores. No frozen research protocol or dataset is migrated.

## Real-input compatibility verification, 2026-10-13

The official vLLM original object store from the [prior native verification](vllm-native-capture-verification.md) was reused without history fabrication:

- Parent: `33b06a6f24be632e99c19cadb5004a27cf9605a0`
- Head: `953d9c820b0d8f9a55ee455814287536a498498c`
- Native capture: 9 changes, 18 captured sides, 131,744 bytes, no exclusions.
- Captured path/mode/blob/byte records exactly matched the separately downloaded official GitHub source records.
- Original shallow marker remained unchanged; legacy capture still failed on incomplete history.
- 30 successful compiled CLI calls covered native capture, import/list/reopen, review, feedback, a manually authored rule revision, comparison, explicit fixture decision, governed follow-up review, idempotent restart, and JSON/CSV export.

Only `vllm/utils/network_utils.py` was in the authored review rule's scope; the other eight changed paths were explicitly out of scope. Source bytes and Git identities are real. Rules, judgments, feedback, revision and acceptance are authored offline compatibility fixtures. No model or vLLM code ran; this is not empirical evidence of mining quality, defect detection, real developer feedback, or rule improvement.

The reproducible local driver is [verify-vllm-direct-parent.mjs](../scripts/verify-vllm-direct-parent.mjs). It requires the previously verified public GitHub source directory, the original bare Git store, and a new output directory:

```sh
node scripts/verify-vllm-direct-parent.mjs \
  /tmp/flyrewheel-vllm-compat /tmp/flyrewheel-vllm-native/official.git \
  /tmp/flyrewheel-direct-parent-flow
```

The committed [verification record](evidence/vllm-direct-parent-2026-10-13.json) contains command/output digests and exact artifact bindings. Full local outputs are under `/tmp/flyrewheel-direct-parent-flow`. Prior import-only and blocked-native reports remain historical records.

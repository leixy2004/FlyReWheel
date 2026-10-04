# execd metadata-only capacity investigation

No layer payload was fetched, image pulled, container created, control plane
started or API/TLS key generated. Only public official registry index, amd64
manifest and config were retrieved (8,289 total body bytes). Anonymous registry
pull authorization was held in process memory, not printed or persisted. The
manifest and config SHA-256 were verified against their parent descriptors.
Public response bodies and sanitized facts are in [the metadata directory](execd-metadata-2026-10-03/).

## Fixed image and observed limits

Official example at OpenSandbox `c7dc78a4090e5de2b9119e9bd93952cae24f87bd`
selects `opensandbox/execd:v1.1.0`. At this observation:

- Index: `sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2`.
- Linux/amd64 manifest: `sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a`.
- Pin for the experiment: `opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a`.
- Config: `sha256:e12d3de4b28e820bc966fe875484b35a5fad9322c4ef8a5b6751873da03bd214`.
- 13 gzip layers, total compressed bytes **60,314,718** (57.52 MiB).
- Config rootfs contains only `type` and 13 `diff_ids`; no uncompressed sizes.
  Layer descriptors have media type, digest and compressed blob size, with no
  expanded-size annotations. History does not establish filesystem allocation.

OCI descriptor size describes the referenced blob; for these gzip layers that is
compressed data. Diff IDs identify uncompressed content by hash, not size. Thus
neither config nor manifest reliably supplies expanded size. Compression-ratio
multipliers and gzip trailer sizes are not a capacity proof.
[OCI descriptors](https://github.com/opencontainers/image-spec/blob/v1.1.1/descriptor.md),
[OCI image configuration](https://github.com/opencontainers/image-spec/blob/v1.1.1/config.md).

## VFS estimate and conditional feasibility

Current driver is VFS on x86_64. Root available: **17,735,565,312 bytes
(16.518 GiB)**; tmp available: 9,431,109,632 bytes. Preserve 5 GiB plus 1 GiB
reaction margin, leaving **10.518 GiB** for additional work. VFS deep-copies parent
filesystems for each layer and the container, so final image size alone is
insufficient. No layer reuse with the retained worker is evident from diff IDs.
[Docker VFS behavior](https://docs.docker.com/engine/storage/drivers/vfs-driver/).

Illustrative conservative admission arithmetic (still requires measurement):

| Component | Planning amount |
| --- | ---: |
| Existing worker container copy | 1,720,090,143 bytes |
| execd compressed blobs | 60,314,718 bytes |
| Python environment/cache allowance | 1 GiB |
| Scratch | 128 MiB |
| Filesystem metadata/other contingency | 1 GiB |
| Fixed subtotal | 3.783 GiB |

Let U bound aggregate expanded layer payload/logical allocation, with archive
members, sparse files, entry counts and allocation overhead separately checked.
Thirteen layer snapshots plus helper are at most roughly 14 U before overhead;
allow **16 U** provisionally to cover another import/extraction copy and injected
archive assets. This is a planning bound, not a Docker-enforced quota. For measured
U at most 256 MiB, the estimate is **7.783 GiB** additional, below the proposed
8 GiB envelope; approximately 8.734 GiB would remain (2.734 GiB above the 6 GiB
reserve). At 8 GiB total additional the remaining free space is 8.518 GiB.

**Decision: conditionally plausible, not admitted.** Actual U and Python expanded
requirements are unknown. A failed threshold check must stop; 57.52 MiB compressed
is not proof that U fits 256 MiB. The 8 GiB envelope is not a hard quota and must
not be represented as measured peak usage.

## Bounded next measurement, not executed

After authorization to read layer payloads, use sequential registry downloads
outside Docker, into a task-only directory. Enforce exact descriptor lengths and
SHA-256 with a total compressed cap of 64 MiB (the pinned manifest totals 57.52).
Validate each digest before decompression. Stream decompression and tar inspection
without extracting any paths, writing an image, or running code. Bound decoded
output and member logical sizes to 256 MiB aggregate, entry count to a finite
threshold, reject unsupported sparse/extension semantics, enforce per-layer and
overall deadlines, and verify full uncompressed hashes against config diff IDs.
A cap hit is an inconclusive/rejected candidate, not a smaller size estimate.

This bounded layer inspection would consume at most the small compressed cap on
disk and bounded buffers; it avoids VFS import until capacity is measured. It is
**not part of this metadata-only authorization and was not performed**. After
measurement, recompute the estimate with filesystem overhead and dependency
sizes. During a separately authorized pull/install/allocation, sample free bytes
every 500 ms and stop owned work at 6 GiB. Daemon cancellation can lag; this is a
reaction guard, not a quota. No Docker storage-driver/global quota change proposed.

## Helper configuration and corrected process assumption

Independent review traced workload `_base_host_config_kwargs` and helper create.
The helper bypasses the method applying network/capability/resource settings;
`runtime.execd_image` only changes the image. There is no reviewed public helper
network/capability/resource option. Preserve the permission exception rather than
silently patching upstream.
[Workload settings](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/container_ops.py#L362),
[helper creation](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/runtime.py#L78).

Actual pinned image config has ENTRYPOINT `["./execd"]`, WorkingDir `/`, no User
and no volumes. Helper create sets command `["tail", "-f", "/dev/null"]` but does
not override ENTRYPOINT or User. Therefore the configured process is
`./execd tail -f /dev/null` as default root, **not a proven tail-only process**.
Whether execd accepts those arguments and remains available for archive retrieval
is untested. Default networking/capabilities/resource settings still apply. No
claim of successful helper startup or lifecycle is made.

## Preparation/cleanup design review

The present repository script only checks an offline plan or HTTPS health. It
neither generates nor cleans keys, so no implemented automatic credential cleanup
is claimed. The future executor must create its directory as 0700 and files with
0600 at creation (`O_EXCL`, no symlink following), not chmod after writing. Never
put secrets in command arguments, logs, Git or the sandbox. Create task-local
state/log paths explicitly rather than inheriting upstream home defaults.

An independent deadline supervisor must survive parent interruption. Cleanup must
record process identities/owned Docker IDs, stop processes, verify listeners and
processes are absent, then remove private material; unlinking configuration alone
does not revoke an in-memory key. Upstream helper create/start errors occur before
its archive-read finally, and remove failures are warnings. The executor must
handle both, plus ambiguous create responses and late allocations, without
prefix-wide deletion or claiming cleanup merely because finally ran. Unknown
ownership must be reported and reconciled, not guessed. These are implementation
requirements for the later authorized executor, not completed runtime guarantees.

## Authorized bounded payload measurement — completed follow-up

The parent subsequently authorized layer payload inspection with an 80 MiB total
compressed cap, 256 MiB aggregate decoded cap and 120-second deadline, without
Docker pull/import, filesystem extraction or execution. The earlier metadata-only
status above is historical; the following measurement supersedes its unknown-U
finding. No mature OCI inspection tool (`skopeo`, `crane`, `regctl`, `oras`) was
installed. Python standard-library HTTPS, gzip and streaming tar readers provided
the bounded alternative; the exact executed procedure and receipt are committed
in the metadata directory. This procedure is a historical evidence script using
its recorded task-local input paths, not a general-purpose deployment CLI.

| Observation | Result |
| --- | ---: |
| Completed layers | 13 / 13 |
| Compressed payload read | 60,314,718 bytes (57.52 MiB) |
| Full decoded tar streams | 121,012,224 bytes (115.40625 MiB) |
| Sum of tar member logical sizes | 120,697,170 bytes |
| Per-member 4 KiB rounded size plus 4 KiB overhead estimate | 123,195,392 bytes |
| Entries / directories / links | 540 / 109 / 335 |
| `.wh.*` whiteout entries observed | 0 |
| Time | 9.759 seconds |
| Hashes | All 13 compressed descriptors and decoded diff IDs matched |
| Cleanup | Owned compressed cache removed; no extracted files or Docker resources |

The reader used existing verified HTTPS/proxy handling and public-registry access;
it stripped Authorization on cross-host registry redirects and rejected non-HTTPS
redirects. Anonymous registry token stayed in process memory. It downloaded and
verified each compressed layer before reading it through bounded gzip/tar streams.
No layer path was extracted or executed. Unsupported sparse semantics and excess
entries/bytes were rejection conditions. Completion remained below every bound.

### Interpretation and revised admission

Tar bytes and member sizes are **not final VFS allocated size**. Layer application
merges paths, replaces entries, interprets whiteouts/opaque directories and
hardlinks, and incurs inode, block and copy overhead. No `.wh.*` entry was seen,
but no merged root filesystem was constructed or inspected. Summing all layers
ignores deletions and deduplication; rounding every link as an entry is conservative
for this planning purpose, not an exact filesystem-accounting algorithm. The
reader's success also does not establish image safety or successful startup.

Using the 123,195,392-byte rounded/member allowance in the earlier **16-copy**
planning factor, plus the 3.783 GiB fixed subtotal, gives **5.619 GiB additional**.
Against the post-measurement free value **17,735,331,840 bytes**, roughly **10.898
GiB remains**, about **4.898 GiB above the 6 GiB reserve/reaction threshold**.
The 8 GiB planning envelope therefore has comfortable room for this measured
image; it is still not a quota or an observed VFS peak.

**Image-capacity disposition: admissible for the bounded experiment plan**, subject
to a fresh disk check before each allocation and the pending security permissions.
The Python environment remains a 1 GiB allowance rather than a measured install;
its installation must be bounded/observed independently and stop/re-plan if that
allowance is exceeded. Keep the 500 ms free-space monitor and 6 GiB stop threshold,
one workload plus at most one helper, no concurrent builds, and exact-owned-resource
cleanup. Actual peak and cancellation lag must be recorded during the eventual
execution. This measurement authorizes neither server startup nor helper defaults.

Independent agent review of GitHub checkpoint `b1e7a3b` recomputed the totals:
fixed **4,062,106,237 bytes**, plus 16 × 123,195,392 gives **6,033,232,509 bytes**
(5.618886 GiB). It verified all manifest/config/receipt descriptor relationships
and rehashed manifest/config; it did not redownload or independently rehash blob
payloads. The original reader performed those payload validations. The reviewer
confirmed no extraction/import and retained `measurement-complete-not-runtime-admission`
as the receipt classification. The 120-second signal bounds the measurement phase;
it is disabled before final cache removal, so it is not a hard cleanup deadline.
The recorded 9.759 seconds includes successful cleanup in this run. Links were
counted together, not separated into hardlinks and symlinks. These limitations do
not overturn the capacity estimate and must accompany it.

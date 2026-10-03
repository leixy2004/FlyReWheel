# One-shot Codex connectivity attempt, 2026-10-03

## Outcome

One official CLI invocation was attempted. It failed during configuration loading,
before a model turn started. No retry was made. This is **not** successful model
connectivity evidence; neither the CLI-recognized host login nor the prior container
smoke establishes actual inference access.

CLI: repository-pinned official `@openai/codex 0.159.2`, launched through its
installed Node wrapper. SDK package: `@openai/codex-sdk 0.159.2`. Existing host
`login status` had reported ChatGPT; no login action, auth-file/token inspection,
credential copying, API-key fallback or container credential injection occurred.

The invocation used a new empty /tmp working directory, `--no-daemon`, approval
`never`, `exec --ignore-user-config --ignore-rules --skip-git-repo-check
--ephemeral --sandbox read-only --json --color never`. No model identifier was
selected or guessed. The exact prompt contained no source or private data:

> Connectivity check only. Do not use tools, browse, search, inspect files, execute commands, or delegate. Return exactly this ASCII string and nothing else: FLYREWHEEL_CONNECTIVITY_OK

The outer process bound was 45 seconds and 1 MiB of output, with process-group
termination on timeout, excess output or observed tool-call events. The child
received only existing home/Codex-home/path and HTTPS trust/proxy paths, never
API-key variables. Proxy routes were checked for absence of embedded user/password.
No values from that environment are recorded here.

Settings included ChatGPT-only login, disabled web search, zero project-document
bytes, no shell environment inheritance, disabled shell/unified exec/apps/plugins/
hooks/browser/computer/image/multi-agent/code-mode/view-image/skill/sleep/tool-suggest/
memories/goals features, skipped host-skill discovery and disabled unbounded
connection retries. To prevent provider retries, the invocation also supplied:

- `model_providers.openai.request_max_retries=0`
- `model_providers.openai.stream_max_retries=0`
- `model_providers.openai.stream_idle_timeout_ms=15000`

**Those provider overrides were rejected by the installed CLI.** Its fixed error
was: `model_providers contains reserved built-in provider IDs: openai. Built-in
providers cannot be overridden.` The CLI exited 1 in 0.038 seconds. The zero-retry
configuration was therefore **not applied**. No thread/turn/usage/output/tool events
were emitted. The expected string was absent and output validation failed.
Reported model, usage and monetary cost remain unknown. The evidence supports a
pre-turn configuration failure, not an authentication, account, quota or model denial.

The explicit one-invocation/no-retry boundary was honored even though this failed
before inference. No second model-capable invocation was made. A future attempt
must first use a version-supported way to bound retries without inventing a new
provider or changing the existing login route.

```json
{
  "classification": "one-real-host-CLI-connectivity-attempt-not-production-gateway",
  "cliVersion": "0.159.2",
  "invocations": 1,
  "wallTimeoutSeconds": 45,
  "elapsedSeconds": 0.038,
  "exitCode": 1,
  "stopReason": null,
  "defaultModelNotOverridden": true,
  "requestedProvider": "official-default-with-chatgpt-only-auth",
  "reportedModelIds": [],
  "reportedUsage": "unknown",
  "monetaryCost": "unknown",
  "eventTypes": [],
  "itemTypes": [],
  "outputValid": false,
  "answers": [],
  "toolEventsObserved": false
}
```

## Credential-preserving integration research

The installed SDK 0.159.2 launches the local Codex executable over JSONL. Its
`baseUrl` option overrides the model endpoint; it is not an app-server client.
Source: installed SDK README and `dist/index.d.ts`, exact version pinned in the
repository lockfile. No auth configuration was read to establish this.

Official app-server documentation distinguishes a remote client connection from
`--code-mode-host`, which connects an app-server to a remote execution host shared
by its threads. That remote execution capability is experimental and not supported
for production workloads. Managed ChatGPT auth keeps lifecycle management in
Codex; the external-token mode expects client-supplied credentials and is unsuitable
for this no-token-copy task. See [official app-server documentation](https://learn.chatgpt.com/docs/app-server#connect-a-remote-code-mode-host)
and [authentication modes](https://learn.chatgpt.com/docs/app-server#authentication-modes).

**Inference:** retaining the official app-server on the trusted host and using an
explicitly bounded application protocol is a plausible next integration direction.
It is not a verified replacement for the current worker's Responses gateway.
No basis was found for converting the existing ChatGPT login into a drop-in
worker `baseUrl` proxy without a different integration design. Do not extract
login tokens or build a token-forwarding proxy to bridge this gap.

Read-only follow-up used official `app-server --help` and successfully generated
314 protocol JSON schema files using CLI 0.159.2 in a task-owned temporary directory.
`ClientRequest.json` includes `initialize`; its SHA-256 is
`1c7fec8758deb95ffe967060130e8d1ddb7a0a5a437ee9b64086dddbed8f5831`.
No app-server was started, no port opened, no handshake or turn sent. Generated
schemas are temporary reconstruction outputs, not added to the repository.
The next non-model validation can be a stdio initialize/initialized handshake
using that version's protocol, with no thread/turn/login methods. Production
request ingress/lifecycle authority and remote execution security remain separate.

## Explicitly authorized corrected invocation

After the coordinator authorized one further invocation to repair the pre-model
parameter error, the three unsupported `model_providers.openai.*` overrides were
removed. No replacement provider, model route or invented retry setting was
introduced. Installed CLI help reconfirmed the exec flags; its feature listing
confirmed shell/unified-exec disabling and the unbounded-connection-retries toggle.
Provider-internal HTTP attempts remain unobserved; one CLI invocation is not a
claim of one HTTP request or a monetary ceiling.

The same empty-directory/fixed-string test was invoked exactly once more using
the existing ChatGPT-only login route, official CLI 0.159.2, read-only sandbox,
tools/search disabled and the 45-second outer deadline. It exited 1 in **0.219
seconds**, reporting:

```text
Error: failed to initialize in-process app-server client: Read-only file system (os error 30)
```

No thread, turn, model identifier, usage, output or tool event appeared. Output
validation therefore failed. No autonomous retry followed. Total model-capable
CLI process launches in this task are now two, each separately authorized; both
failed locally before any observed model turn. Neither failure establishes an
invalid login, unavailable model service or account/quota denial. Model, usage,
internal HTTP count and cost remain unknown.

```json
{
  "classification": "authorized-corrected-single-host-CLI-invocation",
  "cliVersion": "0.159.2",
  "invocationsThisAttempt": 1,
  "wallTimeoutSeconds": 45,
  "elapsedSeconds": 0.219,
  "exitCode": 1,
  "stopReason": null,
  "modelOverride": null,
  "reportedModelIds": "unknown",
  "reportedUsage": "unknown",
  "internalHttpAttempts": "unknown-not-observed",
  "monetaryCost": "unknown",
  "eventTypes": [],
  "itemTypes": [],
  "outputValid": false,
  "answers": [],
  "toolEventsObserved": false
}
```

Read-only filesystem metadata checks found existing HOME and CODEX_HOME locations
not writable, while TMPDIR was writable. No auth contents were read, permissions
changed or directories relocated. The exact failing write path was not exposed by
the CLI, so these metadata observations do not prove which component caused the
initialization error.

The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents separate `sqlite_home` and `log_dir` paths. They are candidate local
runtime-state controls, **not a validated fix** for this error; managed cloud
compatibility has additional limits. No override was applied, no auth home was
moved, and no app-server listener or additional model-capable process was started.
A future diagnostic should identify the required writable state path while
preserving the existing read-only credential location, rather than copy credentials
or weaken filesystem permissions.

## Path-level root cause: initialize-only diagnostics

The coordinator then authorized filesystem-path diagnostics and non-inference
initialization checks only. The existing `strace 6.13` was used; nothing was
installed. The syscall allowlist was exactly `open,openat,mkdir,mkdirat,rename,
renameat,unlink,unlinkat,link,linkat,symlink,symlinkat`, with `status=failed`.
No read/write syscall buffers, execve arguments/environment arrays, auth-file
contents or token values were traced. Reports retained failed paths and errno.

Both runs used official CLI 0.159.2 `--no-daemon app-server --stdio`, the existing
original authentication location, an empty temporary working directory and the
same legal tool/search-disable controls. They sent only the JSON-RPC `initialize`
request, under a 10-second diagnostic deadline. Neither reached a response or
sent thread/turn/login methods. Stdio creates no TCP/WebSocket listener. These
are initialization diagnostics, not additional model calls.

### First required write: SQLite

The baseline failed in 0.096 seconds on this exact syscall:

```text
open("/run/codex-environment/codex-home/state_5.sqlite",
     O_RDWR|O_CREAT|O_LARGEFILE|O_NOFOLLOW|O_CLOEXEC, 0644) = -1 EROFS
```

The explicit app-server error identified failure to initialize SQLite under the
original Codex home. This is stronger evidence than the prior generic exec error.

### Supported partial fix, then second required write

A second initialize-only run added the documented setting
`-c 'sqlite_home="<task-owned-temporary-state-directory>"'`. This preserved the
original HOME/CODEX_HOME and credential source. The setting was accepted by the
actual installed CLI: SQLite state/queue/memory/goal/log files were created in the
new directory. Their names were listed; their contents were not read or copied.

Startup then failed in 0.343 seconds at:

```text
open("/run/codex-environment/codex-home/installation_id",
     O_RDWR|O_CREAT|O_LARGEFILE|O_CLOEXEC, 0644) = -1 EROFS
```

A relative `openat(4, "uid_map", O_RDWR|O_CLOEXEC) = -1 EROFS` was also observed.
Its absolute path and necessity were not established. It is not substituted for
the confirmed installation-ID failure or claimed as an independently solved gate.

The exact official release source corroborates the fatal installation-ID path:
`rust-v0.159.2` resolves via annotated tag `8b9fa496bbf2c47aebd62e85a080b9a522a455b5`
to commit `ff6aec96948b70d94983af2641a6b67c94faeff5`.
[installation_id.rs:19-31](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/installation_id.rs#L19)
constructs the path below codex_home and opens it read/write/create before reading
or validating an existing ID.
[app-server startup:769](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/app-server/src/lib.rs#L769)
propagates that resolver error. These files were fetched read-only from GitHub;
no upstream changes or comments were made.

### Concrete capability gap

The supported `sqlite_home` override solves the first state-directory write but
is insufficient for a fresh nested CLI/app-server under this read-only original
Codex home. No documented independent installation-ID path or read-only resolver
mode was found. Changing `log_dir` cannot relocate this source-coded path, and
normal ephemeral/no-history options do not bypass this startup resolver.

Thus the **tested standalone nested CLI 0.159.2 route cannot initialize in the
current filesystem boundary while preserving that unchanged credential home**.
This is not a universal claim that every nested-CLI architecture is impossible,
and is not a login, model, subscription or network failure. Resolution needs an
environment-supported host app-server that is already initialized outside this
boundary, or an officially supported CLI/environment fix for read-only identity
state. No such capability was verified here. Do not grant broader host writes,
relocate/link credentials, invent providers or patch/vendor Codex to claim success.

For reproduction, send only an `initialize` JSON-RPC request on stdin to the
version-pinned `app-server --stdio` command under the restricted strace allowlist
above. First retain the original environment; then set only `sqlite_home` to a
new task-owned directory. Bound each process to 10 seconds and terminate its
process group if needed. Do not send `thread/start`, `turn/start`, login or token
methods. The two exact failing writes above are sufficient to reproduce the
observed initialization gates; no model prompt is required.

Original sanitized diagnostic receipts:

```json
{
  "operation": "stdio-initialize-only-path-diagnostic",
  "exitCode": 1,
  "elapsedSeconds": 0.096,
  "timedOut": false,
  "requestMethods": [
    "initialize"
  ],
  "responseMetadata": [],
  "failedFilesystemCalls": [
    "5209  open(\"/run/codex-environment/codex-home/state_5.sqlite\", O_RDWR|O_CREAT|O_LARGEFILE|O_NOFOLLOW|O_CLOEXEC, 0644) = -1 EROFS (Read-only file system)"
  ],
  "errorLines": [
    "WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)",
    "Error: failed to initialize sqlite state runtime under /run/codex-environment/codex-home: failed to initialize state runtime at /run/codex-environment/codex-home"
  ],
  "noModelTurnSubmitted": true
}
```

```json
{
  "operation": "stdio-initialize-only-sqlite-override",
  "exitCode": 1,
  "elapsedSeconds": 0.343,
  "initialized": false,
  "stopReason": null,
  "requestMethods": [
    "initialize"
  ],
  "responseMetadata": [],
  "failedFilesystemCalls": [
    "5290  openat(4, \"uid_map\", O_RDWR|O_CLOEXEC) = -1 EROFS (Read-only file system)",
    "5276  open(\"/run/codex-environment/codex-home/installation_id\", O_RDWR|O_CREAT|O_LARGEFILE|O_CLOEXEC, 0644) = -1 EROFS (Read-only file system)"
  ],
  "errorLines": [
    "WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)",
    "Error: Read-only file system (os error 30)"
  ],
  "stateFiles": [
    "queue_1.sqlite-wal",
    "queue_1.sqlite",
    "memories_1.sqlite",
    "goals_1.sqlite",
    "logs_2.sqlite-shm",
    "logs_2.sqlite-wal",
    "logs_2.sqlite",
    "state_5.sqlite-shm",
    "state_5.sqlite-wal",
    "state_5.sqlite"
  ],
  "sqliteHome": "/tmp/flyrewheel-init-sqlite-ayutyk3_/state",
  "originalAuthHomeUnchanged": true,
  "noThreadOrTurnSubmitted": true
}
```

No diagnostic process remained after completion. The original filesystem
permissions/authentication source were unchanged. The separately owned compiled
entrypoint fix is still assigned to the main session; this diagnostic made no
runtime-source or container-recipe changes.

# Prepared workspace resolver

`createPreparedWorkspaceResolver` in `src/prepared-workspace-resolver.ts` is a concrete read-only resolver for `ApplicationDispatcherDependencies.resolveWorkspace`. Trusted deployment code constructs it from administrator-controlled JSON. It does not load modules or accept paths from queued jobs.

```ts
import { createPreparedWorkspaceResolver } from './src/prepared-workspace-resolver.js';
import { digestOf } from './src/core/identity.js';
import { inspectWorkspace } from './src/workspace/index.js';

// This identity and selection come from the administrator's authorization process.
// The workspace must already have been prepared by prepareWorkspace.
const prepared = await inspectWorkspace(workspace);
const resolveWorkspace = createPreparedWorkspaceResolver({
  schemaVersion: 1,
  entries: [{
    selection: {
      workspaceId, jobDigest, repository, kind,
      baseSha, headSha, expectedSha,
    },
    workspace, // { repoPath: canonicalAbsolutePath, runId, attemptId }
    manifestDigest: digestOf(prepared.record),
  }],
});
// Supply resolveWorkspace to trusted bootstrap dependencies alongside the independently
// implemented lifecycle authority. Constructing this resolver does not configure a runtime.
```

All seven selection fields must match exactly. `jobDigest` is the application's canonical job digest, not a user-chosen replacement. The repository ID is explicitly bound to the administrator's local repository mapping; Git itself cannot authenticate a repository's hosting identity. Duplicate selections, unknown fields and more than 1,000 entries are rejected. The parsed configuration is copied into a private lookup; mutating the caller's JSON or a returned workspace identity cannot change subsequent resolutions. There is no configuration file loader; operators must bound and authenticate their own input before parsing it.

Every call checks cancellation before access and after asynchronous reads, rejects repository aliases whose real path differs, and uses the existing `inspectWorkspace` implementation. That checks the dedicated main repository, full history, forbidden Git configuration, manifest structure, branch/worktree identity and tracked, ignored and untracked dirt. The resolver additionally requires the pinned manifest digest, `ready` status, verified cleanliness, and current/base/initial SHA equal to the authorized expected SHA. The manifest digest binds the parsed record, not its JSON whitespace. Changes to manifest metadata require deliberate administrator reauthorization.

Mining uses the merge-base checkout; semantic review uses the head checkout. Prepare separate attempts where these differ and authorize each exact selection. A captured W0 changed-file package is not a complete Git object store and cannot by itself supply these workspaces. This resolver never clones, fetches, prepares, checks out, acquires/releases a lease, or repairs a retained attempt. The runner still acquires and revalidates its execution lease after resolution; inspection is not an atomic execution lock. Cancellation does not interrupt an in-flight Git subprocess inside the existing inspector, but is checked before returning its result.

Evaluation export selections and manifests carrying evaluation provenance are explicitly unsupported and rejected. Ordinary full-history resolution must not be described as a historical cutoff-safe evaluation. No lifecycle authority, sandbox isolation, model execution or physical cleanup guarantee is supplied by this resolver.

Validation uses authored local Git repositories and actual `prepareWorkspace` directories:

```sh
npx vitest run tests/prepared-workspace-resolver.test.ts --maxWorkers=1
npm run typecheck
```

These tests make no network, Docker or model calls. They cover real prepared workspace resolution, configuration isolation, each exact selection dimension, dirty/changed workspaces, manifest changes, symlink rejection, cancellation, duplicates and strict configuration parsing.

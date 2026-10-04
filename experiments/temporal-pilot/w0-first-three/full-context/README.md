# Fixed-W0 complete repository context

Completed: 6 exact-SHA fetches, 6 verified exports (114 committed files each),
3 context-ready request mappings, 92.707 seconds and 161,341,440 observed peak
temporary bytes. Both native agents independently verified the retained artifacts.

This stage follows the offline mining preparation in PR #18. The acquisition plan
was pushed as `6fb867c0a2c8e95929bd406630646fc7e6856d54` before any upstream Git
read. Only the six distinct source identity commits already present in the three
frozen W0 packages are authorized. Their nine head/baseTip/mergeBase roles collapse
to six SHAs because every selected baseTip equals mergeBase.

The existing evaluation export implementation provides the complete committed tree
and exact allowed ancestor-object closure. Each before/after export allows just its
checkout SHA. The common acquisition cache is never a model workspace. No default
branch, tags, other PR selection, shallow/partial history, submodule fetch, upstream
code execution or dependency installation is used. Hooks and ambient Git config/
credential helpers are disabled. Standard Git HTTPS uses the existing proxy routing;
TLS verification stays enabled and redirects are refused. A failed fetch stops the
stage without retry, credential change or alternate route.

## Budgets and evidence

`git-log.jsonl` records cache probes and each exact SHA transfer start/end. Git smart
HTTP exchanges are separate from the frozen 48/50 REST acquisition ledger. Six fetch
commands do not mean six HTTP requests. Wire bytes and the internal number/cost of
smart HTTP exchanges are not instrumented and must not be reported as zero.

The supervisor caps time at ten minutes, each subprocess-created file at 64 MiB,
and observes aggregate temporary disk usage every 100 ms against 512 MiB. Existing
export limits remain stricter (64 MB packs, 256 MB expanded closure, 120 seconds per
export operation). This environment supplies no aggregate filesystem quota; transient
disk overshoot between observations cannot be ruled out. The report gives observed
peak bytes rather than claiming an unobserved hard guarantee. Failure attempts are
retained and cannot be automatically retried in the same directory.

`context-*-before.json` and `context-*-after.json` retain the existing export manifest,
inventory and evaluation binding. `result.json` maps the original immutable mining
request digests to context readiness; original selected-evidence requests are not
rewritten. After exports also contain a pure full-repository generation template,
with no configured model and executable=false. The template's probe workspace was
removed; it must be rederived from the retained export and rebound before any future
execution. No live runtime or Sandcastle service is started.

`stage-report.json` records budget observations. Export verification checks all
objects, including unreachable storage, against the allowed closure; exact refs,
HEAD/tree, complete file bytes and modes, fsck, and clean state. A disposable derived
checkout receives a local untracked probe; the immutable export is rechecked unchanged,
then the derived checkout is deleted. The acquisition cache and immutable exports
remain isolated local research artifacts; their evidence records are published here.
Historical public availability remains unproven, and semantic eligibility/labels
remain unknown. Commit dates and successful Git retrieval are not historical visibility
proof. No human labels or model results are generated.

## Commands

The network entry point creates one exclusive new attempt. Do not run it as an
implicit retry; this recorded stage has already consumed its Git transfers:

```sh
node --import tsx scripts/materialize-w0-context.ts --stage /tmp/NEW_AUTHORIZED_W0_ATTEMPT
```

Offline checks need only the installed project dependencies:

```sh
npx vitest run tests/w0-materialization.test.ts tests/evaluation-workspace.test.ts --maxWorkers=1
npx tsc --noEmit
```

To inspect a retained export offline, write its JSON `manifest` field to a file and
use the existing CLI:

```sh
node --import tsx src/cli.ts evaluation checkout inspect \
  --store /tmp/flyrewheel-w0-full-context-attempt-1/exports --manifest /tmp/manifest.json
```

Source bytes stay in isolated local exports rather than duplicated into the project
repository. GitHub carries the acquisition plan, code, immutable identity/inventory
records and request templates; the source repository remains the provenance source.

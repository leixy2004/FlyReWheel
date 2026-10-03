# Pull request validation

The [workflow](../.github/workflows/ci.yml) runs on ordinary `pull_request`
events for every target branch, including stacked pull requests. It uses one
Ubuntu 24.04 job with Node.js 24 and these commands, in order:

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm test
```

`npm test` uses the existing Vitest configuration of two workers. There is no
matrix or service container. The job has a 45-minute timeout; dependency
installation, type checking, build, and tests have respective timeouts of 10,
5, 5, and 30 minutes. The job timeout caps their combined duration. These bounds
allow for the approximately 21-minute baseline test run without permitting an
unbounded run. A new run cancels older runs for the same workflow and PR.

## What a result establishes

Checkout uses the default pull-request merge commit, which combines the proposed
changes with the target branch. A hosted result therefore describes the merge
commit tested by that run, not automatically the PR head alone. Independent
head-based evidence must record its own exact commit and commands. See GitHub's
[pull request event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

The commands cover type checking, compiled output, and the existing test suite,
including authored fixtures, mocked boundaries, and PGlite where used. They do
not start a real PostgreSQL server, deploy an isolated runtime, or call a real
model. Real PostgreSQL, runtime, and provider/model verification remain separate
opt-in tasks with their own evidence. Authored responses are not model-quality
results. This document describes the configured checks; it does not claim that
a hosted Actions run has succeeded. Runtime and dependency-install behavior on
the hosted runner remain to be observed.

## Permissions and dependencies

The workflow grants only `contents: read`, disables persisted checkout
credentials, and does not reference secrets or use a privileged PR trigger.
Dependency installation uses the public npm registry and executes dependency
installation scripts; this is not an offline or network-isolation test.
Package-manager caching is explicitly disabled. It makes no repository settings
or branch-protection changes and does not establish that this check is required
for merging. Repository settings endpoints were unavailable to the setup review
(HTTP 403), so their configuration was not verified or changed.

The official actions are pinned to release commit SHAs:

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1):
  `3d3c42e5aac5ba805825da76410c181273ba90b1`.
- [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0):
  `820762786026740c76f36085b0efc47a31fe5020`.

Node.js is selected by major version, so its resolved patch version and the
hosted Ubuntu image can change between runs. Record the run URL and resolved
environment when citing hosted evidence. Pin updates require review of the
upstream release and resulting workflow diff.

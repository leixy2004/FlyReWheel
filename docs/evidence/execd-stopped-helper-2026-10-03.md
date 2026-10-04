# Real stopped-container archive test and local hardening

Docker officially supports copying from stopped containers, and `cp ... -`
streams an archive. The Python SDK separates create from start and offers the
same filesystem archive operation through `get_archive`.
[Docker cp](https://docs.docker.com/reference/cli/docker/container/cp/),
[Python SDK](https://docker-py.readthedocs.io/en/stable/containers.html#get_archive).

The bounded real experiment pulled only the already-measured immutable
`opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a`,
created one uniquely labeled container with network none, drop ALL,
no-new-privileges, read-only root, 128 MiB memory, 0.5 CPU and 16 PIDs, and read
five allowlisted assets through `docker cp` archive streams. It never invoked
start or exec, extracted host files or opened container ports.

[Actual receipt](execd-metadata-2026-10-03/stopped-container-receipt.json):
container `c20ff032a48f263e466c3bc68fdc44c818357c67edacec46192ab0f08b1adad5`,
owner `1039ceab-2003-4c09-a2c5-02b092362031`. Before and after reads, state was
`created`, PID 0, Running false, StartedAt zero. `/execd`, `/bootstrap.sh`, bwrap,
session gate and launcher were readable with executable modes. Missing-file
lookup failed. The container and new image were removed. Elapsed time 4.455s;
minimum sampled free bytes 16,739,540,992. A later successful daemon list query
found no matching labeled container, and image listing showed only the original
worker and Node images. No control-plane/API/TLS credential was created.

The [local patch](../../deploy/opensandbox/execd-never-start.patch) targets pinned
upstream `c7dc78a4090e5de2b9119e9bd93952cae24f87bd`. Original and patched file hashes
are in [the pin file](../../deploy/opensandbox/upstream-pin.json). The patch was
applied to the exact upstream source, hash-verified and Python-compiled. It removes
start/reload and adds network-none, cap-drop-ALL, no-new-privileges and read-only
root to the helper creation. Two independent agents reviewed compatibility and
security. Cache/platform/optional-asset/finally behavior remains upstream. This is
not an unmodified upstream release, and custom images that generate assets on
startup are outside the verified scope.

The real receipt predates reviewer-requested verifier error-classification fixes.
The original verifier could misclassify arbitrary Docker query failures as absence.
Follow-up daemon queries above independently checked actual removal. Current
verifier now distinguishes exact not-found errors, refuses unknown preexisting
image state, gives cleanup separate bounded commands, and marks deletion failures
`cleanup-unverified`. Five fake CLI tests cover those fixes; the real pull was not
repeated. Do not treat the old receipt as a real execution of the revised verifier.
The checker explicitly does not guarantee absence of arbitrarily late allocations.

Both archive success and patch review remain below actual patched-server lifecycle
evidence: the complete OpenSandbox server has not been installed or launched.

# Existing proxy configuration and Node fetch

This investigation was offline. It did not probe another endpoint, read tokens,
print proxy addresses or credentials, modify OS networking, or change TLS trust.
The already-authorized repository Git connection successfully published the saved
single-GET diagnosis to PR #14; no additional upstream capture GET was made.

## Observed difference

The environment provides nonempty HTTP_PROXY, HTTPS_PROXY, NO_PROXY and their
lowercase variants. NODE_USE_ENV_PROXY and NODE_OPTIONS are absent. The installed
Node is v24.19.0. Octokit's installed fetch-wrapper selects an explicitly supplied
request.fetch or globalThis.fetch; normal collector execution supplies no override.

A local data: URL initialized fetch without network access. The normal invocation
used the Agent dispatcher. Each official opt-in below instead initialized an
EnvHttpProxyAgent using the environment's existing configuration:

```sh
node --use-env-proxy <entrypoint>
NODE_USE_ENV_PROXY=1 node <entrypoint>
```

These are documented by installed `node --help` and implemented in bundled Node
`internal/process/pre_execution` (setupHttpProxy). The bundled Undici source
implements EnvHttpProxyAgent. No third-party proxy, credential copying, replacement
fetch implementation, host-network change or trust-store edit is needed. These
commands are explanations of supported startup switches, not a record that a new
upstream request has been authorized or executed.

For fetch, lowercase proxy/no_proxy variables take precedence over uppercase.
NO_PROXY can make a target bypass the proxy; its values were deliberately not
inspected. Thus the opt-in selects the environment-aware dispatcher, but this
investigation does not establish the effective route for api.github.com.

Git's HTTPS helper links libcurl, and the gh binary contains HTTP_PROXY/HTTPS_PROXY
support. Neither uses Node's dispatcher. Their existing repository operations
succeeded, whereas the collector's native fetch connection failed. No connection
trace was collected for Git or gh, so their exact proxy usage is unverified.

## What can and cannot be concluded

There is a confirmed client-configuration mismatch: default Node fetch is not
using its environment-aware proxy dispatcher despite supplied proxy variables.
That is a plausible explanation for the refused native-fetch connection, not proof of
which network component rejected it. The actual diagnostic remains ECONNREFUSED,
HTTP status null, with no evidence of authentication rejection or TLS failure.

The offline data: checks made zero network requests. The upstream budget remains
2 of 50; real source packages remain zero. The producer, license/tree validation
and safe failure classification remain ready. A later bounded verification may
use only the already-provided approved proxy configuration via the official Node
switch, preserving NO_PROXY, TLS verification, the fixed endpoint and the request
budget. No new proxy configuration or route substitution was performed here.

Additional offline tests ensure unrecognized nested transport errors remain
transport-unknown rather than being mislabeled as HTTP, TLS, proxy or permission
failures. They also ensure that generic errors do not leak sensitive messages or
trigger another fetch call.

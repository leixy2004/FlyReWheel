# Public GitHub access through an existing environment proxy

FlyReWheel's normal GitHub CLI uses Octokit and Node's native fetch. On the verified Node v24.19.0 environment, it needs both the existing environment proxy route and the system CA store:

```sh
node --use-env-proxy --use-system-ca dist/cli.js github-pr capture \
  --repository vllm-project/vllm --number 29666 --max-requests 50 \
  --db ./local-db --out ./pr-evidence.json
```

These are **Node startup flags**, placed before `dist/cli.js`. Keep the administrator-provided `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` routing configuration available to the process. Do not substitute proxy addresses or copy credential values into command lines. This command does not need GitHub authentication, Python, a fetch override, a new dependency or an executable adapter.

On the tested Node release, the equivalent process environment switches are `NODE_USE_ENV_PROXY=1 NODE_USE_SYSTEM_CA=1`. They must be set before Node starts. The application supports Node >=22, but that does not imply every supported runtime exposes these newer Node switches: check the installed runtime's `node --help`. This recipe was verified on v24.19.0 and does not change the project's minimum runtime contract.

## Exact diagnosis in this environment

Three small unauthenticated GET probes targeted the same official PR metadata endpoint. Only safe error names/codes and variable presence were recorded, never proxy/CA paths or credential values:

| Startup configuration | Result |
| --- | --- |
| Default Node fetch; existing proxy variables present but not enabled | `TypeError` → `ECONNREFUSED` |
| `--use-env-proxy` | `TypeError` → `SELF_SIGNED_CERT_IN_CHAIN` |
| `--use-env-proxy --use-system-ca` | HTTP 200 |

The earlier isolated CLI process removed the environment's existing trust settings (`NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` were present in the ambient environment). Its proxy-only retry therefore lacked the needed trust configuration. Native Node does not enable environment proxy routing merely because proxy variables exist, and its bundled roots alone did not validate this environment's chain. The successful run enabled Node's existing system trust store instead; it did not pass or inspect the ambient extra-CA variable values.

The earlier Octokit log showed status 500 with request ID UNKNOWN. That was insufficient to identify an upstream GitHub HTTP failure. The direct native-fetch error chain above identifies the actual connection/trust failures. This was a process-launch configuration issue, not a missing PR collector protocol or demonstrated GitHub service error.

## Trust and official support

Node's system-CA switch adds the operating system's existing trusted roots to its bundled roots; verification of the certificate chain and hostname remains enabled. No host CA files, safety settings or network restrictions were changed. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized:false`, or an insecure fallback. If the installed system trust does not validate an authorized route, stop and have its administrator configure trust rather than downloading or trusting an arbitrary certificate.

An administrator-managed `NODE_EXTRA_CA_CERTS` file is another official startup mechanism. Node reads it only at process launch. This task did not read its value/content or use it in the successful run.

Official reference used: [Node v24.19.0 CLI documentation](https://github.com/nodejs/node/blob/v24.19.0/doc/api/cli.md), sections `--use-env-proxy`, `--use-system-ca`, `NODE_USE_ENV_PROXY=1`, `NODE_USE_SYSTEM_CA=1`, and `NODE_EXTRA_CA_CERTS=file`. The pinned documentation records proxy flag support from v24.5.0 and system-CA Linux support from v23.9.0; environment switches were added in v24.0.0 and v24.6.0 respectively.

## Native CLI acceptance

Verified product-code HEAD: `9835ff428a17e01882ec286b0c37f8010df0f61a` (the implementation remains `7fae21e`). One ordinary compiled CLI capture of official [vLLM PR #29666](https://github.com/vllm-project/vllm/pull/29666) completed with exit 0 and empty stderr, using 40 bounded GETs. All existing pagination, ref-stability, blob identity, byte limits, error handling and unauthenticated-request checks remained intact.

The captured package is exactly equal to the previous Python-transport observation: evidence digest `da82756031a6e8e92a2730305f5373878437df049754cb401151fa32b6349110`. It contains 9 changed paths, 18 captured sides, 131,744 bytes, no exclusions, 1 issue comment, 8 reviews and 7 review comments. Every captured source blob's Git SHA-1 and SHA256 was checked again offline. A separate `github-pr show` process reopened the database and returned the same evidence with the expected integrity-only readback receipt.

The one complete native acquisition was necessary to verify the normal CLI end to end. Apart from the three small diagnostic GETs, no other PR/batch or repeated full dataset was acquired. Existing evidence was used for offline equality checks rather than fetched again. No model, credentials, W1 or vLLM execution was involved.

The minimal related regression command was:

```sh
npm test -- tests/github-pr-diagnostics.test.ts tests/github-pr-failure-classification.test.ts
```

Result: **58 passed, 0 failed, 0 skipped in 2 files**. No product source or dependency changes were needed, so no new unit tests or broad suite were added. The archived [native acceptance record](evidence/github-node-public-transport-2026-10-13.json) includes the exact parameterized command, complete capture receipt and probe outcomes. The earlier Python bridge is historical evidence, not required for normal CLI use with this verified Node configuration.

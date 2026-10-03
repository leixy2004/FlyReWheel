# Build from the repository root; see README.md in this directory.
# No mutable-tag fallback: an operator must supply an audited base by digest.
ARG WORKSPACE_WORKER_BASE_IMAGE
FROM ${WORKSPACE_WORKER_BASE_IMAGE} AS build
ARG WORKSPACE_WORKER_BASE_IMAGE
USER 0:0
SHELL ["/bin/sh", "-c"]
WORKDIR /build
COPY package.json package-lock.json ./
COPY deploy/workspace-worker/prepare-image.mjs ./prepare-image.mjs
RUN /usr/local/bin/node ./prepare-image.mjs check-base
# Optional packages contain the architecture-specific CLI. No lifecycle scripts.
RUN npm ci --include=dev --include=optional --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY deploy/tsconfig.build.json ./deploy/tsconfig.build.json
COPY src ./src
RUN ./node_modules/.bin/tsc -p deploy/tsconfig.build.json \
    && test -f dist/workspace-worker-entrypoint.js \
    && mkdir -p dist/storage/migrations \
    && cp src/storage/migrations/*.sql dist/storage/migrations/ \
    && /usr/local/bin/node ./prepare-image.mjs stage-codex \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${WORKSPACE_WORKER_BASE_IMAGE} AS runtime
USER 0:0
SHELL ["/bin/sh", "-c"]
ENV NODE_ENV=production \
    HOME=/nonexistent \
    PATH=/usr/local/bin:/usr/bin:/bin \
    TMPDIR=/tmp \
    LANG=C \
    LC_ALL=C
WORKDIR /opt/flyrewheel
COPY --from=build --chown=0:0 /build/package.json /build/package-lock.json ./
COPY --from=build --chown=0:0 /build/node_modules ./node_modules
COPY --from=build --chown=0:0 /build/dist ./dist
COPY --from=build --chown=0:0 /build/codex ./codex
COPY --chown=0:0 deploy/workspace-worker/workspace-worker ./bin/workspace-worker
COPY --chown=0:0 deploy/workspace-worker/workspace-worker.json ./workspace-worker.json
RUN test -x /usr/local/bin/node && test -x /usr/bin/git \
    && test -x /opt/flyrewheel/codex/bin/codex \
    && chmod 0555 /opt/flyrewheel/bin/workspace-worker \
    && chmod -R a-w /opt/flyrewheel \
    && mkdir -p /workspace/repo /run/flyrewheel \
    && chown 0:0 /opt /opt/flyrewheel /workspace \
    && chmod 0555 /opt /opt/flyrewheel /workspace \
    && chown 10001:10001 /workspace/repo \
    && chmod 0700 /workspace/repo \
    && chown 0:10001 /run/flyrewheel \
    && chmod 0750 /run/flyrewheel
# Request and evidence protection needs an external control-plane implementation.
# Do not make /run/flyrewheel writable by repository descendants to fix upload errors.
USER 10001:10001
WORKDIR /workspace/repo
HEALTHCHECK NONE
STOPSIGNAL SIGTERM
ENTRYPOINT []
# OpenSandbox invokes the fixed worker executable through its command API.
CMD ["/bin/sleep", "infinity"]

# Pin the official Node release; record a registry digest before production use.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY deploy/tsconfig.build.json ./deploy/tsconfig.build.json
COPY src ./src
RUN ./node_modules/.bin/tsc -p deploy/tsconfig.build.json \
    && mkdir -p dist/storage/migrations \
    && cp src/storage/migrations/*.sql dist/storage/migrations/ \
    && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOME=/home/flyrewheel \
    TMPDIR=/tmp \
    QE_ENABLE_MODEL=false \
    PORT=8080
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 flyrewheel \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin flyrewheel \
    && mkdir /codex-home \
    && chown 10001:10001 /codex-home
COPY --from=build --chown=0:0 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=0:0 /app/node_modules ./node_modules
COPY --from=build --chown=0:0 /app/dist ./dist
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "dist/worker.js"]

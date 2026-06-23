# services/docker-bff/Dockerfile
#
# Multi-stage build for the Docker BFF Sidecar.
#
# This service is single-purpose and lightweight (it does not depend on
# @oneplatform/core), so it builds standalone from the repo root rather than
# via the shared docker/Dockerfile.service turbo-prune pipeline.
#
# Build from the repo root:
#   docker build -f services/docker-bff/Dockerfile -t oneplatform/docker-bff .
#
# Runtime requires the Docker socket mounted:
#   -v /var/run/docker.sock:/var/run/docker.sock

ARG NODE_VERSION=22

# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /build

# Workspace manifests for dependency-layer caching.
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY pnpm-lock.yaml ./

# pnpm install --frozen-lockfile validates every workspace manifest against the
# lockfile, so all workspace package.json files must be present even though only
# docker-bff is built here.
COPY packages/app-sdk/package.json          ./packages/app-sdk/package.json
COPY packages/cli/package.json              ./packages/cli/package.json
COPY packages/core/package.json             ./packages/core/package.json
COPY packages/docs/package.json             ./packages/docs/package.json
COPY packages/frontend/package.json         ./packages/frontend/package.json
COPY packages/plugin-sdk/package.json       ./packages/plugin-sdk/package.json
COPY packages/sdk/package.json              ./packages/sdk/package.json
COPY services/app/package.json              ./services/app/package.json
COPY services/auth/package.json             ./services/auth/package.json
COPY services/docker-bff/package.json       ./services/docker-bff/package.json
COPY services/execution/package.json        ./services/execution/package.json
COPY services/gateway/package.json          ./services/gateway/package.json
COPY services/ingestion/package.json        ./services/ingestion/package.json
COPY services/logging/package.json          ./services/logging/package.json
COPY services/ontology/package.json         ./services/ontology/package.json
COPY services/pipeline/package.json         ./services/pipeline/package.json
COPY services/plugin/package.json           ./services/plugin/package.json
COPY plugins/auth-provider-ldap/package.json    ./plugins/auth-provider-ldap/package.json
COPY plugins/auth-provider-oidc/package.json    ./plugins/auth-provider-oidc/package.json
COPY plugins/connector-csv/package.json         ./plugins/connector-csv/package.json
COPY plugins/connector-mysql/package.json       ./plugins/connector-mysql/package.json
COPY plugins/connector-postgres/package.json    ./plugins/connector-postgres/package.json
COPY plugins/connector-rest-api/package.json    ./plugins/connector-rest-api/package.json
COPY plugins/connector-webhook/package.json     ./plugins/connector-webhook/package.json
COPY tools/openapi-gen/package.json         ./tools/openapi-gen/package.json
COPY tools/proto-gen/package.json           ./tools/proto-gen/package.json

RUN pnpm install --frozen-lockfile --filter @oneplatform/docker-bff-service...

COPY services/docker-bff ./services/docker-bff

RUN pnpm --filter @oneplatform/docker-bff-service build

# Produce a self-contained deployment with a real, flattened, symlink-free
# node_modules. Copying the pnpm workspace node_modules directly would carry
# cross-package symlinks into the .pnpm store (e.g. @hono/node-server resolves
# via ../../../node_modules/.pnpm/...), which dangle once detached from the
# workspace root and break ESM resolution at runtime.
RUN pnpm --filter @oneplatform/docker-bff-service deploy --prod /prod

# ─── Stage 2: Runner ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner

RUN addgroup --system --gid 1001 oneplatform && \
    adduser --system --uid 1001 --ingroup oneplatform oneplatform

WORKDIR /app

COPY --from=builder --chown=oneplatform:oneplatform /prod/node_modules ./node_modules
COPY --from=builder --chown=oneplatform:oneplatform /prod/dist ./dist
COPY --from=builder --chown=oneplatform:oneplatform /prod/package.json ./package.json

USER oneplatform

EXPOSE 3010

ENV NODE_ENV=production
ENV PORT=3010

CMD ["node", "dist/index.js"]

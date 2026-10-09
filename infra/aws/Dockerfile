# Build this context from git archive plus infra/aws; never from a developer .env.
ARG NODE_IMAGE=node:20.20.0-bookworm-slim@sha256:d8a35d586fad3af7abb6fdb9ba972388395405f4d462da9e4a4ddcde67b5e0fb
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
RUN npm ci --workspace=backend --workspace=shared --include-workspace-root=false --ignore-scripts
COPY backend/ backend/
COPY shared/ shared/
COPY infra/aws/ infra/aws/
RUN python3 infra/aws/prepare-source.py && npm run prisma:generate --workspace=backend && npm run build --workspace=backend
# Prisma's migration CLI is required at deploy time; preserve it in this release.
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# npm can nest conflicting workspace dependency versions under backend/node_modules.
COPY --from=build --chown=node:node /app/backend ./backend
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/infra/aws/healthcheck.cjs ./infra/aws/healthcheck.cjs
USER node
WORKDIR /app/backend
CMD ["node", "dist/backend/src/server.js"]

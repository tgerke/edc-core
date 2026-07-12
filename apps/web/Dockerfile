# Build context is the repo root (see infra/compose.yaml)
# Multi-stage: pnpm builds the static bundle, nginx serves it. The runtime
# image contains no Node toolchain and no dev server (issue #53).
FROM docker.io/library/node:22-slim AS build

RUN npm install -g pnpm@11.9.0
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/schemas/package.json packages/schemas/
COPY packages/odm/package.json packages/odm/
COPY packages/rules/package.json packages/rules/
RUN pnpm install --frozen-lockfile --filter @edc-core/web...

COPY packages/schemas packages/schemas
COPY packages/odm packages/odm
COPY packages/rules packages/rules
COPY apps/web apps/web
RUN pnpm --filter @edc-core/web build

FROM docker.io/library/nginx:1.27-alpine

# Same env contract as the old dev-mode image: the SPA calls /api/* and the
# server proxies it here. The nginx entrypoint substitutes this into the
# config template at startup.
ENV API_PROXY_TARGET=http://api:3000

COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 5173

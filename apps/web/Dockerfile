# Build context is the repo root (see infra/compose.yaml)
# Dev-mode image: Vite dev server proxying /api to the api service.
FROM docker.io/library/node:22-slim

RUN npm install -g pnpm@11.9.0
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/schemas/package.json packages/schemas/
RUN pnpm install --frozen-lockfile --filter @edc-core/web...

COPY packages/schemas packages/schemas
COPY apps/web apps/web

ENV API_PROXY_TARGET=http://api:3000
EXPOSE 5173
CMD ["pnpm", "--filter", "@edc-core/web", "dev"]

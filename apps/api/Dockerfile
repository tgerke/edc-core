# Build context is the repo root (see infra/compose.yaml)
FROM docker.io/library/node:22-slim

RUN npm install -g pnpm@11.9.0
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/schemas/package.json packages/schemas/
COPY packages/odm/package.json packages/odm/
COPY packages/rules/package.json packages/rules/
RUN pnpm install --frozen-lockfile --filter @edc-core/api...

COPY packages/schemas packages/schemas
COPY packages/odm packages/odm
COPY packages/rules packages/rules
COPY apps/api apps/api

EXPOSE 3000
CMD ["pnpm", "--filter", "@edc-core/api", "start"]

# edc-core

**A modern, open-source Electronic Data Capture (EDC) system for clinical research.**

Commercial EDC platforms are expensive, closed, and dated. The open-source alternatives run on legacy stacks. `edc-core` is a from-scratch EDC built on modern web technology, an analytics-native data architecture, and CDISC standards — designed so that regulatory expectations (21 CFR Part 11, ICH E6(R3)) are structural properties of the system, not afterthoughts.

> **Status: pre-alpha.** Phase 0 scaffold — architecture and foundations. Not yet usable for studies.

## Why

- **No vendor lock-in.** AGPL-3.0: nobody can take this code and sell it back to you as a closed platform.
- **Programmable study builds.** First-class CDISC ODM v2.0 import/export means builds can be file-driven, code-driven, and LLM-assisted — with a sleek point-and-click designer that hits exactly the same API.
- **Modern UX.** A fast browser SPA that looks and feels like software people use in 2026.
- **Analytics-native.** PostgreSQL is the transactional system of record; DuckDB/DuckLake provides versioned, point-in-time analysis snapshots. R runs server-side as a first-class citizen for clinical programmers.
- **Compliance by construction.** Append-only audit trails enforced at the database level, Part 11 e-signatures, audit-trail review tooling, and a shipped validation pack.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  apps/web — React SPA (Vite + TypeScript)           │
│  Tailwind + shadcn/ui, TanStack Router/Query        │
└──────────────────────┬──────────────────────────────┘
                       │ REST (OpenAPI-documented)
┌──────────────────────┴──────────────────────────────┐
│  apps/api — Node/TypeScript (Fastify + Drizzle ORM) │
│  auth, RBAC, audit middleware, forms/rules engine,  │
│  ODM import/export, query workflow, e-signatures    │
└───────┬──────────────────────────────┬──────────────┘
        │                              │ snapshot sync
┌───────┴───────────┐   ┌──────────────┴──────────────┐
│  PostgreSQL 16+   │   │  DuckLake (Parquet + DuckDB)│
│  system of record │   │  analytics/export layer;    │
│  + DuckLake       │   │  read by R engine & exports │
│  catalog          │   └──────────────┬──────────────┘
└───────────────────┘   ┌──────────────┴──────────────┐
                        │  services/r-engine          │
                        │  Rocker + plumber, duckdb/  │
                        │  DBI, read-only, sandboxed  │
                        └─────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) and the [architecture decision records](docs/adr/) for rationale, and [docs/regulatory-traceability.md](docs/regulatory-traceability.md) for how regulatory requirements map to system features.

## Repository layout

| Path | Contents |
|---|---|
| `apps/web` | React SPA (Vite, Tailwind, shadcn/ui) |
| `apps/api` | Fastify API server and background workers |
| `packages/odm` | CDISC ODM v2.0 parse / validate / serialize (XML + JSON) |
| `packages/schemas` | Shared zod schemas and API types |
| `packages/rules` | Sandboxed edit-check expression engine (client + server) |
| `services/r-engine` | Server-side R runtime (Rocker + plumber) |
| `infra` | Compose stack for local/self-hosted deployment |
| `docs` | Architecture, ADRs, regulatory traceability matrix |
| `examples` | Sample ODM study definitions |

## Quick start (development)

Requires Node ≥ 22, pnpm ≥ 9, and Podman (or Docker).

```sh
pnpm install
pnpm check        # lint + typecheck + tests

# full stack (Postgres + api + web + r-engine)
podman compose -f infra/compose.yaml up --build
# web UI:  http://localhost:5173
# API:     http://localhost:3000/health

# bootstrap the first admin, then a ready-to-tour demo study
pnpm --filter @edc-core/api db:bootstrap-admin
pnpm --filter @edc-core/api db:seed-demo   # see examples/README.md
```

Tagged releases publish versioned images to GHCR
(`ghcr.io/tgerke/edc-core-{api,web,r-engine}`) along with a **validation
pack** — the [regulatory traceability matrix](docs/regulatory-traceability.md)
joined to that release's automated test results (regenerate locally with
`pnpm validation-pack`).

## Roadmap

- **Phase 1** — Data model + append-only audit core, auth/RBAC ✅
- **Phase 2** — ODM v2.0 import + visual study builder ✅
- **Phase 3** — Metadata-driven data capture, edit checks ✅
- **Phase 4** — Query management, Part 11 e-signatures, audit review UI ✅
- **Phase 5** — DuckLake snapshots, Dataset-JSON v1.1 exports, SQL + R workbench ✅
- **Phase 6** — Validation pack, demo study, GHCR images, v0.1.0 release ✅
- **Next** — Python workbench sidecar, point-and-click form editing, repeating
  item-group entry, ODM 1.3.2 import shim, PDF casebooks, OIDC SSO

## License

[AGPL-3.0](LICENSE). Clinical research infrastructure should stay open — including when it's offered as a service.

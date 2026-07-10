# edc-core

**A modern, open-source Electronic Data Capture (EDC) system for clinical research.**

Commercial EDC platforms are expensive, closed, and dated. The open-source alternatives run on legacy stacks. `edc-core` is a from-scratch EDC built on modern web technology, an analytics-native data architecture, and CDISC standards — designed so that regulatory expectations (21 CFR Part 11, ICH E6(R3)) are structural properties of the system, not afterthoughts.

> **Status: alpha (v0.1.0).** The core capture workflow is complete end to end — build a study from ODM, capture data against it, manage queries, sign, snapshot, analyze, and export — but it has not yet been used in a production study. See the [changelog](CHANGELOG.md) and the [user guide](https://tgerke.github.io/edc-core/).

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

## What's here (v0.1.0)

- Study builds from CDISC ODM v2.0 (file, API, or visual builder), versioned and immutable
- Metadata-driven data capture with JSONata edit checks and a server-enforced
  entry workflow (in progress → complete → verified → signed → locked)
- Append-only audit trail (database-enforced), threaded query management,
  Part 11 e-signatures, audit review UI
- Per-study DuckLake snapshots; sandboxed SQL + R workbench; Dataset-JSON v1.1 /
  CSV / Parquet exports; per-subject PDF casebooks; self-contained study archives
- Per-release validation pack; CDASH-aligned demo study with one-command seed

## Roadmap

edc-core v0.1 covers build → capture → clean → export. The roadmap to a
**minimum credible set** for running a real study:

1. **OIDC SSO** — authorization-code flow against Entra/Okta/Keycloak, JIT
   provisioning, SSO-only mode (this release)
2. **Mid-study amendment migration** — build diff, impact analysis, and batch
   migration of unsigned forms to a new build version
3. **Role-based blinding** — item-level blinding enforced in capture,
   casebooks, and the analytics lake
4. **Notifications** — in-app inbox plus optional SMTP email for queries,
   signatures, and overdue forms

Fast-follows: medical coding (MedDRA/WHODrug) and lab data import.
Randomization/RTSM is deliberately an **integration point, not a build** —
edc-core consumes randomization assignments from external RTSM systems rather
than reimplementing one. A Python workbench sidecar is deferred; SQL and R
cover the analytics surface for now.

## License

[AGPL-3.0](LICENSE). Clinical research infrastructure should stay open — including when it's offered as a service.

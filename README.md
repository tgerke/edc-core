# edc-core

**A modern, open-source Electronic Data Capture (EDC) system for clinical research.**

Commercial EDC platforms are expensive, closed, and dated. The open-source alternatives run on legacy stacks. `edc-core` is a from-scratch EDC built on modern web technology, an analytics-native data architecture, and CDISC standards — designed so that regulatory expectations (21 CFR Part 11, ICH E6(R3)) are structural properties of the system, not afterthoughts.

> **Status: alpha (v0.3.0-dev).** The full feature set below is released as [v0.2.0](https://github.com/tgerke/edc-core/releases/tag/v0.2.0), but edc-core has not yet been used in a production study. See the [changelog](CHANGELOG.md) and the [user guide](https://tgerke.github.io/edc-core/).

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

## What's here

- Study builds from CDISC ODM v2.0 (file, API, or visual builder), versioned
  and immutable, with mid-study amendment migration (build diff, impact
  analysis, batch re-pointing of unsigned forms)
- Metadata-driven data capture with JSONata edit checks, repeating item
  groups, a server-enforced entry workflow (in progress → complete → verified
  → signed → locked), and an audited subject lifecycle (screening → enrolled →
  completed / withdrawn, with reinstate)
- Append-only audit trail (database-enforced), threaded query management,
  Part 11 e-signatures, audit review UI
- Access control: unique accounts with per-study/per-site role scoping, admin
  account lifecycle and per-study team pages, OIDC SSO with Part 11
  re-authentication at signing
- Item-level blinding enforced in capture, casebooks, audit review, and
  structurally in the analytics lake
- External data: central-lab CSV import (dry-run validation, idempotent
  re-imports, conflicts reported, never overwriting) and RTSM assignment
  intake via study-scoped API keys with an append-only transfer log
- Medical coding against MedDRA/WHODrug (bring your own licensed
  dictionaries): exact-match auto-coding plus a manual workbench, stale-coding
  detection, codings in the analytics lake
- Notifications: in-app inbox plus optional SMTP email for queries,
  signatures, and overdue forms
- Access evidence: structured access log with review UI, session binding to
  the issuing client, and security anomaly detection (failed-login bursts,
  lockouts, binding violations) with audited acknowledgement
- Per-study DuckLake snapshots; sandboxed SQL + R workbench; Dataset-JSON v1.1 /
  CSV / Parquet exports; per-subject PDF casebooks; self-contained study archives
- Per-release validation pack; deployment guide (TLS, encryption, backups,
  GDPR/HIPAA posture); CDASH-aligned demo study with one-command seed

## Roadmap

Every row of the [traceability matrix](docs/regulatory-traceability.md)
currently maps to an implemented, tested mechanism — new requirements enter
there before they are claimed. Two boundaries are deliberate rather than
pending: randomization/RTSM stays an **integration point, not a build**
(edc-core consumes assignments from external systems rather than
reimplementing one), and statistical deliverables belong in your validated
environment, fed by exported snapshots. A Python workbench sidecar is
deferred; SQL and R cover the analytics surface for now.

## License

[AGPL-3.0](LICENSE). Clinical research infrastructure should stay open — including when it's offered as a service.

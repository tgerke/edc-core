# Architecture

## System overview

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
│  + DuckLake       │   │  read by engines & exports  │
│  catalog          │   └──────────────┬──────────────┘
└───────────────────┘   ┌──────────────┴──────────────┐
                        │  services/{r,py}-engine     │
                        │  sandboxed R + Python       │
                        │  runtimes, read-only        │
                        └─────────────────────────────┘
```

## Core principles

1. **Two-plane data architecture.** Data *capture* is a concurrent transactional workload
   (many sites entering data simultaneously, row-level audit on every write) — that lives in
   PostgreSQL. Data *analysis* is a columnar, versioned, point-in-time workload — that lives
   in DuckLake (Parquet + DuckDB), fed by snapshots from Postgres. The same Postgres instance
   serves as the DuckLake catalog. See ADR-0001.

2. **Metadata-driven everything.** A study build is a versioned, ODM v2.0-shaped study
   definition. CRFs, edit checks, visit schedules, and codelists all render from metadata.
   The point-and-click study builder and file/API-driven builds (ODM upload, scripts, LLM
   agents) write through exactly the same versioned-metadata API. See ADR-0003.

3. **Append-only audit as a structural property.** Clinical data values are never destructively
   updated. Each change inserts an immutable version row (who, when, old→new, reason-for-change)
   in the same transaction as the write. Postgres triggers reject UPDATE/DELETE on audit and
   version tables, so even a buggy application path cannot rewrite history. See ADR-0002 and
   [regulatory-traceability.md](regulatory-traceability.md).

4. **Standards as the interface.** ODM v2.0 (XML + JSON) for study metadata exchange,
   Dataset-JSON v1.1 for data exchange, CDASH-aligned example CRFs. The archive format of a
   study must outlive the running system.

5. **Analysis code is a first-class, audited artifact.** R and Python scripts execute
   server-side in isolated containers against read-only snapshots; scripts, logs, and outputs
   are versioned. This directly serves ICH E6(R3)'s transformation-traceability expectations.
   See ADR-0004.

## Data lifecycle

```
capture (Postgres, audited)
  → snapshot (worker publishes versioned Parquet into DuckLake)
    → analysis/review (DuckDB SQL, R/Python workbench — read-only)
      → export (Dataset-JSON v1.1, CSV, Parquet, full ODM archive)
        → archive/retention (self-contained study archive)
```

Point-in-time correctness comes from DuckLake snapshot versioning: an interim analysis or a
database lock references an immutable snapshot ID, reproducible indefinitely.

## Monorepo layout

- `apps/web` — SPA; talks only to the REST API via `/api/*`
- `apps/api` — Fastify server + background workers (snapshot sync lives here, not in a separate service, until scale demands otherwise)
- `packages/schemas` — zod schemas shared by API and web (single source of truth for payload shapes)
- `packages/odm` — ODM v2.0 parsing/validation/serialization; no runtime dependency on the API
- `packages/rules` — edit-check expression engine, evaluable in browser and server
- `services/r-engine` — R runtime container; communicates with the API over HTTP (plumber)
- `services/py-engine` — Python runtime container; same HTTP execution contract as the R engine
- `infra` — Compose stack; the deployment unit is a set of OCI containers

## Decision records

See [docs/adr/](adr/) — one record per consequential decision, including rejected alternatives.

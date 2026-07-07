# ADR-0008: Per-study DuckLake catalogs and the sandboxed analytics workbench

**Status:** accepted · 2026-07-06

## Context

Phase 5 makes self-service operational analytics a first-class feature: data
managers should query study data with modern SQL and R inside the EDC, not
through a vendor-locked report builder (the pain point of commercial EDCs).
That means executing analyst-authored code on the server, which raises three
design questions: where the data lives, how runs stay reproducible, and how
arbitrary code is contained.

During Phase 5 planning we also revisited whether DuckLake was worth keeping
at all, given Postgres is already required. Decision: yes — the lake adds no
server (its catalog *is* our Postgres, its storage is Parquet files), and it
provides the two properties Postgres alone would make us hand-build:
snapshot time travel (E6-07) and an isolation boundary between analyst
workloads and live capture.

## Decision

**One DuckLake catalog per study.** Each study gets its own catalog schema
in Postgres (`ducklake_<study_oid>`) and its own Parquet subdirectory under
`LAKE_DATA_PATH`. Publishing a snapshot rewrites the study's tables —
`subjects`, `queries`, and one typed, analysis-ready table per ODM item
group (the CDISC dataset grain) — in a single DuckLake transaction, then
pins the resulting per-study lake version in the `snapshots` bookkeeping
table.

**Reproducibility by construction.** Every reader — SQL workbench, R engine,
exports — sees manifest tables as views pinned `AT (VERSION => n)`. A query
or export re-run months later, after any number of newer snapshots, returns
identical data.

**Containment in layers.** Workbench sessions get: (1) only their study's
catalog, attached `READ_ONLY` — other studies and the transactional database
are unreachable, making study isolation an attach-time boundary rather than
a convention; (2) a locked DuckDB session — `allowed_directories` limited to
the study's Parquet directory, `enable_external_access=false` (no file
reads, `COPY TO`, `ATTACH`, or extension installs), `lock_configuration=true`
so user code cannot undo any of it; (3) row caps and interrupt-based
timeouts. The R engine applies the identical setup inside its container,
executing each script in a fresh subprocess; for R, the *container* is the
process-level boundary while the DuckDB lockdown protects the data layer.

**Version coupling.** The Node API's embedded DuckDB (`@duckdb/node-api`)
is pinned to the same DuckDB minor as the R `duckdb` package so both sides
speak the same DuckLake catalog format. Bump them together.

**Positioning.** The workbench is *operational* analytics — enrollment,
query aging, data cleaning status — not a validated statistical compute
environment. The UI says so. Executions are audited (SQL text; for R the
full script content, snapshot ID, logs, and outputs are persisted —
E6-04), and saved scripts are versioned append-only.

**Python later.** A Python sidecar can implement the same execution
contract (attach payload in, `{ok, stdout, resultColumns, resultJson}` out)
with zero changes to the API or UI beyond a language tag.

## Consequences

- No analytics server to operate; the cost is Parquet storage and catalog
  schemas that multiply per study (dozens of tables each — acceptable).
- Analysts' queries can never load or corrupt live capture; worst case they
  burn CPU in a capped, interruptible session.
- Snapshot versions are per-study and strictly ordered, which keeps the
  `snapshots` table's `lakeVersion` a stable, human-meaningful handle
  ("extract v3, the DB-lock snapshot").
- DuckLake catalog-format compatibility now constrains dependency upgrades
  (Node and R must move in lockstep).

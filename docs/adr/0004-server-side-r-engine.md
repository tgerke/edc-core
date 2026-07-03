# ADR-0004: Server-side R engine as an isolated container

**Status:** accepted · 2026-07-02

## Context

Clinical programmers predominantly work in R (admiral, dplyr, arrow ecosystem). The system
needs custom queries and data transformations that are themselves auditable. Alternatives
considered: webR in the browser (sandboxed, zero server management, but limited packages,
limited performance, and no server-side scheduled transformations) and no embedded runtime
(forcing export/re-import round-trips).

## Decision

- R runs in its own container (Rocker base) exposing a plumber HTTP API to `apps/api`.
- The R engine has read-only credentials to the DuckLake analytics layer only — it can
  never write to capture tables.
- Scripts are stored and versioned server-side; every execution records script version,
  inputs (snapshot ID), logs, and outputs.
- GPL licensing of R is a non-issue: the engine is a separate process/container, and the
  project is AGPL anyway (ADR-0005).

## Consequences

- Full CRAN availability; transformations are reproducible and traceable (ICH E6(R3)).
- Python (or webR for in-browser exploration) can be added later using the same sidecar
  pattern without architectural change.

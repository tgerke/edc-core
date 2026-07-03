# ADR-0001: PostgreSQL as system of record, DuckLake as analytics layer

**Status:** accepted · 2026-07-02

## Context

An EDC has two very different data workloads. Capture: thousands of small concurrent
transactional writes from many sites, each requiring row-level audit, locking, and
fine-grained access control. Analysis: columnar scans over versioned, point-in-time
datasets for review, exports, and statistics. DuckDB/DuckLake was considered as the
sole store: DuckLake v1.0 (April 2026) is production-ready and supports multi-writer
ACID via a Postgres catalog, but it remains optimized for analytical mutation patterns,
not high-concurrency row-level OLTP with triggers and row security.

## Decision

- PostgreSQL (16+) is the transactional system of record: subject data, item value
  versions, audit events, users/roles, queries, signatures.
- DuckLake (Parquet + DuckDB) is the analytics layer, fed by a snapshot worker.
  The same Postgres instance serves as the DuckLake catalog — one stateful service.
- Analysis consumers (R engine, export jobs, review datasets) read only from DuckLake
  snapshots, never from live capture tables.

## Consequences

- Audit immutability can be enforced with Postgres triggers (see ADR-0002).
- DuckLake snapshot versioning gives reproducible point-in-time extracts (interim
  analyses, DB lock) essentially for free.
- Cost: a sync worker and snapshot-lag semantics; analysis sees data as of the last
  published snapshot, which is acceptable (and arguably desirable) for clinical review.

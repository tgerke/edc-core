# ADR-0003: ODM v2.0-shaped, versioned study metadata as the single build interface

**Status:** accepted · 2026-07-02

## Context

Traditional EDC study builds are point-and-click-only, slow, and unportable. CDISC ODM v2.0
is the current vendor-neutral model for study metadata and data exchange, with XML and JSON
serializations. Builds should be equally possible by GUI, by file import, by API script, or
by an LLM agent — without divergent representations.

## Decision

- Internal study metadata (events, forms, item groups, items, codelists, conditions/methods)
  is modeled on ODM v2.0 semantics and stored as versioned metadata in Postgres.
- ODM v2.0 import (XML + JSON) creates or increments a study metadata version; export
  round-trips it. `packages/odm` owns parse/validate/serialize and is tested against
  official CDISC example files.
- The visual study builder and the import/API paths write through the same versioned
  metadata API. Data exports use Dataset-JSON v1.1; ODM v1.3.2 import is a later shim.

## Consequences

- Study builds are diffable, portable, reviewable artifacts — and scriptable/LLM-friendly.
- Constraint: features must map to ODM semantics or use ODM's extension mechanism;
  no proprietary parallel metadata.

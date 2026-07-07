# Changelog

## v0.1.0 — first usable release (2026-07)

The core capture MVP, end to end: build a study from CDISC ODM, capture
data against it, review it, sign it, snapshot it, and analyze it — with
21 CFR Part 11 / ICH E6(R3) mechanisms designed in, not bolted on.

### Study build
- CDISC ODM v2.0 import/export (XML + JSON), validated against official
  CDISC examples; versioned, immutable study builds (`packages/odm`)
- Study builder UI with live form preview; file-driven and UI builds hit
  the same versioned-metadata API (LLM-scriptable for free)

### Capture
- Metadata-driven CRF renderer; subject matrix; entry workflow state
  machine (not started → in progress → complete → verified → signed →
  locked) enforced server-side (P11-13)
- Append-only item value versions with reason-for-change; audit trail
  written in the same transaction, UPDATE/DELETE rejected by trigger
  (P11-01, ADR-0002)
- JSONata edit checks (ADR-0007) evaluated client-side for instant
  feedback and server-side as source of truth; failing checks raise system
  queries that auto-close when the data is corrected

### Review
- Threaded query lifecycle: open → answered → closed with monitor reopen;
  manual + system queries; study-wide dashboard (E6-08)
- Part 11 e-signatures: re-authentication at signing, SHA-256 record hash
  over the exact signed content, one-way invalidation when a form becomes
  editable again (P11-08..11)
- Audit review UI: filter by action/entity/actor/time, CSV export (E6-03)

### Analytics (ADR-0008)
- Per-study DuckLake snapshots: immutable point-in-time datasets with lake
  version pinning (E6-07); typed, analysis-ready tables at the CDISC
  dataset grain
- Self-service workbench: sandboxed DuckDB SQL and server-side R (Rocker +
  plumber sidecar) against pinned snapshots; versioned scripts; every
  execution recorded with content, snapshot, logs, and outputs (E6-04)
- Exports: Dataset-JSON v1.1 (SC-02), CSV, Parquet; full study archive zip
  (ODM metadata + data + audit trail + signature manifest, P11-06)

### Foundation
- Auth: Argon2, session timeout, lockout, password policy; RBAC scoped
  per-study/per-site with six default clinical roles (P11-03, E6-05)
- Validation pack per release: traceability matrix joined to this exact
  commit's test results (P11-05, E6-02)
- CDASH-aligned demo study + one-command seed (`db:seed-demo`, SC-03)
- Compose stack (Podman/Docker) and versioned GHCR images

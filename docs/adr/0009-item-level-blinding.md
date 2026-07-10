# ADR-0009: Item-level blinding in the build, enforced at every egress path

**Status:** accepted · 2026-07-10

## Context

Randomized trials need role-based blinding: treatment-related values (dose,
kit number, arm-revealing labs) must be invisible to monitors and other
blinded roles while site staff enter and see them normally. Blinding has to
hold at *every* place data leaves the system — the live form read, PDF
casebooks, study archives, the audit trail, and the entire analytics surface
(SQL workbench, R engine, exports) — or it holds nowhere.

Two design questions: where does the "this item is blinded" fact live, and
how is it enforced across paths that read from two different stores
(Postgres for live capture, the DuckLake lake for analytics)?

## Decision

**The flag lives in the study build.** `ItemDef.blinded` in the typed model,
serialized as the vendor-extension attribute `edc:Blinded="Yes"` (namespace
declared on the ODM root). Blinding is protocol metadata: putting it in the
build makes it versioned and immutable with everything else, pinned per form
instance, carried through amendment diffs and migrations for free, and
round-tripped through ODM export/import. A parallel configuration table would
drift from the builds it describes.

**Visibility is a permission, `data.unblind`,** granted by default to the
roles that handle values (investigator, data_entry, admin) and withheld from
monitor, data_manager, and read_only. Deployments adjust via the ordinary
audited role grants. There is deliberately no `isSystemAdmin` bypass — a
system administrator unblinding themselves must leave an audit trail.

**Enforcement is structural where possible, per-viewer where necessary:**

- **Analytics lake (structural):** `collectDatasets` skips blinded items at
  snapshot publish, so their columns never exist in the lake. The SQL
  workbench, R engine, Dataset-JSON/CSV/Parquet exports, and archive datasets
  are therefore blinded by construction — there is nothing to leak. Excluded
  OIDs are recorded in the snapshot manifest.
- **Live form read (per-viewer):** values of blinded items are masked
  server-side (row kept, value withheld, `blinded: true` flagged) against the
  form's *pinned* build; the UI renders a locked field. Writes to blinded
  items by roles without `data.unblind` are rejected — a blind role must not
  overwrite what it cannot see.
- **Casebooks:** masked (`[BLINDED]`) unless the requester holds
  `data.unblind`; archives always use the blinded rendering (they are
  shareable artifacts).
- **Audit review:** blinded reviewers see who changed a blinded item, when,
  and the stated reason — but old/new values are masked server-side (API and
  archive CSV). This is the standard blinded audit-review posture.

## Consequences

- Blinded values remain fully captured, versioned, and auditable in Postgres;
  only their *visibility* is role-scoped. A permission-gated unblinded export
  (e.g. post-lock) can be added later without schema changes.
- Derived leakage is the build author's responsibility: a non-blinded item
  computed from a blinded one, or a check message that quotes an expected
  value, leaks by construction. Import emits a warning whenever an edit check
  references a blinded item.
- Snapshot structure derives from the latest build, so an item blinded in the
  latest build is excluded from the lake even for data captured under older
  builds — the conservative direction.
- Free-text query answers can quote blinded values; that is an SOP matter,
  not enforceable mechanically.

# ADR-0012: USDM protocol ingestion compiles to ODM through the single build path

**Status:** accepted · 2026-07-18

## Context

Study builds start from the CRF side today: someone reads the protocol document and
transcribes its schedule of activities and data requirements into forms (ADR-0003 paths:
ODM import, visual builder, script). CDISC/TransCelerate USDM v4 makes the protocol itself
machine-readable — encounters, activities, timing, and biomedical concepts (BCs), which the
USDM-IG added expressly to support EDC automation. ICH M11 (CeSHarP, Step 4 final
2025-11-19) points the industry at structured protocols, and USDM v4 is aligned to
represent M11 content. A protocol-first path removes the transcription step: the sponsor
governs what data the protocol requires; forms become a presentation over it.

## Decision

- A USDM v4 JSON package is a first-class, versioned, append-only artifact
  (`protocol_versions`, same immutability trigger as study builds). `packages/usdm` owns
  parse/validate/graph helpers and the compiler; `packages/odm` stays protocol-format-agnostic.
- The compiler (`usdmToBuild`) produces an ODM v2.0 `MetaDataVersion` published through
  `importStudyBuild` — the existing single write path — so capture, checks, amendments,
  snapshots, and exports are untouched. Encounters become events, each scheduled activity
  becomes a form shared across its events, BCs resolve to shared items/codelists.
- Provenance is dual: authoritative `edc:` vendor extensions inside the build (UsdmRef ids,
  planned timing and windows, protocol-source attributes; ADR-0009 pattern, round-trips
  both serializations), plus a derived, regenerable `protocol_traceability` table for joins.
- Compiler OIDs derive from stable protocol names/c-codes — not USDM UUIDs, which churn
  between authoring-tool exports — so recompiled amendments diff cleanly (`diffBuilds`).
- Surrogate/unmatched concepts become draft items flagged `edc:Unresolved`;
  `validateMetaDataVersion` rejects them, so published builds are always capture-ready.
  The mutable review workspace (`protocol_compilations`) holds candidates until then.
- BC resolution uses a bundled mapping pack curated offline from the open, MIT-licensed
  COSMoS dataset (pinned commit sha recorded in the pack) and cross-checked against a
  local CDASHIG v2.3 CSV that is never committed — the pack carries only structural
  metadata (c-codes, variable names, datatypes, codelist terms), no CDISC publication
  text. No CDISC Library API dependency at runtime.
- Excel authoring is supported through the external `usdm4-excel` converter plus
  documentation, not in-app xlsx parsing: the import endpoint accepts standard USDM JSON,
  so any authoring tool works identically and we do not maintain a parser for a moving
  workbook format.

## Consequences

- The traditional paths are unchanged; "three ways to build" becomes four, all landing in
  `study_metadata_versions`.
- Timing/visit windows are carried losslessly as extensions but not yet enforced by a
  scheduling engine; conditional flow (scheduled decision instances) surfaces as manual
  follow-up warnings rather than compiled logic.
- Constraint inherited from ADR-0003 holds: protocol semantics must map to ODM or ride
  its extension mechanism.

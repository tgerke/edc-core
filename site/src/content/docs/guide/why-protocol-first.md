---
title: "Why protocol-first?"
---


edc-core can build a study two broad ways: you can design the forms yourself
(ODM import, the visual builder, or a script), or you can hand it a structured
protocol and let it derive the data requirements for you. This page explains
what that second path is, why it exists, and when to use it. No prior
familiarity with the standards involved is assumed.

## The protocol as data, not just a document

A clinical protocol already contains most of what an EDC needs: which visits
happen, what gets assessed at each one, what the visit windows are, and what
data each assessment produces. Traditionally all of that lives in a Word or
PDF document, and someone on the study team re-types it into the EDC as forms.

A *structured protocol* keeps the same content in a machine-readable format,
so software can use it directly. Two standards matter here:

- **USDM** (the Unified Study Definitions Model, from CDISC and
  TransCelerate's Digital Data Flow project) is a data model for study
  designs: visits, the schedule of activities, timing and windows, arms and
  epochs, objectives, eligibility, and the individual data concepts each
  assessment collects.
- **ICH M11** (the Clinical Electronic Structured Harmonised Protocol,
  adopted as a final ICH guideline in November 2025) is a harmonised protocol
  template and exchange format that regulators in the ICH regions are moving
  toward. USDM is aligned so that a USDM study design can populate an M11
  protocol.

If your organization authors protocols in one of these forms, or uses a tool
that exports one, the protocol itself can drive the EDC build.

## The costs of forms-first you already know

If you have set up studies in any EDC, these will be familiar:

- **The schedule of activities gets rebuilt by hand.** The protocol has a
  perfectly good SoA table; someone re-creates it as events and form
  assignments, and someone else checks the transcription.
- **The protocol and the CRFs drift.** Wording, units, and visit windows are
  copied between documents that have no live connection. Each amendment
  re-opens the gap.
- **Amendments are slow.** A protocol change means re-reading the document,
  working out what changed, and editing the build to match, plus the audit
  burden of proving you got it right.
- **The forms are the spec.** What the study *collects* is defined only by
  what the forms happen to contain. There is no separate, checkable statement
  of what the protocol requires.

None of this is a defect of any one vendor. It follows from starting with
forms and treating the protocol as background reading.

## What the protocol-first path changes

When you import a USDM protocol package into edc-core:

- **The SoA arrives machine-readable.** Visits, the activity grid, planned
  timing, and visit windows come straight from the protocol. Nothing is
  re-typed.
- **The data requirements are explicit.** Each assessment's biomedical
  concepts (e.g. *Systolic Blood Pressure*, with its required result and
  optional qualifiers) resolve to concrete collection items through a bundled
  mapping curated from CDISC's open biomedical-concepts dataset. Concepts the
  protocol names without a full definition become clearly flagged drafts for
  a data manager to complete; nothing silently disappears.
- **A default build is generated, with traceability.** The result is a
  normal edc-core study build with the same capture, edit checks, exports,
  and amendment tooling as every other build, plus a recorded link from every
  event, form, and field back to the protocol element it came from. "Why does
  this field exist?" has a queryable answer.
- **Amendments become recompile-and-diff.** A new protocol version compiles
  to a new candidate build, and the existing build-diff and migration
  machinery shows exactly what changed.
- **You still control the result.** The generated build opens in the same
  visual builder as any other; review is expected, not optional. Publishing
  is blocked until every draft item is completed.

## Where the industry is heading

M11's adoption as a final guideline means structured, exchangeable protocols
are the stated direction for regulatory submission in the ICH regions, and
the USDM tooling around it (study design tools, converters, the TransCelerate
reference implementations) is growing. The point of that whole effort is to
digitise the protocol once, at the source, and let downstream systems consume
it. An EDC that ingests it directly is the next step.

Adoption is still early, though. Most protocols in circulation today are
Word documents, most sponsors are still piloting structured authoring, and
the standards themselves continue to evolve. That is why the protocol-first
path is an *addition* in edc-core, not a replacement: the ODM import, visual
builder, and scripted paths remain fully supported, and every path lands in
the same versioned build store.

## Which path should I use?

- **You have (or can produce) a USDM package**, from a study design tool, a
  vendor export, or the Excel authoring route described in
  [Protocol import](/edc-core/guide/protocol-import/): use the protocol-first path and
  review the generated build.
- **You have an existing ODM library or CRF book**: import the ODM directly.
- **You are sketching a small study from scratch**: the visual builder is the
  fastest way to a first build.
- **Unsure**: start forms-first. You can adopt the protocol-first path at any
  point later (including for an amendment) because everything compiles into
  the same build format.

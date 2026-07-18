# ADR-0013: Sponsor-governed data, site-adaptable form layouts

**Status:** accepted · 2026-07-18

## Context

An EDC build fixes both what data is collected and how every site's forms look.
Sites work differently — clinic order, terminology, how many screens a visit
takes — and forcing one sponsor-designed layout on all of them optimises for one
stakeholder. The BYOFW idea ("bring your own forms and workflow", Bain 2026):
the sponsor governs the data, its structure, and its protocol relationship; the
site controls the presentation. The known failure mode is late-stage
sponsor/site cat-and-mouse over site-built forms and data managers facing a
different data shape per site. E6(R3) pulls in both directions: tools "designed
to capture the information required by the protocol" (§3.16.1(d)) and no
unnecessary burden on investigators (§3.1.4).

## Decision

- The governed layer is the published build itself, projected by
  `governedRequirements(mdv)`: every item each event collects, with its
  mandatory flag and canonical group. Computed from ODM, so it works for all
  build paths (ADR-0003, ADR-0012), not just protocol-derived ones.
- A site form variant is a named, append-only-versioned definition that only
  *references* build ItemDefs: regroup into different forms/sections, reorder,
  relabel in site wording. It cannot define data.
- `validateVariantCoverage` makes data-equivalence structural, not reviewed:
  per touched event the variant must cover exactly the governed items (no
  omissions, no additions — additions are a sponsor amendment), may only
  strengthen mandatory flags, cannot regroup items out of repeating groups,
  and cannot touch events the sponsor flagged `edc:LayoutLocked`. Submission
  is blocked while errors remain, so the sponsor's approval queue only ever
  contains provably equivalent layouts — approval reviews workflow
  suitability, which is what kills the cat-and-mouse dynamic.
- Lifecycle: draft → submitted → approved | changes_requested, plus retired
  and stale. Site-scoped `site.forms.manage` authors; `study.manage` decides.
  Every transition is audited; a new approval retires its predecessor.
- Capture pins variant instances (`V.*` form OIDs) to the approved variant
  version, but every value write keys on the item's canonical build group.
  `item_value_versions`, checks, coding, snapshots, exports, and the lake are
  untouched and byte-identical in shape across sites — the one-canonical-shape
  guarantee data managers rely on. The subject matrix intentionally stays on
  the standard (canonical) layout as the oversight view.
- Amendments: inside the build-publish transaction, approved variants are
  revalidated against the new build. Still-equivalent layouts carry forward
  automatically (audited system action); the rest go stale, site and sponsor
  are notified, and capture falls back to the standard forms until an updated
  layout is approved. A variant can never block an amendment.

## Consequences

- Sites get real workflow control with zero data divergence; the sponsor
  reviews far less (equivalence is machine-checked) but keeps explicit
  approval and per-event layout locks.
- Variants are presentation-only by construction: no per-site edit checks,
  no per-site data, no site-specific analytics shape.
- Repeating-group internals cannot be regrouped in v1; those items stay in
  their canonical sections within variant events.
- The variant `definition` jsonb and the per-site `effective-forms` endpoint
  are the seams for future eSource/device workflow layering (lab ordering,
  device pulls scheduled around site workflow), which stays out of scope here.

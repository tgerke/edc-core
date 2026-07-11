# ADR-0010: RTSM as an integration point — assignments land as blinded eCRF items

**Status:** accepted · 2026-07-11

## Context

edc-core deliberately does not randomize. Randomization and trial supply
management (RTSM/IRT) is a distinct, validated product category with its own
regulatory surface (randomization algorithms, drug supply, emergency
unblinding), and ICH E6(R3) itself treats interactive response technologies
as ordinary data-acquisition systems feeding an EDC. What edc-core needs is
the receiving end: an external RTSM posts a subject's treatment-arm
assignment, and it must land with full audit, respect blinding, appear in
capture and casebooks, and reconcile against the RTSM's own transfer log.

Two facts about the existing system shaped the design:

1. **Blinding is ItemDef-OID-keyed** (ADR-0009). Masking exists at form
   reads, casebooks, the audit trail, and structurally at lake publish — but
   only for values living in `item_value_versions` under a blinded ItemDef.
   A bespoke `assignments` table would get none of that for free.
2. **All auth was human** (sessions, OIDC). Machines had no way in, and the
   audit schema requires a real `users` row as actor.

## Decision

**The arm value is written as an ordinary eCRF item** through
`writeItemValue`, exactly like lab imports: the study build defines the
randomization form and a (typically `edc:Blinded`) arm item, and a per-study
`rtsm_configs` row points the intake at those OIDs. Audit, edit checks,
blinding, SDV/signatures, casebooks, and lake exclusion apply by
construction. The configuration is a stored table, not an ODM vendor
extension — integration wiring is deployment config, not protocol metadata,
and it must be editable without cutting a new build.

**Machine auth is a study-scoped API key** (`edcrtsm_` prefix, sha256-hashed,
show-once, revocable — ADR follows the `sessions` hygiene) bound to a
per-study service account `svc-rtsm-<studyId>` holding the seeded
`rtsm_agent` role (`integration.rtsm` + `data.unblind`, granted through the
ordinary audited `grantRole`). A key never becomes a session and can reach
exactly one route: `POST /studies/:id/rtsm/assignments`. The unblind grant is
therefore write-only in practice — a leaked key can post assignments and
nothing else, and revoking the grant (or the key) shuts the integration off.

**Assignments never overwrite.** The decision is made against the item's
current value inside the write transaction: no value → applied (201);
identical value → duplicate (200, idempotent replay); differing value →
conflict (409, nothing written, resolved by humans in the EDC). Unknown
subjects are rejected (422), **not auto-enrolled** — enrollment is a site act
with a site the RTSM doesn't know. No response ever echoes the arm.

**Every POST — including rejects — appends a `rtsm_events` row** (full wire
payload, outcome, reason, link to the written item-value version) protected
by the same `edc_reject_mutation()` trigger as the audit trail. That is the
transfer record E6(R3) §4.2.5 asks for: traceable, reconcilable against the
RTSM's log, and immutable. Because the payload carries the arm, the events
listing masks `arm`/`strata` unless the target item is unblinded in the
build or the viewer holds a study-wide `data.unblind` grant; the table is
deliberately excluded from the analytics lake.

## Rejected alternatives

- **Bespoke assignments table as the source of truth** — re-implements audit,
  blinding, casebook, and lake handling that items already have; the one
  hand-rolled masking spot (the events listing) is the residual cost of
  keeping even the *transfer log*, and it argues for not multiplying such
  surfaces.
- **ODM vendor extension for the intake config** — couples deployment wiring
  to protocol versions; toggling the integration would mean a new build.
- **Session-based machine users** — sessions expire, refresh interactively,
  and grant the whole human route surface; a key that can only post
  assignments is a smaller thing to steal.
- **Auto-enrolling unknown subjects** — hides site/RTSM discrepancies exactly
  where they must surface; the rejected event row is the reconciliation
  signal.

## Scope

No randomization algorithm, drug supply, emergency unblinding, outbound
subject sync, or retry queue. Repeating events/forms are out of scope
(repeat key 1, like lab import). `strata` is stored opaquely and masked with
the arm; mapping strata to additional items is future config.

# ADR-0014: Conditional collection and derived values

**Status:** accepted · 2026-07-18

## Context

The build model has carried ODM's hooks for dynamic forms since ADR-0003:
`CollectionExceptionConditionOID` on ItemRef and `MethodOID` for computed
items both parse, validate, and round-trip. The runtime ignored them. Every
field rendered unconditionally, and the only cross-field behavior was edit
checks (ADR-0007), which raise queries without gating anything. Real
protocols need fields collected only when another answer calls for them
(a pregnancy test when the subject is female), choice lists that narrow,
and values computed from other fields (BMI) rather than typed in.

## Decision

- One pure function, `evaluateFormState` in `@edc-core/rules`, computes the
  full dynamic state of a form from the pinned build and its value rows,
  reusing the ADR-0007 JSONata machinery and its dual-evaluation pattern:
  the browser runs it on every edit for instant feedback, the server runs
  the same code as the authority. Evaluation order is fixed: derivations in
  dependency order, then collection exceptions, then skipped values nulled
  in the evaluation context only, then option exclusions, then edit checks.
  Derivations read raw values; skip conditions read derived values. The
  one-way order makes skip/derive circularity impossible by construction.
- Skip logic honors ODM's `CollectionExceptionConditionOID` on ItemRef and
  ItemGroupRef, excluded-when-true. A skipped group skips its descendant
  groups. Conditions evaluate per occurrence inside repeating groups.
  StudyEventDef-level refs are visit scheduling, not form state, and are
  not honored here.
- Dependent options are a vendor extension: `edc:CollectionExceptionConditionOID`
  on CodeListItem, with the same excluded-when-true polarity so builders
  learn one mental model. Plain-ODM consumers ignore the attribute and see
  the full option list, so exports degrade cleanly.
- Retain and flag, never silently mutate. When a valued field becomes
  skipped, the stored value stays (the audit trail is append-only anyway);
  new writes to the field are rejected while clearing to null stays
  allowed; and a system query opens under a synthetic check OID
  (`SKIP.<condition>.<item>`), auto-closed when the site clears the value
  or the controlling answer changes back. Edit checks evaluate with
  skipped values nulled, so not-collected data cannot fire them.
- Derived values are server-written. After every accepted write, the
  server recomputes from stored values and appends changes with origin
  `derivation` and audit action `item_value.derived`, so system-computed
  values stay permanently distinguishable from entered ones. Clients show
  a local read-only preview and never submit it. Direct writes to derived
  items are rejected on every intake path: the capture route, RTSM, and
  lab import all consult one gate (`assertWriteAllowed`). A skipped
  derived field converges to null through this same audited path rather
  than raising a residual query.
- Derivation inputs are found by scanning expressions for item OIDs, the
  ADR-0007 backtick convention. A dependency cycle is a publish-time
  validation error; the runtime drops cyclic derivations defensively.
- Blinding interplay is a validator warning: a collection exception that
  reads a blinded item can reveal it through visibility changes, and a
  non-blinded item derived from blinded inputs leaks by construction.

## Consequences

- Skip conditions and derivations travel in standard ODM (the option-level
  extension rides the existing `edc:` namespace), and amendment migrations
  recompute derivations because a new build may change method expressions.
- A referenced condition or method without a jsonata expression imports
  with a warning and stays inert: the field is always collected, or the
  derived value never computes. CDISC example files with XPath expressions
  still import unchanged.
- All skip conditions are evaluated in a single pass against the
  post-derivation context: a skip condition that reads another skipped
  field sees its value, not null. Cascading re-evaluation was rejected as
  unpredictable for site users.
- An occurrence-scoped skip of a repeating group propagates only to
  repeating descendants at the same occurrence. When propagation is
  ambiguous, the field stays collected: collecting too much is recoverable,
  hiding a field a site needed is not.
- Authoring UI for ConditionDefs and MethodDefs is a follow-up; today the
  constructs arrive through ODM import.

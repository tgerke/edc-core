# ADR-0015: CDMS direction — the workbench becomes the data-cleaning surface

**Status:** accepted · 2026-07-21

## Context

edc-core now covers the EDC feature set end to end: metadata-driven capture,
edit checks, queries, coding, blinding, e-signatures, audit, snapshots, and
exports. The open question is positioning against the wider clinical data
management (CDMS) category — what Medidata Rave, Oracle InForm, Veeva CDMS,
and OpenClinica offer beyond capture, and which of those functions belong
here.

Surveying that category against the codebase:

- **Already competitive:** query lifecycle, JSONata edit checks with
  derivations and skip logic, MedDRA/WHODrug coding, append-only audit with
  reason-for-change, Part 11 signatures, ODM v2.0 round-trip, Dataset-JSON/
  CSV/Parquet exports, lab CSV import through the audited write path, RTSM
  intake, and site-scoped RBAC that maps onto data-manager, monitor, and
  coder roles.
- **The differentiator:** the sandboxed SQL/R/Python workbench over
  immutable snapshots (ADR-0008). Veeva built its CDMS around the same
  idea — a data workbench where cleaning listings run over study data and
  queries are raised from listing rows. Ours has stronger reproducibility
  (pinned lake versions, versioned scripts, audited executions) but is
  analytics-shaped: it can observe study data, not act on it.
- **Gaps:** listings cannot open queries; edit checks evaluate one form
  instance at a time, so cross-form and cross-visit consistency checks are
  impossible to author; data review depth is a single form-level `verified`
  state; database lock is per-form locks plus a published snapshot rather
  than a study-level workflow; lab import stores units verbatim with no
  reference ranges; there is no SAE reconciliation, no ePRO, and no
  submission-dataset generation.

## Decision

edc-core grows into the CDMS role through the workbench rather than through
a parallel reporting or cleaning module. Priorities, in order:

1. **Workbench-to-query bridge (now).** A listing result row becomes a
   manual query through the existing query workflow, in bulk, with
   provenance back to the exact workbench execution and snapshot. The
   sandbox boundary from ADR-0008 does not move: engines still read only
   snapshots. The bridge lives server-side in the API, which resolves and
   validates listing rows against live capture before writing queries —
   stale rows (value changed since the snapshot) are skipped and reported,
   not silently queried. Scheduled script execution and automatic
   operational snapshots follow, so cleaning listings can run on a cadence
   against data no older than a day.

2. **Cross-form edit checks (now).** ConditionDefs gain read access to
   other forms for the same subject, so AE-versus-visit-date and
   conmed-versus-AE consistency checks become authorable in the same
   JSONata convention (ADR-0007). Expressions that reference only local
   items keep today's semantics unchanged.

3. **Review and lock depth (next).** Item-level SDV flags with targeted-SDV
   configuration, a freeze state distinct from lock, a study-level database
   lock workflow with a pre-lock checklist, and a medical-review track.
   E6(R3) Annex 1 §4.2.3 expects data review whose "extent and nature
   should be risk-based, adapted to the individual trial"; a single
   form-level verified state cannot express that.

4. **External data management (later).** Lab reference ranges and unit
   conversion, lab import into repeating item groups, an SAE reconciliation
   seam (likely a workbench listing pattern over an import surface rather
   than a bespoke module), and a general inbound bulk-data API.

**Out of scope, deliberately.** Submission outputs — SDTM dataset
generation, define.xml, SAS XPT — stay outside the product. The USDM
package keeps its SDTM mapping hints as metadata, but dataset construction
for submission belongs to the sponsor's validated statistical environment,
consistent with the workbench's stated positioning. ePRO remains a future
layering on the form seams from ADR-0013.

## Rejected alternatives

- **Prebuilt cleaning dashboards as application pages** — a report builder
  is the part of commercial EDCs users route around (ADR-0008's original
  complaint). Canned metrics, where wanted, should ship as versioned
  workbench scripts users can read and fork, not as hard-coded pages.
- **Letting sandboxes read live capture for fresher cleaning data** — moves
  the isolation boundary that makes analyst code safe by construction.
  Frequent snapshots achieve the freshness without touching the boundary.
- **A bespoke discrepancy module beside the query system** — the query
  lifecycle, audit, and notifications already exist; a second discrepancy
  surface would split DM work across two trackers.

## Consequences

- The workbench stops being read-only in effect: its output can create
  work items (queries) for sites. Creation therefore requires the query
  permission, not the analytics permission, and every created query records
  the execution, script version, and snapshot it came from.
- Cross-form checks make check evaluation subject-scoped on writes to
  referenced forms; builds that never use them pay nothing.
- The traceability matrix rows E6-04 and E6-08 widen as these land, in the
  PRs that carry the test evidence.

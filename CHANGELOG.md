# Changelog

## Unreleased

### Dynamic and linked fields (ADR-0014)
- Skip logic: `CollectionExceptionConditionOID` on ItemRef and ItemGroupRef
  is now enforced at runtime — skipped fields hide in capture, writes to
  them are rejected on every intake path (UI, RTSM, lab import), and a
  value already saved in a field that becomes skipped raises a system
  query until the site clears it or the controlling answer changes back
- Dependent option lists: a new `edc:CollectionExceptionConditionOID`
  vendor extension on CodeListItem withdraws an option when its condition
  is true; plain-ODM consumers see the full list
- Derived values: `MethodDef` jsonata expressions now compute item values
  server-side after every accepted write (audited as `item_value.derived`),
  with a live read-only preview in form entry; direct writes to derived
  items are rejected, and derivation cycles fail build validation
- Edit checks are skip-aware (not-collected fields cannot fire them), and
  the client and server evaluate one shared pipeline, extending the
  ADR-0007 dual-evaluation pattern
- The demo study now exercises all three: a pregnancy-test item skipped
  for male subjects, a conditional "Not performed" option, and a BMI item
  derived from height and weight

## v0.5.0 — Protocol-first builds and site form layouts (2026-07)

Two halves of one idea (BYOFW: the sponsor governs the data, sites adapt
the forms that capture it), grounded in CDISC USDM v4 and timed to ICH
M11's adoption as a final guideline (November 2025).

### Protocol-first build path (ADR-0012)
- Import a USDM v4 protocol package (JSON; Excel authoring via the
  external usdm4-excel converter is documented) as an immutable,
  versioned protocol artifact
- The compiler derives the build from the protocol: encounters → events
  (with planned timing and visit windows carried as `edc:` extensions),
  scheduled activities → forms, biomedical concepts → items/codelists
  via a bundled mapping pack curated from the open COSMoS dataset
  (MIT, pinned sha; no CDISC text or runtime CDISC Library dependency)
- A review screen shows the protocol's schedule of activities with
  per-concept resolution status; surrogate/unmatched concepts become
  draft items that must be completed before publish, so published
  builds are always capture-ready
- Publishing runs through the same single build write path as ODM
  import and the visual builder; per-field protocol traceability is
  recorded relationally and in the exported ODM (`edc:UsdmRef`)
- New guide pages: "Why protocol-first?" (for readers new to USDM/M11)
  and "Protocol import (USDM)" (including authoring the Excel workbook
  properly)

### Site form layouts (ADR-0013)
- Sites adapt form layout/workflow per site — regroup, reorder, relabel
  — as append-only-versioned variants that only reference build fields
- Data-equivalence is validated structurally on every edit (exact
  coverage of the governed items, no additions, mandatory flags may
  only strengthen); submission is blocked until clean, so the sponsor's
  approval queue reviews workflow, not data integrity
- Capture through an approved layout pins the variant version while
  every value write keys on canonical build identifiers: captured data
  is byte-identical in shape across sites regardless of layout
- Amendments revalidate approved layouts automatically: equivalent
  layouts carry forward, the rest are marked stale with notifications
  and capture falls back to the standard forms
- New permission `site.forms.manage` (site-scoped, seeded to the
  coordinator role); sponsor decisions ride `study.manage`

## v0.4.0 — Python workbench and blinding governance (2026-07)

The analytics workbench speaks Python as well as R and SQL, the engines
move to DuckDB 1.5 in lockstep, and blinding governance gets its missing
half: a documented, append-only break-the-blind event for every unblinding
(E6(R3) Annex 1 §4.1.4). Automated intake stops silently accepting data
for subjects who left the study, and two operational rough edges — RTSM
config by free-text OID, all-or-nothing UA session binding — get fixed.

### UA-binding kill-switch (#69)
- `EDC_SESSION_UA_STRICT` (default on) controls user-agent-strict session
  binding; `0`/`false` downgrades a UA mismatch from revoke to
  audit-and-rebind, mirroring IP-change handling, for environments where
  UA churn is legitimate (managed browser rollouts, UA-freezing policies)
- Lax-mode mismatches still audit as `auth.session_binding_violation`
  (with `enforced: false`), so anomaly detection keeps seeing them

### RTSM panel OID pickers (#68)
- The RTSM config's free-text OID inputs are cascading pickers driven by
  the latest study build (event → form → item group → arm item, labeled
  by name with a blinded marker); server-side validation unchanged

### Status-aware RTSM intake and lab import (#67)
- Automated intake refuses subjects who are out of the study: RTSM
  assignments for withdrawn/screen-failed subjects are `rejected` (422,
  reconcilable event row), lab-import rows are skipped and reported
  (`skipped_subject_status`)
- Completed subjects still accept data (post-completion results are
  routine); reinstatement is the correction path
- No migration; humans are unaffected (statuses remain disposition, not
  locks)

### Explicit break-the-blind action (#66, E6-13)
- Per-subject unblind action gated by `data.unblind`: category (planned, or
  unplanned — emergency/inadvertent/other, the E6(R3) §4.1.4 taxonomy) and
  reason required
- Events land in the new append-only `subject_unblindings` table (migration
  0020) and the audit trail (`subject.unblinded`); the subject matrix shows
  an *unblinded* badge and the casebook PDF prints an "Unblinding events"
  section
- Recording only: masking of blinded values stays governed by
  `data.unblind` grants

### Python workbench sidecar (#65)
- `services/py-engine`: Python analytics engine with the same execution
  contract and containment as the R engine — study-scoped READ_ONLY lake
  attach, version-pinned views, locked DuckDB session, fresh subprocess per
  run; duckdb pinned 1.5.x in lockstep with the API (#64)
- The workbench gains a Python tab; scripts save and version under
  `language: "python"`, and every execution records its exact content,
  snapshot, logs, and outputs (the E6-04 pattern, identical to R)
- New published image `ghcr.io/tgerke/edc-core-py-engine`; compose service
  `py-engine` (host port 8001)
- No database migration: the language columns were already free-text

### DuckDB 1.5 / DuckLake spec 1.0 lockstep upgrade (#64)
- `@duckdb/node-api` 1.5.4-r.1 and R `{duckdb}` 1.5.4.2 upgraded together
  (the catalog format requires matching minors; ADR-0008 constraint)
- Existing per-study lake catalogs migrate to DuckLake spec 1.0
  automatically at API boot; failures log without blocking startup
- Note: catalogs migrated to spec 1.0 are no longer attachable by pre-1.5
  builds — upgrade API and engines together

### Development infrastructure
- `pnpm test` runs against a dedicated `<db>_test` database recreated
  fresh per run (with its own lake directory), so test runs no longer
  pollute the development database (#73)

## v0.3.0 — security monitoring and a complete traceability matrix (2026-07)

The traceability matrix reaches all-🟢: every requirement row now maps to
an implemented, tested mechanism. New requirements enter the matrix as
🟡/⚪ before they are claimed.

### Security anomaly detection (#58, E6-06)
- Periodic sweep over the access log and audit trail: failed-login bursts
  per source address (`EDC_ANOMALY_FAILED_LOGIN_THRESHOLD` within
  `EDC_ANOMALY_WINDOW_MINUTES`, defaults 10 within 15), account lockouts,
  and session binding violations
- Findings are materialised once (deduplicated), notify system
  administrators (email too, with SMTP configured), and wait for review at
  **Anomalies**; acknowledgement — the recorded incident response per
  ICH E6(R3) 3.16.1(w) — is written to the audit trail

### Data lifecycle documentation (#59, closes E6-01)
- New top-level docs page mapping every ICH E6(R3) Annex 1 §4.2 lifecycle
  element (capture → audit trails → review → corrections → transfer →
  finalisation → retention → destruction) to its system mechanism and the
  sponsor-side procedure it expects
- Corrected the matrix's E6-01 citation: the adopted E6(R3) guideline
  contains only Annex 1 (the old "(§4, Annex 1/2)" reference was wrong)

### Documentation refresh (#60)
- All screenshots recaptured against the current UI (notification bell,
  subject lifecycle badges, study-page integration panels); new screenshots
  for users admin, study team, access log, security anomalies, and the
  medical coding work queue
- User guide gains the Security anomalies section; README feature list
  caught up with what has shipped

Migration 0019 (security anomalies; `notifications.study_id` nullable).

## v0.2.0 — integrations, administration, and deployment hardening (2026-07)

Closes out the traceability matrix's last planned rows (P11-14 device
checks, DP-02 hosting guidance): every Part 11 and data-protection row is
now 🟢 or explicitly tracked 🟡.

### RTSM integration (#46, #47, ADR-0010)
- Machine auth: study-scoped `edcrtsm_` API keys bound to auditable
  service accounts; keys reach intake routes only — a leaked key can post
  assignments and nothing else
- Assignment intake endpoint: idempotent replays, conflicts reported and
  never written, the arm never echoed back; append-only `rtsm_events` as
  the reconciliation basis (E6-11); blinded arms land on blinded items

### User & team administration (#48, #49)
- Account lifecycle: create/deactivate/reactivate/unlock, show-once
  temporary passwords gated server-side to the change-password flow,
  deactivation revokes live sessions immediately (E6-05)
- Per-study Team page: grants and revocations at study or site scope,
  fully audited; revoke-then-regrant fixed to be an ordinary sequence

### Subject lifecycle (#50)
- Screening → enrolled | screen-failed; enrolled → completed | withdrawn;
  terminal states reversible by audited reinstate; reasons required and
  recorded in the audit trail (E6-01)

### Access evidence (#51, #56)
- Session binding (P11-14, §11.10(h)): sessions bound to the issuing
  client — a token presented by a different user-agent is revoked and
  audited; IP changes audited without ending the session
- Structured access log: one row per API request with system-admin review
  UI and CSV export; `EDC_TRUST_PROXY` records real client addresses
  behind reverse proxies (opt-in, spoofing-aware)

### Deployment (#52, #54)
- Deployment guide (DP-02): encryption in transit/at rest, paired
  database+lake backups sized to the records-retention period, log
  retention, GDPR/HIPAA hosting posture, production checklist
- Web image rebuilt as a static nginx build — no more Vite dev server in
  release images; ~52 MB runtime layer, same port and proxy contract

### Fixes
- Notification scan scoped per study (test-stability fix, #45)

Migrations 0014–0018 (API keys, RTSM intake, user admin, regrant fix,
access log).

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

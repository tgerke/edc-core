# Changelog

## Unreleased

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

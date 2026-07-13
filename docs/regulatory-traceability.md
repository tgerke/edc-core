# Regulatory traceability matrix

A living map from regulatory requirements to system features, implementation status, and test
evidence. PRs implementing a requirement reference its ID; releases ship this matrix plus
automated test evidence as the **validation pack**.

**Scope note.** A software product cannot *be* compliant by itself — sponsors validate their
implementation and own their SOPs. This matrix exists to make that validation cheap and to
show that every requirement has a designed, tested mechanism.

Status legend: 🟢 implemented · 🟡 in progress · ⚪ planned

## 21 CFR Part 11 — Electronic Records; Electronic Signatures

| ID | Requirement (citation) | System mechanism | Status |
|---|---|---|---|
| P11-01 | Secure, computer-generated, time-stamped audit trails for create/modify/delete; prior values not obscured (§11.10(e)) | Append-only version rows + DB triggers rejecting UPDATE/DELETE (ADR-0002) | 🟢 `audit.test.ts` |
| P11-02 | Audit trail retained as long as the record, available for review and copying (§11.10(e)) | Append-only trail with review UI (filter by action/entity/actor, paginated) and CSV export; full trail included in the study archive | 🟢 `audit.test.ts`, `snapshots.test.ts` |
| P11-03 | System access limited to authorized individuals (§11.10(d)) | Unique accounts, RBAC scoped per-study/per-site, session timeout, lockout; admin account-lifecycle UI (create, deactivate/reactivate, unlock) with immediate session revocation | 🟢 `auth.test.ts`, `admin-users.test.ts` |
| P11-04 | Authority checks: only authorized users can use the system, sign, or alter records (§11.10(g)) | Permission guards on every mutating route; signing permission is role-gated | 🟢 `auth.test.ts`, `capture.test.ts`, `signatures.test.ts` |
| P11-05 | Validation of systems to ensure accuracy, reliability, consistent intended performance (§11.10(a)) | Versioned releases; `pnpm validation-pack` joins this matrix to the commit's test results; the release workflow generates it per tag and attaches it to the GitHub release | 🟢 |
| P11-06 | Accurate and complete copies of records in human-readable and electronic form (§11.10(b)) | Single-bundle study archive zip (ODM metadata for every build + Dataset-JSON/CSV data pinned to a snapshot + full audit CSV + signature manifest + per-subject PDF casebooks) plus per-table exports | 🟢 `snapshots.test.ts`, `casebook.test.ts` |
| P11-07 | Record protection for accurate retrieval throughout retention period (§11.10(c)) | Self-contained archive format (ODM XML/JSON + Dataset-JSON + audit + signatures + human-readable PDF casebooks) that outlives the system | 🟢 `snapshots.test.ts`, `casebook.test.ts` |
| P11-08 | E-signatures unique to one individual, not reused/reassigned (§11.100(a)) | Signatures bound to unique user accounts; re-auth credentials must belong to the session user | 🟢 `signatures.test.ts` |
| P11-09 | Signature manifest: printed name, date/time, meaning (§11.50) | Signature records carry signer full name, UTC timestamp, and meaning; manifest shown on the form | 🟢 `signatures.test.ts` |
| P11-10 | Signatures linked to their records; not excisable or transferable (§11.70) | SHA-256 record hash over form identity, pinned build, and every current value version; DB trigger forbids signature UPDATE/DELETE beyond one-way invalidation | 🟢 `signatures.test.ts`, `audit.test.ts` |
| P11-11 | Two distinct identification components; re-entry at signing in a continuous session (§11.200(a)) | In-app re-authentication (username + password) at each signing event; failures audited and counted toward lockout; any transition back to editable invalidates live signatures | 🟢 `signatures.test.ts` |
| P11-12 | Password controls: uniqueness, periodic checks, deauthorization on compromise (§11.300) | Argon2 hashing, configurable password policy, lockout; admin deauthorization (deactivate / reset) revokes all live sessions; admin-issued passwords are show-once temporaries gated server-side to the change-password flow; self-service change requires the current password and invalidates other sessions | 🟢 `password.test.ts`, `auth.test.ts`, `admin-users.test.ts` |
| P11-13 | Operational/sequence checks enforcing permitted step order (§11.10(f)) | Entry workflow state machine (not started → … → signed → locked) enforced server-side | 🟢 `capture.test.ts` |
| P11-14 | Device/terminal checks where required (§11.10(h)) | Sessions bound to the issuing client: a token presented by a different user-agent is revoked and the violation audited; IP changes audited without ending the session; structured access log (one row per API request: user, session, source address, client, status) with a system-admin review UI (`/admin/access-log`) and CSV export | 🟢 `access-log.test.ts` |

## ICH E6(R3) — Good Clinical Practice

| ID | Requirement (section) | System mechanism | Status |
|---|---|---|---|
| E6-01 | Data governance across the data lifecycle: capture → validation → transfer → storage → destruction (Annex 1 §4.2) | Metadata-driven capture: the versioned study definition *is* the documented capture/validation logic; audited subject lifecycle (screening/enrolled/screen-failed/completed/withdrawn with reasons); `site/data-lifecycle.qmd` maps every §4.2 lifecycle element to its system mechanism and the sponsor-side procedure it expects | 🟢 `study-builds.test.ts`, `capture.test.ts`, `subject-lifecycle.test.ts` |
| E6-02 | Computerized systems validated proportionate to risk | Deterministic versioned builds; validation pack ships per release with full automated test evidence | 🟢 |
| E6-03 | Audit trails enabled by default; metadata defined; routine review expected | Audit always-on (not configurable off); dedicated review UI (`/studies/:id/audit`) with action/entity/actor filters, facets, pagination, CSV export; `audit.review` permission-gated | 🟢 `audit.test.ts` |
| E6-04 | Traceability of data corrections and transformations | Reason-for-change on corrections; workbench executions audited with code text; R runs persist exact script content, version, snapshot ID, logs, and outputs | 🟢 `capture.test.ts`, `snapshots.test.ts` |
| E6-05 | Access management: unique credentials, role-appropriate access, timely revocation | RBAC with per-study/per-site scoping; grants/revocations audited and managed in the per-study Team UI; deactivation revokes live sessions immediately (not at next timeout) | 🟢 `auth.test.ts`, `admin-users.test.ts`, `team.test.ts` |
| E6-06 | Security incident detection and response (§4.3.3(b) "system monitoring", §3.16.1(w) incident reporting) | Periodic anomaly sweep over the access log and audit trail: failed-login bursts per source address, lockouts, session-binding violations; findings notify system administrators and are reviewed at `/admin/security-anomalies`, where acknowledgement (the recorded response) is written to the audit trail | 🟢 `security-anomalies.test.ts`, `access-log.test.ts` |
| E6-07 | Reproducible point-in-time datasets (interim analysis, DB lock) | Per-study DuckLake snapshots (ADR-0008): publishes pin an immutable lake version; all reads/exports/workbench runs use `AT (VERSION => n)` | 🟢 `snapshots.test.ts` |
| E6-08 | Query management supporting data review | Threaded query lifecycle (open → answered → closed, monitor reopen), manual + system-raised, fully audited; study-wide query dashboard | 🟢 `queries.test.ts`, `checks.test.ts` |
| E6-09 | Investigator control over their data and signatures | Site-scoped roles; investigator signature workflow; signature invalidation on change | 🟢 `signatures.test.ts`, `capture.test.ts` |
| E6-10 | Retention and retrievability of essential records | Standards-based study archive zip (open formats only) | 🟢 `snapshots.test.ts` |
| E6-11 | Data transfer, exchange and migration: integrity, documented traceability, reconciliation to avoid loss and unintended modification (§4.2.5) | External data (lab CSV, RTSM assignments) lands through the standard audited write path with origin-tagged audit actions (`item_value.imported` / `item_value.integrated`); transfers never overwrite (identical replays idempotent, differing values reported as conflicts, nothing written); append-only `rtsm_events` records every RTSM POST including rejects as the reconciliation basis | 🟢 `lab-imports.test.ts`, `rtsm-intake.test.ts` |
| E6-12 | Safeguard blinding in data governance: systems design, user accounts, data access, data transfers (§4.1.1) | Item-level blinding (ADR-0009) enforced at form reads, casebooks, audit, and structurally at lake publish; RTSM arm lands on a blinded item via write-only API-key principals; intake events listing masks arm/strata for viewers without study-wide `data.unblind` | 🟢 `blinding.test.ts`, `rtsm.test.ts`, `rtsm-intake.test.ts` |
| E6-13 | Documentation of any planned or unplanned unblinding, including inadvertent or emergency unblinding (§4.1.4) | Explicit per-subject break-the-blind action (`data.unblind`-gated): category (planned / emergency / inadvertent / other) and reason required, recorded in append-only `subject_unblindings` and audited as `subject.unblinded`; surfaced in the audit trail, subject matrix, and casebook PDF; complements the audited `data.unblind` grant history (who *could* see unblinded data) | 🟢 `unblind.test.ts` |

## Data protection

| ID | Requirement | System mechanism | Status |
|---|---|---|---|
| DP-01 | GDPR pseudonymization by design | No direct identifiers in clinical tables by construction; subject keys only; site holds the link | 🟢 |
| DP-02 | GDPR/HIPAA hosting guidance | Deployment guide (`site/deployment.qmd`): TLS termination and secure cookies, volume-level encryption at rest, paired database+lake backups sized to the records-retention period, access-log retention, processor/transfer posture (GDPR Art. 28/32/44), production checklist | 🟢 |

## Standards conformance

| ID | Standard | System mechanism | Status |
|---|---|---|---|
| SC-01 | CDISC ODM v2.0 (XML + JSON) | `packages/odm` import/export, tested against official CDISC examples with round-trips | 🟢 `parse.test.ts`, `study-builds.test.ts` |
| SC-02 | CDISC Dataset-JSON v1.1 | Per-dataset export from pinned snapshots (item OIDs/labels/types from the snapshot manifest) | 🟢 `snapshots.test.ts` |
| SC-03 | CDASH-aligned demo CRFs | `examples/demo-study.xml` (CDASH-aligned events/items/codelists/checks) + one-command `db:seed-demo` | 🟢 |

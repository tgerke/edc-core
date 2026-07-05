# Regulatory traceability matrix

A living map from regulatory requirements to system features, implementation status, and test
evidence. PRs implementing a requirement reference its ID; releases ship this matrix plus
automated test evidence as the **validation pack**.

**Scope note.** A software product cannot *be* compliant by itself — sponsors validate their
implementation and own their SOPs. This matrix exists to make that validation cheap and to
show that every requirement has a designed, tested mechanism.

Status legend: 🟢 implemented · 🟡 in progress · ⚪ planned (phase in parentheses)

## 21 CFR Part 11 — Electronic Records; Electronic Signatures

| ID | Requirement (citation) | System mechanism | Status |
|---|---|---|---|
| P11-01 | Secure, computer-generated, time-stamped audit trails for create/modify/delete; prior values not obscured (§11.10(e)) | Append-only version rows + DB triggers rejecting UPDATE/DELETE (ADR-0002) | ⚪ (1) |
| P11-02 | Audit trail retained as long as the record, available for review and copying (§11.10(e)) | Audit included in study archive exports; audit review UI with filter/export | ⚪ (4) |
| P11-03 | System access limited to authorized individuals (§11.10(d)) | Unique accounts, RBAC scoped per-study/per-site, session timeout, lockout | ⚪ (1) |
| P11-04 | Authority checks: only authorized users can use the system, sign, or alter records (§11.10(g)) | Permission guards on every mutating route; signing permission is role-gated | ⚪ (1/4) |
| P11-05 | Validation of systems to ensure accuracy, reliability, consistent intended performance (§11.10(a)) | Versioned releases, CI test evidence, shipped validation pack (traceability + results) | ⚪ (6) |
| P11-06 | Accurate and complete copies of records in human-readable and electronic form (§11.10(b)) | Full study export: ODM metadata + Dataset-JSON data + audit trail + signatures | ⚪ (5) |
| P11-07 | Record protection for accurate retrieval throughout retention period (§11.10(c)) | Self-contained archive format (ODM XML/JSON + Dataset-JSON); PDF casebooks roadmap | ⚪ (5+) |
| P11-08 | E-signatures unique to one individual, not reused/reassigned (§11.100(a)) | Signatures bound to unique user accounts; accounts never recycled | ⚪ (4) |
| P11-09 | Signature manifest: printed name, date/time, meaning (§11.50) | Signature records carry signer, UTC timestamp, and meaning (e.g., investigator approval) | ⚪ (4) |
| P11-10 | Signatures linked to their records; not excisable or transferable (§11.70) | Signature cryptographically bound to the specific record version; edits flag/invalidate | ⚪ (4) |
| P11-11 | Two distinct identification components; re-entry at signing in a continuous session (§11.200(a)) | In-app re-authentication (ID + password) at each signing event, independent of SSO | ⚪ (4) |
| P11-12 | Password controls: uniqueness, periodic checks, deauthorization on compromise (§11.300) | Argon2 hashing, configurable password policy, lockout, admin deauthorization | ⚪ (1) |
| P11-13 | Operational/sequence checks enforcing permitted step order (§11.10(f)) | Entry workflow state machine (not started → … → signed → locked) enforced server-side | ⚪ (3) |
| P11-14 | Device/terminal checks where required (§11.10(h)) | Session binding + structured access logging | ⚪ (1) |

## ICH E6(R3) — Good Clinical Practice

| ID | Requirement (section) | System mechanism | Status |
|---|---|---|---|
| E6-01 | Data governance across the data lifecycle: capture → validation → transfer → storage → destruction (§4, Annex 1/2) | Metadata-driven capture: the versioned study definition *is* the documented capture/validation logic; lifecycle procedures doc | ⚪ (2/3) |
| E6-02 | Computerized systems validated proportionate to risk | Risk-tiered test strategy in validation pack; deterministic versioned builds | ⚪ (6) |
| E6-03 | Audit trails enabled by default; metadata defined; routine review expected | Audit always-on (not configurable off); dedicated audit review UI with saved review filters | ⚪ (4) |
| E6-04 | Traceability of data corrections and transformations | Reason-for-change on corrections; R engine executions record script version, snapshot ID, logs, outputs | ⚪ (1/5) |
| E6-05 | Access management: unique credentials, role-appropriate access, timely revocation | RBAC with per-study/per-site scoping; admin audit of grants/revocations | ⚪ (1) |
| E6-06 | Security incident detection and response | Structured app/access logging; failed-login surfacing; anomaly reporting (basic) | ⚪ (1+) |
| E6-07 | Reproducible point-in-time datasets (interim analysis, DB lock) | DuckLake snapshot versioning; extracts reference immutable snapshot IDs | ⚪ (5) |
| E6-08 | Query management supporting data review | Threaded query lifecycle (open → answered → closed, monitor reopen), manual + system-raised, fully audited; study-wide query dashboard | 🟢 `queries.test.ts`, `checks.test.ts` |
| E6-09 | Investigator control over their data and signatures | Site-scoped roles; investigator signature workflow; signature invalidation on change | ⚪ (4) |
| E6-10 | Retention and retrievability of essential records | Standards-based archive that outlives the running system | ⚪ (5) |

## Data protection

| ID | Requirement | System mechanism | Status |
|---|---|---|---|
| DP-01 | GDPR pseudonymization by design | No direct identifiers in clinical tables; subject keys only; site holds the link | ⚪ (1) |
| DP-02 | GDPR/HIPAA hosting guidance | Deployment docs: encryption at rest/in transit, backup, access logging | ⚪ (6) |

## Standards conformance

| ID | Standard | System mechanism | Status |
|---|---|---|---|
| SC-01 | CDISC ODM v2.0 (XML + JSON) | `packages/odm` import/export, tested against official CDISC examples | ⚪ (2) |
| SC-02 | CDISC Dataset-JSON v1.1 | Data export format | ⚪ (5) |
| SC-03 | CDASH-aligned demo CRFs | `examples/` demo study | ⚪ (6) |

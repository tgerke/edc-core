---
title: "Data lifecycle"
---


ICH E6(R3) §4.2 is blunt: "Procedures should be in place to cover the full
data life cycle." This page is that map for edc-core: for each lifecycle
element (§4.2.1–4.2.8), what the system enforces by construction, and what
remains yours to write into SOPs and the data management plan. It is the
procedures companion to traceability row E6-01.

:::danger[Mechanisms are not procedures]

edc-core can make a control *impossible to skip* (an audit trail with no off
switch) or *cheap to follow* (a query dashboard). It cannot decide how much
source data verification your trial's risk profile warrants, or when your
retention period ends. Sections below separate the two honestly: rely on the
mechanism, but expect an inspector to ask for the procedure.
:::

## Capture (§4.2.1)

The versioned study build **is** the capture specification. Forms, items,
units, and edit checks are defined in CDISC ODM, versioned as immutable
metadata versions, and every subject is pinned to a specific build, so
"what were we collecting, and how was it checked, on this date?" is a lookup,
not an archaeology project. Changes arrive as
[amendments](/edc-core/guide/study-builds/), with deliberate, audited migration of
existing subjects.

§4.2.1(c) asks for automated validation checks whose implementation is
"controlled and documented". In edc-core, edit checks live *inside* the
versioned build: they fire on every accepted write, raise system
[queries](/edc-core/guide/review/) when violated, and auto-close when the data is
corrected. Changing a check is a metadata amendment: versioned, audited,
and diffable, which is the control and the documentation.

Every captured value carries its metadata (§4.2.1(b)): who wrote it, when,
against which build, and by which path: manual entry, [lab
import](/edc-core/guide/lab-import/) (`item_value.imported`), or [RTSM
integration](/edc-core/guide/rtsm-integration/) (`item_value.integrated`).

**Yours to decide:** the extent of transcription verification for data
transcribed from paper or EHR sources (§4.2.1(a)) is a risk-based call on
data criticality. The form workflow's `verified` state records that review
happened; your data management plan says which forms get it and how much.

## Metadata and audit trails (§4.2.2)

The metadata E6(R3) asks systems to maintain is on by default and cannot be
turned off:

- **User account history** (§4.2.2(a)(i)): account creation, activation
  changes, role grants and revocations are audit events; every API request
  additionally lands in the [access log](/edc-core/guide/user-admin/).
- **Data changes** (§4.2.2(a)(ii)): initial entry and every subsequent
  change or removal are separate versions with actor, timestamp, prior
  value, and, for corrections, a required reason for change.
- **Workflow actions** (§4.2.2(a)(iii)): status transitions, signatures,
  locks, query events, imports, and snapshot publishes are audited alongside
  direct data changes.

§4.2.2(b) expects that audit trails are never disabled and not modified
except in rare, logged circumstances. edc-core has no configuration to
disable auditing, and PostgreSQL triggers reject `UPDATE` and `DELETE` on
audit and version tables outright. The rare legitimate exception E6(R3)
contemplates (a participant's personal information entered where it should
never have been) cannot be performed through the application; it would be a
deliberate database operation by your administrator, and your SOP should
require documenting the action and justification, which is exactly the log
§4.2.2(b) demands.

Timestamps are recorded server-side at write time and exported unambiguously
(§4.2.2(d)); signature manifests display UTC.

**Yours to decide:** which metadata require routine review and how long the
operational access log is kept (§4.2.2(e)); see [log
retention](/edc-core/deployment/#access-logging-and-log-retention) for the
distinction between prunable telemetry and the never-pruned audit trail.

## Review of data and metadata (§4.2.3)

Review "should be a planned activity". The plan is yours; the surfaces are
built:

| Review | Where |
|---|---|
| Data review | [Query dashboard](/edc-core/guide/review/): open/answered/closed lifecycle, manual and system-raised, monitor reopen |
| Audit trail review | `/studies/:id/audit`: filter by action, entity, actor, time; export CSV (`audit.review`-gated) |
| Access review | [Access log](/edc-core/guide/user-admin/) with CSV export |
| Security events | [Anomaly review](/edc-core/deployment/#security-anomaly-detection) with audited acknowledgement |

**Yours to decide:** frequency, sampling, responsibility, and escalation,
risk-based, adapted to the trial, and adjusted on experience, per §4.2.3.
Write it into the data management plan; the CSV exports exist so the review
can be evidenced.

## Data corrections (§4.2.4)

Corrections are attributed (unique accounts, no shared logins), justified (a
reason for change is required on corrections), and never destructive (the
prior value remains in the version history). Correcting a signed form
invalidates the signature one-way: visible, not silent.

**Yours to decide:** timeliness expectations and the requirement that
corrections be supported by source records around the time of original
entry are procedural; the system records *that* and *why* a correction
happened, not whether your source documents agree.

## Transfer, exchange and migration (§4.2.5)

Inbound transfers ([lab CSV](/edc-core/guide/lab-import/),
[RTSM](/edc-core/guide/rtsm-integration/)) go through the same audited write path
as manual entry and **never overwrite**: identical replays are idempotent,
conflicting values are reported and not written. Every RTSM post, including
rejects, lands in an append-only event record, and every import run keeps
its row-level report; both are your reconciliation basis.

Outbound, exports are Dataset-JSON v1.1 and CSV pinned to immutable
[snapshots](/edc-core/guide/analytics/): the same snapshot version re-reads
identically forever, so a transfer can be reconciled against its exact
source at any later date.

**Yours to decide:** a documented transfer plan per external source (what,
from whom, how often, reconciled by whom) and the receiving system's side of
any migration.

## Finalisation prior to analysis (§4.2.6)

The path to a defensible database lock, in system terms:

1. Resolve open queries (the dashboard shows the study-wide count).
2. Complete [medical coding](/edc-core/guide/medical-coding/) from the work queue.
3. Walk forms through the workflow: `complete`, `verified` where your plan
   requires it, investigator-`signed`, then `locked`, which restricts edit
   access exactly as §3.16.1(r) expects before final analysis.
4. Publish a snapshot: an immutable, version-pinned dataset that interim or
   final analysis references (traceability row E6-07).

Analysis-side, [workbench](/edc-core/guide/analytics/) SQL, R, and Python executions
record their snapshot version, full code, logs, and outputs; data extraction
is documented by construction (§4.2.6(c)).

**Yours to decide:** what "data of sufficient quality" means for each
analysis (§4.2.6(a)), and the pre-specified checklist of finalisation
activities (§4.2.6(b)); the system supplies completion evidence for each
step, not the checklist itself.

## Retention and access (§4.2.7)

The study archive is a single self-contained bundle in open formats: ODM
metadata for every build, Dataset-JSON and CSV data pinned to a snapshot,
the complete audit trail as CSV, the signature manifest, and per-subject PDF
casebooks, retrievable and human-readable long after the running system is
gone. In-system, records are protected by role-based access, the append-only
audit trail, and the [deployment controls](/edc-core/deployment/) (TLS, encrypted
volumes, paired database + lake backups sized to your retention period).

**Yours to decide:** the retention period itself (per study, per applicable
regulation), where archive bundles are stored, and periodic retrieval checks.
A bundle you have never re-opened is the same hope as a backup you have
never restored.

## Destruction (§4.2.8)

Deliberately, there is no destruction inside the application: no route
deletes clinical data, versions, or audit events, and database triggers
reject attempts. E6(R3) permits permanent destruction only when records are
no longer required under applicable regulatory requirements. That decision
belongs to a person, on a date, with authority, not to an endpoint.

When the retention period genuinely ends, destruction is a deployment-level
act: destroy the database volume, the lake directory, **and every backup of
both**, together, and record what was destroyed, when, under whose
authority, and against which retention schedule.

## Blinding and computerised systems (§4.1, §4.3)

Two governance topics sit beside the lifecycle elements:

- **Blinding** (§4.1): item-level blinding is enforced at form reads,
  casebooks, audit views, and structurally at snapshot publish; RTSM arms
  land on blinded items via write-only service accounts. Unblinded access is
  a distinct permission (`data.unblind`) granted and revoked through the
  audited team workflow, so the roles and procedures §4.1.2 asks you to
  define map onto grants you can review. §4.1.4's documentation duty is
  covered from both sides: the grant history records who could see
  unblinded data and when, and the explicit **break-the-blind action**
  records each unblinding event itself: per subject, with a category
  (planned, or unplanned: emergency, inadvertent, other) and a required
  reason, append-only, audited as `subject.unblinded`, and printed in the
  subject's casebook. Breaking the blind is documentation, not a switch:
  masking of blinded values stays governed by `data.unblind` grants, because
  one subject's emergency unblinding must not unmask them for every viewer.
  Assessing an unplanned unblinding's impact on trial results (§4.1.4) is
  yours to decide and document.
- **Computerised systems** (§4.3): validation evidence ships per release as
  the [validation pack](/edc-core/compliance/); security controls, backup, and
  monitoring are the [deployment page](/edc-core/deployment/). Training (§4.3.2)
  and your documented procedures for system use (§4.3.1) are organizational;
  this user guide is raw material for them, not a substitute.

Section references are to the ICH E6(R3) guideline (adopted January 2025),
Annex 1; the requirement-by-requirement map with test evidence is the
[traceability matrix](/edc-core/compliance/).

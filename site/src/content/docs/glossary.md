---
title: "Glossary"
---


Clinical data management has a vocabulary problem: half its terms come from
regulation, half from CDISC standards, and the rest from whatever the last
EDC vendor called things. This page defines the terms as edc-core uses them,
in plain language, with a link to the guide page that treats each one fully.

**Amendment.** A mid-study change to the study definition, made as a new
immutable build followed by an explicit, audited migration of in-flight
forms. See [Mid-study amendments](/edc-core/guide/amendments/).

**Audit trail.** The permanent record of every create, change, and state
transition in a study: who, when, what changed, and why. In edc-core the
audit tables are append-only at the database level, so history cannot be
rewritten. See [Review workflows](/edc-core/guide/review/#audit-trail-review).

**Biomedical concept.** A CDISC-defined unit of clinical meaning ("systolic
blood pressure") that a protocol schedules and a build turns into concrete
fields. Used by the [protocol import](/edc-core/guide/protocol-import/) path.

**Blinded item.** A field flagged so that only roles with the `data.unblind`
permission can see its value; everyone else sees a locked, masked field.
Typically the treatment arm in a blinded trial. See
[Blinding](/edc-core/guide/blinding/).

**Build** (also *study build*, *metadata version*). A versioned, immutable
snapshot of the study definition: events, forms, item groups, items,
codelists, and rules, shaped as CDISC ODM. Everything the system renders
comes from a build. See [Study builds](/edc-core/guide/study-builds/).

**Casebook.** A PDF rendering of one subject's complete captured data:
current values, correction markers, queries, and the signature manifest.
See [Exports and the study archive](/edc-core/guide/exports-and-archive/).

**CDASH.** CDISC's standard for how data collection fields should be named
and structured on CRFs. The demo study's forms are CDASH-aligned.

**CDISC.** The Clinical Data Interchange Standards Consortium, the standards
body behind ODM, CDASH, USDM, and Dataset-JSON. edc-core uses CDISC formats
as its native interfaces rather than proprietary ones.

**Codelist.** The controlled set of options behind a choice field ("Male /
Female", "Mild / Moderate / Severe"), defined once in the build and reused
across forms.

**ConditionDef.** The ODM construct holding a named true/false expression.
edc-core uses ConditionDefs for both edit checks and skip logic; which job
one does depends on where it is referenced. See
[Rules and derivations](/edc-core/guide/rules-and-derivations/).

**CRF / eCRF.** Case report form: the form on which a subject's study data
is collected, "e" for electronic. In edc-core, CRFs render directly from the
build's metadata. See [Data capture](/edc-core/guide/data-capture/).

**Cross-form check.** An edit check that reads the subject's other forms by
qualifying item OIDs with a form OID (`` `FO.DM`.`IT.VISDT` ``). It fires
on writes to any form it reads, and its query opens on its home form. See
[Rules and derivations](/edc-core/guide/rules-and-derivations/#cross-form-checks).

**Data-equivalence.** The machine-checked property that a site's custom form
layout collects exactly the same fields as the sponsor's build, with at
least the same required flags. See [Site form layouts](/edc-core/guide/site-forms/).

**Dataset-JSON.** The CDISC exchange format (v1.1) for tabular study data,
accepted by FDA. One of the three snapshot export formats. See
[Exports and the study archive](/edc-core/guide/exports-and-archive/).

**Derived value.** A field the server computes from other answers (BMI from
height and weight) instead of accepting entry. Stored through the audited
write path and permanently marked as derived. See
[Rules and derivations](/edc-core/guide/rules-and-derivations/).

**Dictionary.** A licensed medical coding vocabulary loaded into edc-core:
MedDRA for adverse events, WHODrug for medications. See
[Medical coding](/edc-core/guide/medical-coding/).

**Edit check.** A rule that inspects saved data and flags implausible or
inconsistent values (systolic below 70, end date before start date). A
failing check warns during entry and opens a system query on save. See
[Rules and derivations](/edc-core/guide/rules-and-derivations/).

**Electronic signature.** A signature applied inside the system, requiring
credential re-entry at the moment of signing and bound by hash to the exact
record versions signed. See
[Review workflows](/edc-core/guide/review/#electronic-signatures-21-cfr-part-11).

**eTMF.** Electronic trial master file: the system holding a trial's
essential documents. edc-core can file build definitions and snapshot
manifests into an external eTMF automatically. See
[Exports and the study archive](/edc-core/guide/exports-and-archive/#automatic-etmf-filing).

**Event** (also *visit*). A scheduled point in the study (screening, week 4)
that groups the forms collected there. Columns in the subject matrix.

**Form instance.** One concrete form for one subject at one event: "DEMO-002's
Vital Signs at Screening". Each form instance has its own workflow state and
records the build version it was captured under.

**ICH E6(R3).** The ICH harmonised guideline for Good Clinical Practice,
adopted January 2025: the international ethical, scientific, and quality
standard for conducting clinical trials. [Compliance](/edc-core/compliance/)
describes how edc-core maps to it.

**Item / ItemDef.** A single collected field ("What was the systolic blood
pressure?") and its ODM definition: question text, data type, length, units,
codelist.

**Item group.** An ODM grouping of items within a form (the vital-signs
measurements, one adverse-event record). Item groups are also the grain of
the analytics tables: one dataset per item group.

**JSONata.** The expression language edc-core uses for rules: small, pure
expressions over the form's values, like
`` $number(`IT.VS.SYSBP`) < 70 ``. Rules are stored inside the build, so
they travel with the study definition.

**Lake.** The per-study analytics store (DuckLake: Parquet files cataloged
in Postgres) that snapshots publish into. The workbench queries the lake,
never live capture tables. See [Analytics workbench](/edc-core/guide/analytics/).

**Listing.** A workbench query or script whose result rows are
data-cleaning findings: subjects with missing visits, out-of-window dates,
values that disagree across forms. Listing rows can be turned into manual
queries in bulk. See
[From listings to queries](/edc-core/guide/analytics/#from-listings-to-queries).

**MedDRA.** The Medical Dictionary for Regulatory Activities, the licensed
terminology used to code adverse events. See
[Medical coding](/edc-core/guide/medical-coding/).

**MethodDef.** The ODM construct holding a computation. An item that
references a MethodDef is a derived value. See
[Rules and derivations](/edc-core/guide/rules-and-derivations/).

**ODM.** CDISC's Operational Data Model, the standard format for study
definitions and clinical data. edc-core's builds are ODM v2.0 documents
(XML or JSON), importable and exportable at any time. See
[Study builds](/edc-core/guide/study-builds/).

**Parquet.** A compressed columnar file format common in analytics tooling.
One of the three snapshot export formats, and the storage format of the lake.

**Part 11** (21 CFR Part 11). FDA's regulation on electronic records and
electronic signatures: the conditions under which they are trustworthy and
equivalent to paper records and handwritten signatures.
[Compliance](/edc-core/compliance/) describes how edc-core maps to it, and what no
software can claim on its own.

**Query.** A threaded conversation attached to a form or item questioning
the data. *System queries* open and close automatically with edit checks;
*manual queries* are opened by reviewers and answered by sites. See
[Review workflows](/edc-core/guide/review/#queries).

**Reason for change.** The explanation required whenever a saved value is
modified. Stored with the old and new value in the audit trail.

**Repeating item group.** An item group collected multiple times within one
form (several blood-pressure readings in one visit), each occurrence stored
and checked independently. See
[Data capture](/edc-core/guide/data-capture/#repeating-item-groups).

**RTSM / IRT.** Randomization and trial supply management (also called
interactive response technology): the external system that randomizes
subjects. edc-core receives its arm assignments; it never randomizes. See
[RTSM integration](/edc-core/guide/rtsm-integration/).

**SDV** (source data verification). A monitor's comparison of entered data
against source records, recorded in edc-core as the *verified* workflow
state. See [Review workflows](/edc-core/guide/review/#source-data-verification).

**Site form layout.** A site's approved rearrangement of the sponsor's
forms: same fields, different grouping, order, and wording. See
[Site form layouts](/edc-core/guide/site-forms/).

**Skip logic.** A rule that marks a field or section as *not collected*
while a condition is true, so the pregnancy-test question disappears when
sex is recorded male. Authored on the
[rules page](/edc-core/guide/rules-and-derivations/); the entry-side behavior is in
[Data capture](/edc-core/guide/data-capture/#conditional-and-computed-fields).

**Snapshot.** An immutable, point-in-time publication of a study's data
into typed analytics tables. Analyses and locks reference a snapshot ID and
reproduce identically forever. See
[Analytics workbench](/edc-core/guide/analytics/#snapshots).

**Subject lifecycle status.** A subject's disposition: screening, enrolled,
screen failed, completed, or withdrawn, with reinstatement as the
correction path. Distinct from form workflow states. See
[Data capture](/edc-core/guide/data-capture/#subject-lifecycle).

**USDM.** CDISC's Unified Study Definitions Model, a machine-readable
protocol format. edc-core compiles a USDM v4 package into a candidate study
build. See [Protocol import](/edc-core/guide/protocol-import/).

**Verbatim term.** The term exactly as the site reported it ("stomach ake"),
kept unchanged while coding attaches the standardized dictionary term beside
it. See [Medical coding](/edc-core/guide/medical-coding/).

**WHODrug.** The licensed drug dictionary from the Uppsala Monitoring
Centre, used to code medications. See
[Medical coding](/edc-core/guide/medical-coding/).

**Workflow state.** A form instance's position in the server-enforced state
machine: `not started → in progress → complete → verified → signed →
locked`. See [Data capture](/edc-core/guide/data-capture/#workflow-states).

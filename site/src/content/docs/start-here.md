---
title: "Start here"
---


edc-core is used by people with very different jobs: coordinators keying
visits at a site, data managers building and cleaning studies, monitors
verifying data, and the people accountable for all of it. The guide pages
serve all of them, but nobody needs to read everything. Pick the track that
matches your role and read in order; each step says why it comes next.

Every track names a demo persona (`demo-coord`, `demo-dm`, `demo-inv`,
`demo-cra`, `demo-admin`). If you [install the local stack](/edc-core/installation/)
and seed the demo study, you can sign in as that persona and do each step
yourself rather than just reading about it.

## New to EDC (entry-level data managers) {#entry-level}

If terms like eCRF, edit check, and SDV are new, start with vocabulary and a
guided loop before any reference material. Follow along as `demo-coord` for
entry and `demo-dm` for review.

1. [Glossary](/edc-core/glossary/): skim it once so the rest of the guide reads
   without stopping to look things up.
2. [Five-minute tour](/edc-core/tour/): the whole lifecycle (enter → query → verify
   → sign → snapshot → analyze) in one sitting, switching personas at each
   step.
3. [Data capture](/edc-core/guide/data-capture/): the subject matrix, entering
   values, corrections with reasons, and what the form does on its own
   (skips, computed fields, repeating groups).
4. [Review workflows](/edc-core/guide/review/): where queries come from, who
   answers them, and what verification and signature mean.
5. [Medical coding](/edc-core/guide/medical-coding/): why "asprin 81mg" needs a
   dictionary term, and the queue where that happens.
6. [Analytics workbench](/edc-core/guide/analytics/): the SQL section is enough to
   answer "how clean is my study today" yourself, and
   [From listings to queries](/edc-core/guide/analytics/#from-listings-to-queries)
   turns the answer into site queries.

## Study builders (advanced data managers) {#study-builders}

You already run studies; this track is about building them in edc-core:
versioned ODM builds, rules, and what happens after go-live. Work as
`demo-dm` or `demo-admin`.

1. [Study builds](/edc-core/guide/study-builds/): the versioned, immutable build
   model everything else renders from, and the three ways to author one.
2. [Rules and derivations](/edc-core/guide/rules-and-derivations/): edit checks
   (single-form and cross-form), skip logic, and computed values, with a
   JSONata primer.
3. [Why protocol-first?](/edc-core/guide/why-protocol-first/) and
   [Protocol import](/edc-core/guide/protocol-import/): deriving a build from a
   USDM protocol package instead of hand-built forms.
4. [Mid-study amendments](/edc-core/guide/amendments/): diff, impact analysis, and
   audited migration once the protocol changes under live data.
5. [Site form layouts](/edc-core/guide/site-forms/): letting sites adapt form
   presentation while you keep one data shape across the study.
6. [Lab data import](/edc-core/guide/lab-import/) and
   [RTSM integration](/edc-core/guide/rtsm-integration/): external data through
   the same audited write path as typed entry.
7. [Blinding](/edc-core/guide/blinding/): item-level masking, who sees what, and
   the break-the-blind record.
8. [Analytics workbench](/edc-core/guide/analytics/) and
   [Exports and the study archive](/edc-core/guide/exports-and-archive/):
   snapshots, R and Python against them, and every path data takes out.

## CRO and sponsor leadership {#leadership}

You are deciding whether to trust a study to this system. This track covers
the compliance posture, oversight evidence, and exit paths; none of it
requires touching a form.

1. [Why edc-core](/edc-core/#why-edc-core): the licensing and architecture
   position in five paragraphs.
2. [Compliance](/edc-core/compliance/): how the system maps to 21 CFR Part 11 and
   ICH E6(R3), what the validation pack contains, and what remains your
   organization's responsibility.
3. [Data lifecycle](/edc-core/data-lifecycle/): the ICH E6(R3) data lifecycle
   elements, one by one, with how each is handled.
4. [User administration](/edc-core/guide/user-admin/): account lifecycle, per-study
   role grants, the access log, and security anomaly review, which is the
   access-control story an auditor will ask about.
5. [Exports and the study archive](/edc-core/guide/exports-and-archive/): the exit
   path, because your data outliving the system is part of the decision.
6. [Deployment](/edc-core/deployment/): what running this in production actually
   involves, whether or not you operate it yourself.

## Clinical operations and site staff {#clinical-ops}

Your world is subjects, visits, and queries. This track stays on the
site-facing surfaces. Follow along as `demo-coord` (coordinator) and
`demo-inv` (investigator).

1. [Five-minute tour](/edc-core/tour/): the fastest way to see what sites, monitors,
   and data management each do in the system.
2. [Data capture](/edc-core/guide/data-capture/): the subject matrix, subject
   lifecycle (screening, enrolled, withdrawn, reinstated), entry, and
   corrections.
3. [Site form layouts](/edc-core/guide/site-forms/): reorganizing a visit's forms
   around your clinic's flow without changing what the study collects.
4. [Review workflows](/edc-core/guide/review/): answering queries, what the monitor
   is doing when a form shows *verified*, and what signing commits you to.
5. [Notifications](/edc-core/guide/notifications/): how query and signature work
   finds you instead of waiting on a dashboard.
6. [Blinding](/edc-core/guide/blinding/): why some staff see the arm while others
   see a masked field, and what breaking the blind records.

If none of these fit, the [user guide sidebar](/edc-core/guide/study-builds/) lists
every page by topic, and the [glossary](/edc-core/glossary/) covers the vocabulary.

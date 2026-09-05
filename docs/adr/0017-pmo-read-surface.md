# ADR-0017: A read-only PMO surface — scoped keys and the visit-date designation

**Status:** accepted · 2026-08-10

## Context

A DM PMO portal (the sibling dmops-core project is the concrete consumer)
computes operational metrics — query turnaround, visit-to-entry lag, staff
access rosters — by reading an EDC's documented API on a schedule. edc-core
already serves the needed listings to humans: subjects, study queries, and
study members are plain session-authenticated GETs. Machines, however, have
exactly one way in: the ADR-0010 API key, which can reach one intake POST
and — as a stated security property — can never read data. There is no
credential a metrics pipeline can hold.

Two of the facts such a pipeline needs do not exist as API fields at all:

1. **The visit date.** `study_event_instances` records that an event
   instance exists (`subject_id, event_oid, repeat_key, created_at`) and
   nothing else. The date the visit happened is an ordinary captured item
   on some CRF — which item is a fact only the study team knows, and
   nothing in the build records it. ODM v2 metadata has no event-date
   construct to lean on; the planned-timing extensions from ADR-0012 are
   protocol schedule, not actuals.
2. **First data entry.** Visit-to-entry lag needs the first save on each
   form instance. `item_value_versions.created_at` holds this, but no
   endpoint serves it.

## Decision

**The visit date item is declared in the build: `edc:VisitDate="Yes"` on
`ItemDef`.** Which item carries the visit date is CRF design, so it belongs
in protocol metadata and versions with the build — the same reasoning that
put `edc:Blinded` and `edc:CodingDictionary` on `ItemDef`, and the inverse
of ADR-0010's argument for keeping integration wiring in a table. Publish
validation hard-fails a build where a designated item is not
`DataType="date"`, is blinded (the designation exists to cross an
integration boundary; a blinded visit date is a leak by construction), or
where one StudyEvent's forms reach more than one designated item.

**Machine reads get their own key class, and key classes cannot cross.**
`api_keys` gains a `scope` column (`rtsm` | `pmo_read`). PMO keys mint with
an `edcpmo_` prefix against a per-study `svc-pmo-<studyId>` service account
holding the seeded `pmo_agent` role — `integration.read` only, no
`data.unblind`, granted through the audited `grantRole` like any grant.
Route guards now pin scope: the RTSM intake takes only `rtsm` keys, the
read surface only `pmo_read` keys, so a leaked read key cannot post
assignments and the ADR-0010 property — the RTSM key can never read data —
survives verbatim. Key lifecycle (show-once mint, sha256 storage,
revocation, audit events) is the ADR-0010 machinery reused.

**The read surface is five study-scoped GETs.** `subjects`, `queries`, and
`members` — already served to session members — additionally accept a PMO
key. Two new listings serve the missing facts to members and keys alike:

- `GET /studies/:id/visits` — one row per event instance:
  `subjectKey, eventOid, eventRepeatKey, visitDate, createdAt`. The date is
  resolved per instance from the designated items on its form instances,
  each under that instance's own pinned metadata version. No designated
  value → `null`. A value that is not ISO `yyyy-MM-dd` fails the request
  naming subject, event, item, and observed value — interactive capture
  does not enforce `castable()` on entry, so the boundary validates rather
  than guesses. Two designated items resolving to different non-null values
  in one instance is the same loud 422.
- `GET /studies/:id/form-instances` — one row per form instance:
  `subjectKey, eventOid, eventRepeatKey, formOid, repeatKey, status,
  firstEnteredAt`. `firstEnteredAt` is the earliest
  `item_value_versions.created_at`, machine writes included — an RTSM
  assignment is a save like any other.

**The key path serves operational metadata, never captured values — with
one designated exception.** The visit date is the single item value that
crosses, and only through the designation the build itself declares.
Query listings omit message bodies for key principals (a thread body can
quote any captured value); authors and timestamps remain, which is what a
response-time metric needs. Subjects are already pseudonymous; members are
the access roster the consumer exists to check.

## Rejected alternatives

- **A `visit_date` column on `study_event_instances`** — invents a second
  home for a fact capture already holds, and needs a write path plus UI
  that today's lazily-created event instances don't have. Derived from
  captured data beats stored-in-parallel.
- **An `rtsm_configs`-style designation table** — ADR-0010 chose a table
  because integration wiring must toggle without a new build. The visit
  date item is the opposite case: it changes exactly when the CRF changes,
  and a mapping that survives an amendment that removed the item is a
  silent lie. Metadata designation fails that build at publish instead.
- **Widening the RTSM key** — breaks a documented security property, and
  couples the blast radius of a write credential to a read use case.
- **Session-based machine users** — rejected in ADR-0010 for the same
  reasons; nothing has changed.
- **A generic item-value export for keys** — the honest minimum is one
  declared item class, not a hole. Casebook export exists for humans with
  the permission for that.

## Scope

No scheduling engine: planned-timing extensions stay dormant, and a
scheduled-but-unstarted visit is unobservable here, because event instances
are only created with their first form. `occurred` is therefore the
consumer's inference, not a served claim. No site-level key scoping, no
outbound push, no repeating-event semantics beyond serving `repeat_key`
(ADR-0010's note stands). SDV state is not served: the status ladder
collapses verification into workflow stages the reader must not
over-interpret.

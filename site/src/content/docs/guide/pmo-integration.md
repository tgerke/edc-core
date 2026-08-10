---
title: "PMO read surface"
---

A data-management PMO portal (the sibling
[dmops-core](https://github.com/tgerke/dmops-core) project is the concrete
consumer) computes operational metrics — query turnaround, visit-to-entry
lag, access rosters — by reading an EDC's API on a schedule. edc-core
serves that consumer through a read-only key class and five study-scoped
listings. The design and its boundaries are ADR-0017.

## What a read key can see

A `pmo_read` key reaches exactly five GETs on its own study, and nothing
else:

| Listing | What it serves |
| --- | --- |
| `GET /studies/:id/subjects` | Pseudonymous subject keys, status, site |
| `GET /studies/:id/queries` | Query threads with authors and timestamps; message bodies are omitted on the key path, because a thread can quote captured values |
| `GET /studies/:id/members` | The current access roster (service accounts excluded) |
| `GET /studies/:id/visits` | One row per event instance with the resolved visit date |
| `GET /studies/:id/form-instances` | One row per form instance with status and first-entry timestamp |

Captured item values never cross this surface, with one declared
exception: the visit date, and only through the designation the build
itself makes (below). Session members see the same five listings — with
message bodies intact, since members already read threads in the app.

## Declaring the visit date

The visit date is an ordinary CRF item, and which item it is a fact of
your study design — so it is declared in the build, not in deployment
config: set `edc:VisitDate="Yes"` on the ItemDef that carries it.

```xml
<ItemDef OID="IT.VISDT" Name="Visit Date" DataType="date" edc:VisitDate="Yes"/>
```

Publish validation hard-fails a build where a designated item is not
`DataType="date"`, is blinded, or where one event's forms reach more than
one designated item. At read time, each event instance resolves its date
from the designated items on its own form instances, under each
instance's own pinned build; no designated value means `visitDate: null`.
A stored value that is not ISO `yyyy-MM-dd` fails the listing with a 422
naming the subject, event, and observed value — data worth a correction,
not a guess.

## Keys

PMO keys mint with the `edcpmo_` prefix against a per-study
`svc-pmo-<studyId>` service account holding the `pmo_agent` role
(`integration.read` only). Minting and revocation require `study.manage`
and are API-first for now:

```bash
curl -X POST https://your-edc/api/studies/<studyId>/pmo/keys \
  -H "Authorization: Bearer <session token>" \
  -H "Content-Type: application/json" \
  -d '{"label": "dmops pipeline"}'
```

The raw token is returned exactly once; edc-core stores only a hash.
`GET /studies/:id/pmo/keys` lists keys, and
`POST /studies/:id/pmo/keys/:keyId/revoke` shuts one off. Key lifecycle
events land in the audit trail, and every request a key makes lands in
the access log like any session request.

Key classes cannot cross: an RTSM key on a read listing is a 401, and a
PMO key on the assignment intake is a 401. The RTSM guide's security
property — that intake key can never read data — survives unchanged.

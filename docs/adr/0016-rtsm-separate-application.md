# ADR-0016: RTSM is a separate application, not an edc-core module

**Status:** accepted · 2026-07-23

## Context

ADR-0010 built the receiving end of randomization — an external RTSM posts a
subject's arm assignment and it lands as a blinded eCRF item — and its scope
note deliberately excluded the randomization algorithm and drug supply. The
open question was where that functionality should eventually live: grown
inside edc-core as a module, or built as a sibling application (working name
**rtsm-core**) the way CTMS already is. Consolidating clinical-trial tooling
is part of this project's reason to exist, so building it in was the default
to argue against.

Three facts about the existing system and the regulation decided it:

1. **edc-core's blinding is value masking, not schema isolation.** Item-level
   blinding (ADR-0009) masks values under a blinded ItemDef at reads,
   casebooks, audit, and lake publish. It says nothing about sibling tables
   in the same database. An RTSM's crown jewels — the master randomization
   list and the kit-to-arm map — are exactly such tables, and E6(R3) Annex 1
   §4.1.1 asks that blinding integrity be maintained "in the design of
   systems" and in the management of users' accounts and data access, with
   §4.1.2 barring trial-operations staff from unblinding information.
2. **The integration seam already exists.** ADR-0010's intake
   (`POST /studies/:id/rtsm/assignments`, `edcrtsm_` keys, `svc-rtsm-*`
   service accounts, append-only `rtsm_events`) is the surface any RTSM —
   commercial or ours — uses to deliver assignments. E6(R3)'s glossary
   treats IRTs as data-acquisition tools alongside CRFs; the guideline
   itself models them as systems feeding the sponsor, not as EDC internals.
3. **Randomization carries its own validation burden.** Annex 1 §4.3.4(h)
   names randomisation and dosing as "critical functionality" for system
   validation. An algorithm that must be statistically validated (block
   generation, stratification, seed management) would sit inside edc-core's
   validation pack and re-open it with every release, even releases that
   never touch randomization.

## Decision

**RTSM functionality is built as a separate application with its own
repository and its own database.** rtsm-core integrates with edc-core through
the ADR-0010 intake exactly as a commercial RTSM would — it gets no private
API, no shared schema, no shortcut.

**The blinding boundary becomes architectural rather than procedural.** The
randomization list and kit-to-arm map never exist in the EDC's Postgres, so
no EDC role, system administrator, or DBA can reach them — there is nothing
to reach. Inside a single database that guarantee is an RBAC policy someone
must audit; across two systems it is a fact of the deployment. Unblinded
roles (pharmacists, supply managers) become rtsm-core users and never need
EDC accounts at all, which is the clean reading of Annex 1 §4.1.2.

**edc-core's intake API stays honest by being used.** rtsm-core is the first
external consumer of the seam we ask commercial RTSMs to integrate against.
A built-in module would bypass that API, orphan it, and quietly recouple
what ADR-0010 decoupled — the anti-lock-in argument works only if our own
RTSM has no privileged path.

**Consolidation happens at the stack, not in the codebase.** rtsm-core
reuses the proven edc-core patterns — Postgres with append-only audit
triggers, compose packaging, the validation-pack release mechanism — and
ships in the clinical-stack compose next to EDC and CTMS, with SSO via the
same OIDC provider where deployments want it. Shared operations, separate
validation envelopes.

**Start with randomization, not supply.** rtsm-core v0.1 is list management
and assignment delivery through the existing intake; kit, depot, and
resupply logic is roadmap. That keeps the first release small while the
architecture already accommodates the part of RTSM (supply chain and IP
accountability) that shares essentially nothing with an EDC's data model or
users.

## Rejected alternatives

- **In-EDC randomization module** (the REDCap/OpenClinica pattern) — cheap
  and adequate for small open-label trials, but it moves critical
  functionality into edc-core's validation envelope permanently, and the
  first blinded trial forces the separation anyway, now as a migration. The
  same-database design also demotes the master list from architecturally
  unreachable to policy-protected.
- **Separate service, shared database** — keeps deployment simple, but the
  DBA-visibility boundary is the point of separating; sharing Postgres
  gives up the main benefit while paying the multi-service cost.
- **Second app in this repository** — avoids some scaffolding, but couples
  release cadence and validation-pack contents to the EDC's; ctms-core
  already established the sibling-repo pattern and the docs split that goes
  with it.

## Scope

edc-core will not grow a randomization algorithm, kit or inventory
management, or depot logistics. Its RTSM surface stays what ADR-0010 built —
the intake, `rtsm_configs`, `rtsm_events`, blinded arm items — plus the
existing break-the-blind action for emergency unblinding on the EDC side.
Scoping rtsm-core itself (algorithms, list formats, unblinded roles,
supply roadmap) happens in that repository, not here.

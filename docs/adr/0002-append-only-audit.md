# ADR-0002: Append-only audit trail enforced at the database level

**Status:** accepted · 2026-07-02

## Context

21 CFR Part 11 requires secure, computer-generated, time-stamped audit trails that do not
obscure previously recorded values; ICH E6(R3) expects audit trails on by default and
routinely reviewable. Application-level audit logging alone is fragile: any code path that
forgets the middleware silently corrupts the guarantee.

## Decision

- Clinical data values are stored as immutable version rows: every change is an INSERT
  carrying who, when, old→new value, and reason-for-change, committed in the same
  transaction as the logical write.
- Audit and version tables carry Postgres triggers that raise on UPDATE or DELETE.
- The application connects as a runtime role (`edc_app`, migration 0024) that does not
  own the tables and holds no TRIGGER or TRUNCATE privilege, so it cannot disable, drop,
  or bypass the triggers; migrations run as the owning role under a separate credential
  (`MIGRATE_DATABASE_URL`).
- Automated tests assert that direct UPDATE/DELETE attempts fail and that the runtime
  role cannot disable the triggers or TRUNCATE the tables.

## Consequences

- Audit correctness is a structural property, not a code-review obligation.
- "Current value" reads use a view/index over latest versions; storage grows monotonically
  (acceptable: clinical data volumes are modest, and retention is a requirement anyway).
- Corrections follow the clinical convention: a new version with a reason for change,
  never an erasure.

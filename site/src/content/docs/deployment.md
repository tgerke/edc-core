---
title: "Deployment"
---


Two compose files live in `infra/`. `compose.yaml` is the **local
development stack**: hard-coded database password, no TLS, every service
port published to the host. `compose.prod.yaml` is the **supported
production shape**: pinned release images, TLS terminated by Caddy as the
only published service, and the hardening below wired in rather than left
as homework. This page explains what the production stack does for you,
what remains yours to do before clinical data touches the system, and how
the pieces map to GDPR and HIPAA hosting expectations.

## The production stack

```sh
cd infra
cp .env.example .env    # set EDC_DOMAIN, EDC_VERSION, POSTGRES_PASSWORD
docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml exec api pnpm --filter @edc-core/api db:bootstrap-admin
```

Once `EDC_DOMAIN` resolves to the host, Caddy obtains and renews the TLS
certificate on its own; ports 80 and 443 are the only ones published.
`NODE_ENV=production`, `EDC_TRUST_PROXY=1`, and `EDC_BASE_URL` are set by
the compose file. Two profiles cover the supported variations
(`COMPOSE_PROFILES` in `.env`): drop `local-db` when `DATABASE_URL` points
at a managed PostgreSQL, and drop `engines` on small hosts that don't use
the analytics workbench.

:::caution[One API instance, always]

The notification and anomaly scheduler runs inside the API process and
assumes a single instance. Never scale the `api` service past one replica;
run a bigger VM instead. See [ADR-0011](https://github.com/tgerke/edc-core/blob/main/docs/adr/0011-single-vm-deployment-and-iac.md).
:::

To provision the VM itself, see [Installation](/edc-core/installation/).

:::note[Pseudonymized is not anonymous]

edc-core keeps direct identifiers out of clinical tables by construction:
subjects exist as keys, and the site holds the link to the person. Under GDPR
that is *pseudonymisation* (Art. 4(5)): the data "can no longer be attributed
to a specific data subject without the use of additional information", and it
**remains personal data**. Pseudonymization reduces your risk; it does not
exempt the deployment from the measures below.
:::

## What you are protecting

Four places hold study data; everything else is stateless:

| Where | What lives there |
|---|---|
| The `pgdata` volume (PostgreSQL) | Clinical data and its full version history, the append-only audit trail, users, sessions, the access log, and the DuckLake catalog |
| The `lakedata` volume | Published snapshot data as Parquet files: clinical values, one subdirectory per study |
| Your backups | Copies of both of the above |
| Your SMTP relay | Notification emails: deliberately plain-text pointers, but they name subject keys (e.g. "New query on SUBJ-001"), so pseudonymous study context does transit your mail system |

The R and Python engines mount the lake read-only and keep no state of their
own. The web container serves the SPA and holds nothing.

## Encryption in transit

Terminate TLS at a reverse proxy (Caddy, nginx, Traefik, or your cloud load
balancer) in front of the web and API containers, and give the containers no
public ports of their own. The session cookie is `httpOnly` and
`SameSite=Strict` always, and marked `Secure` when the API runs with
`NODE_ENV=production`. **Set that variable explicitly**; the published image
does not set it for you.

Inside a single-host compose network, service-to-service traffic
(API ↔ Postgres, API ↔ engines) stays on the container network. The moment
any of those hops crosses a host boundary (a managed Postgres, a separate
analytics box), require TLS on it (`DATABASE_URL` with `sslmode=verify-full`
for Postgres).

The development compose file publishes Postgres (5432) and the engines
(8000, 8001) to the host for convenience. In production, expose **only** the
reverse proxy. The engines in particular execute analyst code by design;
they must never be reachable from outside the container network.

With a proxy in front, the API sees the proxy's address unless you tell it
which proxies to trust: set `EDC_TRUST_PROXY` on the API container (`1` for
a single proxy layer you control, a hop count or address/CIDR list for
multi-hop setups) so the [access log](/edc-core/guide/user-admin/), session
records, and IP-change audit events carry the real client address from
`X-Forwarded-For`. Leave it **unset when no proxy is in front**: trusting
the header without a proxy lets any client forge the address that lands in
your evidence trail.

## Encryption at rest

GDPR names "the pseudonymisation and encryption of personal data" as the
first of its example security measures (Art. 32(1)(a)); HIPAA hosting
reviews ask the same question. edc-core deliberately does not implement
application-level cryptography. Encrypt at the volume layer instead, where it
is operationally boring and covers everything at once:

- **Cloud**: use encrypted block storage / managed-disk encryption with
  provider- or customer-managed keys for the volumes backing `pgdata` and
  `lakedata`, and for wherever backups land.
- **On-premises**: LUKS (or your platform's equivalent) under the container
  storage path.
- **Backups** need the same treatment as the live volumes: an encrypted
  database behind an unencrypted `pg_dump` in object storage protects
  nothing.

## Backups

Two things must be backed up **as a pair**: the PostgreSQL database and the
lake directory. The DuckLake catalog lives *inside* Postgres and references
Parquet files by path: a database restored to Monday pointing at a lake
directory from Thursday leaves snapshots referencing files that don't match.
Back them up from the same point in time and restore them together.

- For Postgres, WAL archiving with point-in-time recovery (`pgBackRest`,
  `wal-g`, or your cloud's PITR) is the grown-up option; nightly `pg_dump`
  is acceptable for small deployments if the dump is encrypted and tested.
  `infra/backup.sh` is the reference implementation of the paired backup:
  it stops the API, dumps the database and archives the lake under one
  timestamp, and restarts; restore instructions are in its header.
- The lake directory is plain files: snapshot the volume or `rsync` it as
  part of the same backup window. Published snapshot files are immutable,
  which makes incremental strategies cheap.
- 21 CFR Part 11 requires records to stay accurately and readily retrievable
  **for the whole retention period** (§11.10(c)), and the audit trail must be
  retained *at least as long* as the records it documents (§11.10(e)). Your
  backup retention must therefore meet your sponsor's records-retention
  schedule: typically years, set per study, and longer than any
  infrastructure default.
- A backup you have never restored is a hope, not a control. Schedule restore
  drills: restore both pieces into a scratch environment and open a study.

## Access logging and log retention

Every API request lands in the `access_log` table (who, from which address
and client, what, and with what result), reviewable by system administrators
in the app (**Access log** in the Studies header) and exportable as CSV. This
is the evidence trail for access reviews.

The table grows without bound, and its rows are operational telemetry, not
clinical records. Prune on your own schedule once entries age out of your
security-review window, e.g.:

```sql
DELETE FROM access_log WHERE occurred_at < now() - interval '13 months';
```

Do **not** apply any such housekeeping to `audit_events`: the audit trail is
append-only (the database rejects updates and deletes by trigger) and its
retention is governed by §11.10(e), not by operational convenience.

Application logs go to stdout on every container; ship them to your log
collector with your platform's usual mechanism.

## Security anomaly detection

The API's scheduler periodically sweeps the access log and audit trail for
three signals: bursts of failed authentications from one source address
(`EDC_ANOMALY_FAILED_LOGIN_THRESHOLD` 401s within
`EDC_ANOMALY_WINDOW_MINUTES`, defaults 10 within 15; `0` disables the burst
rule), account lockouts, and session binding violations. Each finding is
recorded once, notifies system administrators (email too, if SMTP is
configured), and waits for review under **Anomalies** in the Studies header.
Acknowledging a finding, with a note on what was done, is written to the
audit trail; that acknowledgement is your recorded incident response
(ICH E6(R3) 3.16.1(w)).

This is deliberately a coarse first line, not an intrusion-detection system:
it watches what the application itself can see. Keep platform-level
monitoring (network, host, container) in place alongside it.

## Hosting relationships

Whoever hosts this stack for you is processing study participants' personal
data on your behalf.

- **GDPR**: engage hosting providers as processors "providing sufficient
  guarantees" under a written contract (Art. 28), and treat hosting location
  deliberately: moving personal data to a third country is a *transfer* and
  must satisfy Chapter V (Art. 44). For EU studies, the simplest defensible
  posture is EU-region hosting.
- **HIPAA**: where the deployment handles protected health information for a
  US covered entity, the hosting arrangement generally requires a business
  associate agreement with the provider. HIPAA applicability in research
  contexts is genuinely situational; route it through your privacy office
  rather than this page.

## Production checklist

Before first real use. Items marked *(wired)* are already handled by
`compose.prod.yaml`; verify them instead if you deploy any other way:

- [ ] Replace `POSTGRES_PASSWORD` / `DATABASE_URL` credentials (the dev
  compose default is labeled `edc-dev-only` for a reason) and inject them as
  secrets, not baked into files.
- [ ] `NODE_ENV=production` on the API container (secure cookies). *(wired)*
- [ ] TLS-terminating reverse proxy in front; no other published ports,
  in particular not 5432 (Postgres) or 8000/8001 (engines). *(wired)*
- [ ] `EDC_TRUST_PROXY` set to match your proxy topology, and never set
  without a proxy actually in front. *(wired for the single Caddy layer)*
- [ ] Encrypted volumes for `pgdata`, `lakedata`, and backups.
- [ ] Paired database + lake backups on a schedule that meets your records
  retention period; restore drill completed.
- [ ] No demo seed (`db:seed-demo`) in production; bootstrap the first admin
  with `db:bootstrap-admin` and rotate its printed credential immediately.
- [ ] Review the authentication knobs against your SOPs
  (`EDC_SESSION_IDLE_MINUTES`, `EDC_SESSION_ABSOLUTE_HOURS`,
  `EDC_PASSWORD_MIN_LENGTH`, `EDC_MAX_FAILED_LOGINS`, `EDC_LOCKOUT_MINUTES`;
  see [Installation](/edc-core/installation/) for SSO).
- [ ] A decision on user-agent-strict session binding. It is on by default
  (a session presented by a different client is revoked). Set
  `EDC_SESSION_UA_STRICT=0` only where UA churn is legitimate (managed
  browser rollouts or UA-freezing policies would otherwise mass-revoke
  sessions), and note that mismatches are then audited and rebound rather
  than revoked (anomaly detection still sees them); record the choice in
  your SOPs.
- [ ] One API instance only: the notification scheduler assumes it (see
  [Installation](/edc-core/installation/)).
- [ ] Pin image tags to a released version; each release ships with its
  [validation pack](/edc-core/compliance/).
- [ ] An `access_log` retention job, and a decision recorded for how long you
  keep it.
- [ ] Anomaly thresholds reviewed (`EDC_ANOMALY_FAILED_LOGIN_THRESHOLD`,
  `EDC_ANOMALY_WINDOW_MINUTES`) and a routine for reviewing and
  acknowledging findings written into your SOPs.

# ADR-0011: Single-VM production shape, Caddy for TLS, thin infra-as-code

**Status:** accepted · 2026-07-12

## Context

ADR-0006 made compose the deployment unit but left "how do I run this in my
cloud, safely" as prose (site/deployment.qmd). That is a real adoption
barrier: the answer to "where do I run this?" should be an artifact, not a
reading assignment. At the same time the system is deliberately single-tenant
and the API must run as exactly one instance (in-process notification and
anomaly scheduler), so orchestrators add failure modes without adding
capacity we can use.

## Decision

- The supported production shape is **one VM running
  `infra/compose.prod.yaml`**: pinned GHCR images, Caddy terminating TLS as
  the only published service, Postgres and the engines on the internal
  network only. `infra/.env.example` is the complete configuration surface.
- **Caddy fronts the web container only**; the web container's nginx keeps
  owning `/api/*` routing (one place defines routes). Caddy exists for
  automatic certificate provisioning and renewal — the hardest part of
  self-hosting TLS reduced to one env var.
- Compose **profiles** express the two supported variations: `local-db`
  (bundled Postgres, off when `DATABASE_URL` points at a managed instance)
  and `engines` (analytics sidecars, off on small hosts).
- Infrastructure-as-code stays **thin and VM-shaped**: a provider-agnostic
  cloud-init that installs Docker and pulls the release-pinned compose
  artifacts, plus sibling Terraform roots per provider (AWS/Azure/DO) that
  provision VM + firewall + static IP + encrypted volume and delegate all
  app installation to that same cloud-init. No Kubernetes/Helm at this
  stage (unchanged from ADR-0006).
- `infra/backup.sh` is the reference for the paired database + lake backup;
  it stops the API during the dump because an unpaired backup is corrupt by
  construction (the DuckLake catalog references Parquet paths).

## Consequences

- Horizontal scaling is out of scope by design; the compose file and the
  Terraform roots say so where an operator would try it.
- Terraform never duplicates install logic — a fix to compose.prod.yaml or
  cloud-init reaches every provider path.
- `NODE_ENV=production`, `EDC_TRUST_PROXY=1`, and `EDC_BASE_URL` are wired
  in compose.prod.yaml rather than left as checklist items.
- The dev stack (`infra/compose.yaml`) is unchanged and remains the
  contributor path; the two files will drift-check against each other in
  review rather than by tooling, accepted at current scale.

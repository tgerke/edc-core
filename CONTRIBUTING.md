# Contributing to edc-core

Thanks for your interest! This project is early — the highest-value contributions right now are design review, regulatory expertise, and CDISC standards knowledge, alongside code.

## Development setup

Requires Node ≥ 22, pnpm ≥ 9, and Podman or Docker.

```sh
pnpm install
pnpm check          # biome lint + typecheck + vitest
podman compose -f infra/compose.yaml up --build
```

To iterate on the API with hot reload, run it on the host against
containerized Postgres and engines. The engines then need the *host* API's
lake directory, which the `compose.dev.yaml` overlay bind-mounts in place
of the compose volume:

```sh
podman compose -f infra/compose.yaml -f infra/compose.dev.yaml \
  up -d postgres r-engine py-engine
R_ENGINE_URL=http://localhost:8000 \
R_ENGINE_CATALOG_URL=postgres://edc:edc-dev-only@host.containers.internal:5432/edc \
R_ENGINE_LAKE_PATH=/var/lib/edc/lake \
PY_ENGINE_URL=http://localhost:8001 \
PY_ENGINE_CATALOG_URL=postgres://edc:edc-dev-only@host.containers.internal:5432/edc \
PY_ENGINE_LAKE_PATH=/var/lib/edc/lake \
pnpm --filter @edc-core/api dev
```

Don't mix the two: the containerized API writes the lake into the compose
volume with container paths in the catalog, the host API writes it under
`apps/api/data/lake` with host paths — a catalog created by one is
unreadable by the other's writers.

## Ground rules

- **Every clinical-data write path is audited.** New features that touch subject data must go through the audit layer; PRs that bypass it will not be merged. Audit tables are append-only and enforced by database triggers — tests must prove it.
- **Standards first.** Study metadata is ODM v2.0-shaped. Don't invent parallel representations; extend via ODM's vendor-extension mechanisms if needed.
- **Metadata-driven, not hard-coded.** CRFs, edit checks, and workflows render from study definitions. If you're hard-coding a form, step back.
- **Regulatory traceability.** Features that serve a Part 11 / ICH E6(R3) requirement should reference the relevant row in `docs/regulatory-traceability.md` in the PR description, and add rows when they introduce new obligations.
- **ADRs for consequential decisions.** Architecture-level choices get a record in `docs/adr/`.

## Workflow

1. Open or claim an issue before large changes.
2. Branch from `main`; keep PRs focused.
3. `pnpm check` must pass; CI runs the same.
4. All commits land via PR review.

## License

By contributing you agree your contributions are licensed under [AGPL-3.0](LICENSE).

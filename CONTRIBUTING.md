# Contributing to edc-core

Thanks for your interest! This project is early — the highest-value contributions right now are design review, regulatory expertise, and CDISC standards knowledge, alongside code.

## Development setup

Requires Node ≥ 22, pnpm ≥ 9, and Podman or Docker.

```sh
pnpm install
pnpm check          # biome lint + typecheck + vitest
podman compose -f infra/compose.yaml up --build
```

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

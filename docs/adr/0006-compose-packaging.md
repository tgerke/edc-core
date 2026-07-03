# ADR-0006: Compose-spec container packaging, rootless Podman recommended

**Status:** accepted · 2026-07-02

## Context

The system must run locally and on modest self-hosted infrastructure without specialist IT
effort, and clinical environments often prohibit privileged daemons. Kubernetes/Helm is
overkill as the primary target; bespoke installers age badly.

## Decision

- The deployment unit is a set of OCI images plus one `infra/compose.yaml` following the
  Compose Specification — identical under `podman compose` and `docker compose`.
- Rootless Podman is the documented recommended runtime (daemonless, unprivileged).
- Images are published to GHCR with versioned tags; a Helm chart is a later milestone,
  layered on the same images.

## Consequences

- `podman compose up` is the entire local install story.
- Compose-spec compatibility constrains us to features supported by both runtimes.

# ADR-0005: AGPL-3.0 license

**Status:** accepted · 2026-07-02

## Context

The project exists to end EDC vendor lock-in. A permissive license (Apache-2.0/MIT) would
maximize adoption but allow a vendor to fork the code into a closed, hosted commercial EDC —
recreating exactly the problem. Plain GPL-3.0 has the SaaS loophole: hosting a modified
version is not distribution.

## Decision

AGPL-3.0-only for all first-party code. Users interacting with a modified version over a
network are entitled to its source.

## Consequences

- Closed commercial SaaS forks are prevented; commercial *hosting* and *services* around
  the unmodified (or shared-source) system remain fully viable.
- Some enterprise legal teams are AGPL-averse; that is an acceptable trade-off for this
  project's goals, and sponsors can use the software without restriction (using an AGPL
  application does not affect the license of study data or of their own systems).

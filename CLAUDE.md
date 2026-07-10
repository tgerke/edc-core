# edc-core — guidance for LLM-assisted work

## LLM practice

- **Regulatory claims are verified against source text, never cited from model
  memory.** Any statement attributing a requirement or position to 21 CFR
  Part 11, ICH E6(R3), GAMP 5, CDISC standards, or similar — in
  `docs/regulatory-traceability.md`, `site/compliance.qmd`, ADRs, the
  validation pack, or PR descriptions — must be checked against the
  authoritative full text before it lands. Maintainers keep a local mirror at
  `~/claude-clinical-skills/sources/` (integrity-checked via its
  `MANIFEST.sha256`); grep the relevant document and confirm the wording. If a
  claim can't be grounded in a source file, flag it in the PR rather than
  asserting it. From-memory regulatory text is a known hallucination risk:
  plausible-sounding versions drift subtly out of date (e.g., pre- vs
  post-Second-Edition GAMP 5), and in a compliance-positioned product a wrong
  citation is an audit finding.

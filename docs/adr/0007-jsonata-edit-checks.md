# ADR-0007: JSONata as the edit-check expression language

**Status:** accepted · 2026-07-04

## Context

Edit checks must be side-effect-free, sandboxed, evaluable identically in the
browser (instant feedback) and on the server (source of truth), and
serializable inside ODM study definitions. ADR-0004/0003 deferred the choice
between CEL and JSONata.

## Decision

- JSONata. One mature, dependency-free JS library that runs byte-identically
  in both runtimes; expressions are pure functions over a value context; no
  ambient authority to sandbox away. CEL's JS implementations are less mature
  and would add a second grammar for contributors to learn.
- Checks are ODM **ConditionDefs** carrying a `FormalExpression` with
  `Context="jsonata"`. A check **fires** (raises a system query) when the
  expression evaluates to `true` — the expression states the data problem,
  matching ODM condition semantics. The ConditionDef Description supplies the
  query message.
- ConditionDefs referenced as `CollectionExceptionConditionOID` are collection
  logic, not edit checks, and are never evaluated as queries.
- Item values are keyed by ItemDef OID (backtick-quoted in expressions:
  `` `IT.VS.SYSBP` ``) and coerced per ItemDef DataType before evaluation.

## Consequences

- Study builds carry their edit checks portably in standard ODM.
- Expressions that fail to compile or evaluate never fire; the error is
  surfaced to study builders rather than silently passing or spamming sites.
- If CEL matures or demand appears, additional contexts can be supported per
  FormalExpression without changing stored studies.

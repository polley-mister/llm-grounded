# ADR-0002: Fact authorization is three boundaries, not one decision

Status: Accepted
Date: 2026-07-28

## Context

`vault_fact_commit` is the only path in this package that mutates durable state.
It was guarded in three places:

| where | context it read |
|---|---|
| `index.js`, tool factory | the per-run tool-factory context |
| `index.js`, `before_prompt_build` | the hook context |
| `facts-tool.js`, `execute` | the tool's own execute context |

All three called the same two predicates — `isDirectOwnerSession` and
`isFactOperatorAuthorized` — so a resolve-once audit flagged them as one
decision computed three times, which is the shape of defect this project has
now corrected twice: traffic classification in 0.2.5, turn identity in 0.2.6.

They are not that. Consolidating them would have been the wrong repair, and the
likely form of it — keep the first verdict, trust it downstream — would have
widened the narrowest guard on the only write path in the package.

## Decision

They are three boundaries. They get three names.

```
mayExposeFactTools    may this caller see that the tool exists?
mayInvokeFactTools    may this call proceed at all?
mayMutateFacts        may this call reach the vault?
```

All three live in `src/authorization.js`, together with the two session
predicates they are built from, which moved there from `facts-tool.js` and are
still re-exported from it.

### Why they are genuinely separate

**Exposure must be strict on its own, not merely backed up by execution.** A
tool the model can see in a shared conversation is a tool it will try to use
there. Refusing at execution turns that into a visible failure in front of
whoever is in the room; refusing at exposure means the tool simply is not
offered. These are different outcomes for the operator, so exposure carries the
full requirement rather than a cheap prefilter.

**Invocation reads a different object.** The tool-factory context is not the
execute context. Re-checking is not redundancy — it is the second boundary
reading its own inputs. A run whose session changed shape between exposure and
execution must be refused on what is true now, not admitted on the strength of
an earlier verdict.

**Mutation has a requirement the others cannot have.** A write must be
attributable to a classified turn, and a turn only exists once
`before_tool_call` has bound the call. Exposure happens before any of that.

### The invariant

> A later boundary may be stricter than an earlier one. It may never be more
> permissive.

```
mayMutateFacts  ⊆  mayInvokeFactTools  ⊆  mayExposeFactTools
```

This is structural, not a rule to be remembered: each predicate begins by
requiring the previous one and can then only add conditions. `tests/
authorization.test.mjs` asserts it as a property over fourteen context shapes —
owner, group, channel, wrong agent, missing agent, missing session, unrecognised
session, webchat console, one-shot CLI, empty, null, undefined — rather than by
reading the call sites and agreeing they look similar.

Permission is never inherited. Each boundary re-derives its answer from the
context it was handed, and a context carrying no identity is refused rather than
treated as already checked upstream.

## Consequences

- The names now say which boundary a call site is. `isFactOperatorAuthorized`
  read like the answer to "is this authorized", which is what made three call
  sites of it look like three copies of one decision.
- A future condition that belongs to invocation alone has an obvious home.
  `mayInvokeFactTools` adds nothing to exposure today; it exists as a named
  boundary because it reads distinct inputs, and it is where such a condition
  goes.
- `no-turn-state` became reachable. It had been dead: `resolveToolCall` returns
  null both for a call that was never bound and for one whose turn has since
  expired, so both reported `unbound-call` — a timing fault diagnosed as a
  wiring fault. `hasToolCallBinding` now separates them.
- Refusal codes are unchanged: `agent-not-allowed`, `not-direct-session`,
  `not-owner`, `unbound-call`, `no-turn-state`.

## What this does not decide

Session-key normalization. `isDirectOwnerSession` recognises five direct shapes
and refuses everything else, which is correct as a default but means the set of
recognised shapes is a list rather than a rule. That is tracked separately and is
not on the critical path: claim extraction consumes `internalTurnId` and the
stored traffic decision, and derives no authority from a session key.

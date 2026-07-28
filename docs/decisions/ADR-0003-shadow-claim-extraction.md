# ADR-0003: Claim extraction runs in production after delivery, with no authority

Status: Accepted
Date: 2026-07-28

## Context

Claim extraction has been offline since it was written. ADR-0001 selected
DeepSeek V4 Flash for it against a frozen development split. What that split
cannot answer is how the extractor behaves on live traffic: how often it
abstains when a real answer is unusual rather than merely hard, how often it
calls an incidental sentence a material claim, how often it fails to decompose a
composite, and what it costs in wall-clock on a machine that is also serving an
agent.

Those four numbers are the input to every later decision about claim
verification, and none of them can be estimated from a curated corpus.

This is also the first thing in the package that adds a model call to the
production turn lifecycle. Everything before it — classification, hard triggers,
the delivery gate, evidence capture — is ordinary deterministic code or bounded
local I/O.

## Decision

Extraction runs in production, in shadow, from `agent_end`.

### After delivery, not before it

`before_agent_finalize` also has the draft, and is the obvious place if you are
thinking about data availability. It is the wrong place: it sits between the
operator and their reply. A model call there adds its latency to every eligible
turn, and a hang there is a hang the operator experiences.

`agent_end` runs after every delivery lane. By the time it fires the answer has
been sent. A model call cannot revise it, cannot delay it, and cannot fail it.
That ordering is the entire safety argument, and it is why the call is awaited
rather than detached: awaiting is safe here, and it lets the turn record
reference the extraction it produced.

### No authority, structurally

- It never revises. It runs after the revision budget is spent and the delivery
  decision is made.
- It never retrieves. The request carries `tools: []`, `memory: false`,
  `workspaceContext: false`, `persona: false` — stated in the request rather
  than assumed from context, and asserted by test.
- It never refuses or blocks. Its return value is recorded and otherwise
  ignored.
- It never fails a turn. Every path returns a record; the top level catches and
  swallows, like evidence capture, because a turn that has already been
  delivered must not be broken by its own bookkeeping.
- It never labels support. `claimSupported` is null and `supportLabels` is empty
  in every record it writes, and the store has no setter for either.

### Human and test traffic only

`claimExtractionTrafficClasses` defaults to `["human", "synthetic_test"]`. A
heartbeat every thirty minutes would dominate both the spend and the corpus, and
it is not the traffic the calibration is about. A turn whose traffic class was
never resolved is skipped rather than extracted: unresolved is not a class, as
of 0.2.5.

### Its own store

Extraction records hold verbatim answer text and the propositions read out of
it. That is the same category of content as an evidence excerpt, so it gets the
same treatment: its own directory, its own shorter retention, 0600 in a 0700
directory, and a reference by `extractionId` from the turn record rather than an
inline copy. Telemetry keeps the status, the counts, the abstention reason and
the latency — enough to compute all four measurements without holding a single
claim.

### Off by default

`claimExtractionEnabled` is false. This is the only feature in the package that
costs money per turn, and an operator should switch that on deliberately rather
than discover it in a bill.

### Model selection

`claimExtractionAgentId` names a configured agent, and no `model` field is sent
— exactly as the CASE audit does. The operator's model choice for that agent is
the one that runs, which keeps the choice in configuration where ADR-0001's
conclusion can be revisited without a release. It requires
`llm.allowAgentIdOverride`, which this deployment already grants; it does not
require `llm.allowModelOverride`, which this plugin deliberately does not have.

## What this measures

| number | where it comes from |
|---|---|
| live abstention rate | `claimExtractionStatus`, `claimExtractionAbstentionReason` |
| composite decomposition failure | abstentions with reason `non_atomic_claims` |
| material false positives | `materialClaimCount` against reviewed extraction records |
| latency | `claimExtractionLatencyMs` |

The first, second and fourth are computable from telemetry alone. The third
needs the extraction store, because judging whether a claim was really material
requires reading it.

## Consequences

- Turn completion now includes a model call for eligible turns, bounded by
  `claimExtractionTimeoutMs` (default 20s). This is after delivery, so it is
  latency in the gateway's turn accounting rather than latency the operator
  sees. It should be watched anyway: it is real work on a shared machine.
- A provider outage produces abstentions, not failures. That is the correct
  reading — the measurement is unavailable, the turn is fine — but a sustained
  outage will look like a spike in the abstention rate, and analysis has to
  separate `provider_error` from the abstentions that are about the draft.
- Nothing downstream may consume `materialClaimCount` as a quality signal. A
  material claim is a claim worth checking, not a claim that failed.

## What this does not decide

Whether any claim holds. That is claim verification, it needs the evidence join
from `src/inspection.js`, and it is deliberately not in this release.

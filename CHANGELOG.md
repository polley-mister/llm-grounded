# Changelog

This project follows [Semantic Versioning](https://semver.org/). While the
major version is `0`, the public API may change in a minor release.

## 0.3.0

Claim extraction runs in production, in shadow. This is the first release that
adds a model call to the turn lifecycle, which is why it is a minor bump rather
than a patch, even though the extraction has no authority over anything.

Off by default. `claimExtractionEnabled: false` — this is the only feature in
the package that costs money per turn, and an operator should switch that on
deliberately rather than discover it in a bill.

See `docs/decisions/ADR-0003-shadow-claim-extraction.md`.

### Added

- Shadow extraction from `agent_end`, after every delivery lane has run.
  `before_agent_finalize` also has the draft and is the wrong place: it sits
  between the operator and their reply, so a model call there adds its latency
  to every eligible turn and a hang there is a hang the operator experiences. By
  `agent_end` the answer has been sent, so the call cannot revise it, delay it,
  or fail it. That ordering is the whole safety argument.
- It never retrieves: the request carries `tools: []`, `memory: false`,
  `workspaceContext: false`, `persona: false`, stated in the request rather than
  assumed from context and asserted by test. It never revises, refuses or
  blocks — its result is recorded and otherwise ignored. It never fails a turn:
  every path returns a record and the top level swallows, because a turn that
  has already been delivered must not be broken by its own bookkeeping.
- It never labels support. `claimSupported` is null and `supportLabels` empty in
  every record, and the store has no setter for either.
- Its own directory, its own shorter retention, 0600 in a 0700 directory.
  Extraction records hold verbatim answer text and the propositions read out of
  it, which is the same category of content as an evidence excerpt. Telemetry
  keeps the status, counts, abstention reason and latency — enough to compute
  every planned measurement without holding a single claim.
- `claimExtractionTrafficClasses`, defaulting to `["human", "synthetic_test"]`.
  A heartbeat every thirty minutes would dominate both the spend and the corpus.
  A turn whose traffic class was never resolved is skipped, not extracted.
- `claimExtractionAgentId` names a configured agent and sends no `model` field,
  as the CASE audit does, so the operator's model choice stays in configuration
  and ADR-0001's conclusion can be revisited without a release.
- Turn record fields: `claimExtractionId`, `claimExtractionStatus`,
  `claimExtractionSkipReason`, `claimExtractionAbstentionReason`,
  `claimExtractionLatencyMs`, `claimCount`, `materialClaimCount`.
- `src/inspection.js` and `scripts/inspect-turns.mjs`: the offline join of a
  turn record to the excerpts it cites. Resolves strictly by recorded
  `evidenceId` in recorded order, verifies each excerpt still hashes to what was
  written, and keeps the failure modes apart — `missing` for a recorded id with
  no file, `expired` where the turn is older than retention and pruning is the
  explanation, `unreadable`, `corrupt`. It never retrieves, never calls a model
  and never labels support.
- `docs/decisions/ADR-0002-fact-authorization-boundaries.md` and
  `src/authorization.js`. The three guards on the vault write are named apart —
  `mayExposeFactTools`, `mayInvokeFactTools`, `mayMutateFacts` — with the
  invariant that a later boundary may be stricter but never more permissive,
  made structural by each requiring the previous one.

### Fixed

- `internalTurnId` was not unique across processes: the counter restarted with
  the gateway, so `t1` named two unrelated turns from two different days in the
  first corpus that joined on it. It now carries a per-process prefix, and the
  counter is module-scoped so two indexes in one process cannot collide either.
- `no-turn-state` was unreachable. `resolveToolCall` returns null both for a
  call that was never bound and for one whose turn has expired, so both reported
  `unbound-call` — a timing fault diagnosed as a wiring fault.

## 0.2.7

Telemetry semantics for evidence capture. No change to what is captured, only
to what a record says about it. Existing records are not rewritten.

Production turns were reporting this:

```
evidenceCaptureStatus     complete
evidenceCapturedCount     4
evidenceCaptureSkipReason tool_not_allowlisted
```

Three true statements that together read as a failure. The turn called one tool
with no adapter and another that captured four excerpts. The singular field held
the first skip of any kind, while its name reads as "why did evidence capture
not happen". A corpus filtered on it would have counted healthy turns as faults.

### Changed

- A *skip* and a *loss* are now different things. A skip is something that was
  never eligible — a tool with no adapter, a result with no text. A loss is
  something eligible that was dropped — a spent budget, a capture that timed
  out, a write that failed. Only a loss moves a turn off `complete`:

```
complete        something captured, nothing eligible was lost
partial         something captured, and something eligible was lost
failed          capture was attempted, nothing captured, something was lost
not_applicable  nothing was eligible for capture
unavailable     capture could not run — a fault, not a choice
```

  Previously "attempted, captured nothing, lost nothing" reported `failed`,
  which counts a turn whose results simply held nothing capturable as a fault.
  It now reports `not_applicable`.
- `evidenceCaptureSkipReason` is populated only when nothing was captured. It is
  singular and reads as terminal, so it now answers only when it is.

### Added

- `evidenceCaptureSkipReasons`, every reason the turn saw with counts, so a turn
  that captured evidence and also skipped an unrelated tool call reports both
  rather than choosing one to be the headline.
- `evidenceCaptureLostCount`, counted apart from `evidenceCaptureSkippedCount`.
- The per-call item cap is reported. It was applied inside the adapter and again
  by a `slice`, and neither said anything: a search returning six usable hits
  under a cap of two produced two excerpts and a turn that read `complete` —
  true of what was stored, misleading about what was seen. The excess is now
  counted exactly, as `call_limit`. A cap that cannot be observed is
  indistinguishable from there being nothing more to capture.
- A capture that times out is recorded as a loss rather than a skip.
- `tests/evidence-status.test.mjs`, including the production case above as a
  named regression.

## 0.2.6

Correctness, behaviour-neutral: one turn, one identity, one place to keep its
state. Emitted telemetry is unchanged — a full turn driven through this build
and through 0.2.5 produces a byte-identical record, apart from one added field.

The host describes a turn differently at every hook. `before_prompt_build` gets
a run id, a session key and a session id; the delivery hooks get no run id; the
agent-tool-result middleware gets nothing and reaches its turn only through a
tool call id bound earlier. Each consumer derived its own key from whatever it
had, and two derivations were live at once:

```
the state store      runId ? `run:${runId}` : `session:${sessionKey}`
the telemetry maps   runId ?? sessionKey
```

Different strings for one turn. A hook holding only a session key wrote where
the reader was not looking, and no session id was indexed anywhere, so a hook
holding only that found nothing at all. This is the same shape as the traffic
defect fixed in 0.2.5 — several derivations of one fact — and it would deepen
with every field a turn gains, which is why it is done before claim extraction
adds more per-turn state.

### Added

- `src/turn-identity.js`. An internal turn id, minted once, with an alias index
  from every host field the turn was seen under. The id is deliberately not
  derived from any host field, so nothing can reconstruct it instead of
  resolving it. A supplied-but-unknown run id still resolves to nothing rather
  than to the session's current turn — the invariant that keeps one run's
  fail-closed latch away from another run in the same session.
- `internalTurnId` on the turn record, alongside `turnId` rather than instead of
  it. `turnId` remains the host-derived correlation key that evidence files
  already reference.
- `tests/turn-state.test.mjs`, which hands each hook a deliberately different
  subset of the identity — full, run-only, session-key-only, session-id-only,
  and a middleware with nothing but a bound tool call — and asserts they all
  reach one entry and one record.

### Changed

- Every hook resolves through one helper instead of assembling its own key.
  There were thirteen hand-written variants, each individually defensible:
  `ctx?.sessionKey` here, `event?.sessionKey ?? ctx?.sessionKey` there, and no
  session id anywhere.
- Store methods take the turn reference whole rather than a two-field subset,
  which silently discarded any third field a caller had.
- The five telemetry side maps — matched features, drafts, tool calls, policy,
  blocked calls — move onto the turn entry. They had no bound of their own and
  were cleared only on the `agent_end` path, so a turn that never reached
  `agent_end` leaked its drafts and matched features for the life of the
  process. They are now released, expired and bounded with the turn.
- `correctionScope` is stored once, on the entry, instead of also being copied
  into the policy snapshot beside it.

### Fixed

- The write-failure branch of evidence capture was covered by two tests that
  made a directory unwritable with `chmod 0500`, which does nothing when the
  test process is root: the write succeeded and both assertions passed for the
  wrong reason. `writeEvidenceRecord` now takes its filesystem calls as an
  injectable parameter and three tests inject `EACCES` directly. The
  permission-based tests are kept for the real syscalls and skipped under root.

### Removed

- `hardTriggerKind`, which has had no callers since the obligation moved inline
  at the advisory split.

## 0.2.5

Repair: one traffic classification per turn.

Evidence capture has been configured, enabled and inert in production since
0.2.0. `resolveTrafficClass` was called from two seams with two different
inputs. `agent_end` saw full host identity and recorded `human` or
`synthetic_test`; OpenClaw's agent-tool-result middleware receives no session
and no agent id, so it fell to `trafficClasses.default` — `system` on this
installation — which is not an allowlisted capture class. Live telemetry shows
both answers on the same turns:

```
trafficClass=human          evidenceCaptureSkipReason=traffic_class_excluded:system
trafficClass=synthetic_test evidenceCaptureSkipReason=traffic_class_excluded:system
```

Affected builds:

```
0.2.0-0.2.4: evidence capture configured but inactive in production because
middleware traffic classification lacked host identity and resolved to an
excluded class.
```

Existing telemetry is not rewritten. Those skip reasons are the evidence of the
failure.

### Changed

- **Breaking (`resolveTrafficClass`).** The return shape is now
  `{status, trafficClass, reason, signals}`, where `trafficClass` is `null`
  unless `status` is `"resolved"`. Previously three unrelated situations all
  returned `system`: a configured default, an absent one (`default:unset`) and
  an invalid one (`default:invalid(...)`). Only the first is a decision. A turn
  carrying no identity at all is now `unresolved` / `identity_unavailable`
  before any rule is consulted, so a written `default: "system"` cannot serve
  as an answer for a turn nobody could identify. An explicit rule naming
  `system` still resolves to `system`; only the fallback use was removed.
  `isResolvedTraffic` is exported for callers that want the check rather than
  the field.
- Traffic identity is resolved once, at `before_prompt_build` — the only hook
  the host gives full identity — and stored frozen on the turn, together with
  the identity it was read from. Evidence capture and terminal telemetry read
  that stored decision. No downstream hook classifies.
- Telemetry records `trafficResolutionStatus`, `trafficClassSource` and
  `trafficClassResolvedAt`. `trafficReason` is replaced by
  `trafficClassSource`; `trafficClass` is `null` rather than `"system"` when
  nothing was resolved.

### Added

- `trafficIdentityMismatch` on the turn record: set when a later hook presents
  host identity that contradicts the stored one. Diagnostic only — the first
  decision remains binding for the turn, and nothing reclassifies.
- `evidenceCaptureStatus` reports `unavailable`, not `not_applicable`, when a
  turn's identity was never resolved. Being unable to capture is not declining
  to.
- `tests/traffic-authority.test.mjs`. A source-level test: the resolver may be
  invoked from exactly one place, and no other module in `src/` may import it.
  The defect was not a wrong answer — both answers were correct for what each
  caller could see — it was a second caller, and no behavioural test fails on
  that until the two happen to disagree.
- `tests/traffic-identity.test.mjs`. The lifecycle as the host actually runs
  it: identity-rich initialization followed by identity-poor middleware. The
  existing hook tests handed the middleware a full context, which is a sequence
  that never occurs in production, and is why this stayed green for four
  releases. Those tests now open the turn first.

## 0.2.4

### Fixed

- `hardTrigger` matched against raw text, so a vocative prefix disabled every
  hard trigger: `"Hey Atlas, what is 1 + 1?"` resolved to no trigger while
  `"what is 1 + 1?"` resolved to arithmetic. Addressing the agent by name is
  the most natural way to open a turn, and it silently switched off the only
  path in the package that may compel a tool. The vocative is now stripped
  before matching. A hyphenated identifier (`atlas-chat is broken`) is still
  not treated as a vocative.
- The published type for `hardTrigger` omitted the `"correction"` kind and
  every field the correction branch returns, so a typed caller could not read
  the result it actually receives.

### Added

- `tests/explicit.test.mjs`. `hardTrigger` had no test coverage at all, which
  is how the vocative regression reached a release: it had a named test under
  the classifier it replaced, and that test did not move with the behaviour.

## 0.2.1

Repair: runtime configuration resolution.

0.2.0 shipped evidence capture that never activated in production. The
middleware could not resolve configuration in its context, fell back to package
defaults — in which every optional feature is off — and returned silently.
Telemetry reported `not_applicable`, which is indistinguishable from capture
running and finding nothing. The fact overlay shared the same defect and would
have been equally inert.

### Fixed

- Configuration resolves once, at registration, from the canonical plugin
  entry, and is stored as an immutable snapshot that both middlewares share.
- `unresolved` is now a distinct state from `disabled`. Absence of the entire
  configuration source can no longer become default-disabled; only individual
  optional keys default.
- A high-severity diagnostic is emitted once per process when configuration
  cannot be resolved, and a neutral one naming the source and settings when it
  can. The absence of that line is what made the original failure invisible.
- Telemetry distinguishes `unavailable` from `not_applicable` and records both
  the category and the specific cause.

### Note

Turns recorded under 0.2.0 with `evidenceCaptureStatus: not_applicable` are
accurate for that build: capture genuinely did not run. They are not rewritten.

## 0.2.0

Evidence capture, shadow only.

### Added

- **Claim extraction** (`src/claims.js`), offline. Reads what a draft asserts
  rather than predicting it from the turn. Discriminated result: `extracted`,
  `no_claims`, or `abstained` with a reason — a model that timed out or was
  never configured must be visible as a failure, not as a clean turn.
- **Evidence capture** (`src/evidence-capture.js`, `src/evidence-adapters.js`).
  Bounded, redacted excerpts of what a tool returned, stored apart from
  telemetry, captured after trusted overlays so it reflects what the model
  actually read. Per-tool allowlisted adapters; an unknown tool is never
  captured generically.
- **Traffic classification** (`src/traffic.js`) from host metadata, never from
  turn content.
- Offline harnesses: `claims:extract`, `claims:stability`.

### Changed

- Terminal delivery observation now distinguishes *a lane saw this text* from
  *the plugin changed it*, and reports which lane.
- The fail-closed sentence is no longer treated as a control signal on turns
  that owed no evidence.

### Notes

Nothing in this release has authority. Claim extraction is offline; evidence
capture observes tool results without altering them, the answer, or the turn.
`claimSupported` is written null and stays null: there is no entailment stage.

Model selection for extraction is recorded in
[docs/decisions/ADR-0001](docs/decisions/ADR-0001-claim-extractor-model.md).

## 0.1.0

First public release.

**On the version number.** This code ran privately for some time before it was
extracted, and carried an internal version in the 1.x range. That history is
not in this repository and the API has never been published, so the public
package starts at `0.1.0`. A `0.x` version is also the honest signal: the
architecture is settled, the thresholds are one operator's calibration, and the
export surface may still move.

### Included

- **Grounding gate.** Explicit tool requests are enforced. A turn that was
  required to retrieve and did not gets one bounded revision, then fails closed
  with a fixed sentence.
- **Sensitive-search gate.** Tool calls whose purpose is to locate a private
  individual are refused before execution, independent of policy mode. IP and
  MAC addresses are exempt.
- **Voice gate.** Replies over a configured length, or carrying stock openers,
  settings disclosures or closing exhortations, get one bounded revision on a
  budget separate from the grounding gate's.
- **Corrections.** A correction is resolved before a durable fact is written,
  and compels no retrieval: the operator is authoritative for their own world.
- **Fact transactions.** Optional and off by default. A guarded same-turn
  transaction with an isolated audit step.
- **Telemetry.** One JSONL record per turn, with bounded retention, carrying
  the verdict, the matched features, the pre-revision draft and which gates
  fired. This is what makes a false-positive rate measurable.
- **Framework-independent core** at `llm-grounded/core`, with an OpenClaw
  plugin adapter as the default entry.
- **TypeScript declarations**, generated from the source JSDoc.
- **Labelled routing vectors** at `llm-grounded/vectors`, usable to score any
  router, not just this one.

### Notable behaviour

Routing is **advisory by default**. The classifier still runs and still records
what it thought, but it cannot promote a turn to a grounded tier. Only an
explicit tool request, a parseable arithmetic expression, an administrative
command, or a correction may compel anything.

The measured cost of the previous, binding design is in
[docs/FAILURE-CATALOGUE.md](docs/FAILURE-CATALOGUE.md): across 28 ordinary
conversational turns, 61% compelled a tool, 29% ended in a refusal to answer,
and 43% were routed by a capitalisation heuristic.

The deliberate trade is stated in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):
under advisory routing the deterministic factual guarantee shrinks to explicit
requests. That is a real regression, accepted because the guarantee was
otherwise bought by breaking ordinary conversation.

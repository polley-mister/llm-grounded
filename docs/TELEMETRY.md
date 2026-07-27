# Telemetry

One JSONL record per turn, one file per day, under `telemetryDir`. Set
`telemetryDir: ""` to disable it entirely.

**Records contain verbatim conversation text.** Files are written mode `0600`
in a directory created `0700`, retention is bounded by
`telemetryRetentionDays`, and the directory is in `.gitignore`. If you publish
anything derived from a corpus, publish rates rather than records.

## Why it exists

Without per-turn records there is no false-positive rate, only opinions about
one. The corpus is also what Phase 4's claim extractor gets calibrated
against, which requires the *pre-revision* draft, not just what shipped.

## Record shape

### Provenance

| Field | Meaning |
|---|---|
| `ts` | ISO timestamp |
| `pluginVersion` | plugin version that produced the record |
| `behaviorEpoch` | label for the behaviour regime; bump on every deliberate change |
| `promptHash` | hash of the prompt surfaces (content is **never** copied in) |
| `rulesetHash` | hash of the rule files; an edit here changes decisions without touching the prompt |
| `configHash` | hash of resolved config |

The three hashes are separate on purpose. A single combined fingerprint cannot
tell you whether a behaviour change came from a prompt edit or a code edit.

### Identity

`sessionId`, `agentId`, `runId`, `turnId`, plus `synthetic` and
`syntheticReason` marks turns produced by testing rather than use. Synthetic turns
are excluded from rates and kept so destructive paths stay verifiable without
polluting the corpus.

### Decision

| Field | Meaning |
|---|---|
| `verdict.kind` | `web`, `memory`, or `null` |
| `verdict.reason` | which rule decided |
| `verdict.correction` | whether the turn read as a correction |
| `verdict.enforced` | whether that verdict was binding |
| `features` | **which patterns matched, per tier** |
| `policyMode` | `advisory` or `enforced` |
| `hardTrigger`, `hardReason` | the explicit trigger, if any |
| `correctionScope`, `evidenceSource`, `policyScope` | correction resolution |
| `legacyVerdict`, `legacyReason`, `legacyWouldCompel` | what the old binding classifier *would* have done |
| `actualToolUsed` | whether a tool was actually called |

`features` is the field that makes the corpus survive a rule change. Without
it, old traffic cannot be re-scored and every rule edit orphans everything
collected before it.

### Outcome

`tools`, `blockedTools`, `toolBlocked`, `draft`, `final`, `draftCount`,
`gates.{revised,voiceRevised,failedClosed,offTopicTools,voiceViolations}`,
`model`, `latencyMs`, `draftWords`, `replyWords`.

`draftWords` and `replyWords` are both recorded, always. With the voice gate
enabled the pair measures its effect directly, which is why the gate stays on
rather than being switched off to observe the untouched tail.

## Computing a false-positive rate

The enforcement rate is not the error rate. The measure that matters is
**disagreement**:

```
false-positive pool:  legacyWouldCompel === true  &&  actualToolUsed === false
false-negative pool:  legacyWouldCompel === false &&  actualToolUsed === true
```

Each turn in the first pool is a case where the old contract would have
compelled work and a free model reached for nothing. Hand-label it: was the
tool genuinely needed? Those labels are the only honest precision figure
available.

Both pools are small enough to review weekly.

Weight by asymmetric cost when you summarise. A false `web`, an unnecessary
search on a conversational turn, is roughly ten times worse than a false
`null`, because one wastes a call and breaks the conversation while the other
merely leaves a suggestion unmade.

## Measured example

Over 28 ordinary turns under enforced routing, at a single epoch:

| Measure | Value |
|---|---|
| Tool compelled | 61% |
| Ended fail-closed | 29% |
| Tripped the named-entity heuristic | 46% |
| Routed to web by that heuristic alone | 43% |
| Voice gate fired | 32% |
| Draft p90 length → delivered p90 | 144 → 82 words |

The same corpus, split by model within one epoch: median reply 49 vs 45 words,
voice gate 32% vs 33%, fail-closed 32% vs 22%, latency 8.1s vs 15.3s. An
earlier claim that the slower model was "dramatically better" did not survive
being measured. The reliable difference was latency.

## Analysis notes

- **Segment by epoch, always.** Mixing epochs is how the model comparison above
  went wrong the first time.
- **Exclude synthetic turns from rates**, but keep them.
- **A zero needs a field to be zero in.** `blockedTools` is recorded even though
  it is almost always empty, because "no sensitive searches executed" is a
  success criterion and an absent field cannot express it.

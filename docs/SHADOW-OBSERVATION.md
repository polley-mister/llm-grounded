# The shadow observation period

Claim extraction runs in production and has authority over nothing. This
describes what is being measured, what is deliberately not being measured yet,
and what may be changed while the measurement is running.

## The freeze

Frozen at 0.3.4. Do not change the extractor prompt, the model, the traffic
policy, the timeout, the storage format, or the production lifecycle until the
sampling target is met.

```
calendar duration                 at least 7 days
eligible human/synthetic turns    at least 150
fact-bearing extracted turns      at least 30
```

The third matters more than raw eligible traffic. A conversational turn excluded
before the model call is useful evidence about the traffic policy and says
nothing about extraction quality.

### What may be fixed during the freeze

Operational defects only:

- extraction completion loss
- provider errors and malformed responses
- timeouts
- unexpected model calls on excluded traffic
- store integrity or permission failures
- sustained resource pressure on the shared host

Anything about prompt or model *quality* is recorded, not tuned. Tuning against
observations drawn from the same window they will be judged by leaves nothing to
judge.

## Reading the numbers

`node scripts/shadow-report.mjs --telemetry <dir> --extractions <dir>
--window-epoch <epoch>`

### Denominators

Three, because one number cannot answer both "is extraction working" and "how
much traffic has this deployment seen".

```
eligibleTurns                   all eligible telemetry turns, all history
eligibleSinceExtractionEnabled  turns whose record carries an extraction field
eligibleInWindow                turns under the epoch being measured
scheduledInWindow               of those, turns that scheduled an extraction
completedInWindow               of those, turns whose extraction finished
```

`schedulingRate` and `completionRate` are both window over window. Neither mixes
an all-time numerator with an in-window denominator — 3 scheduled against 50
eligible reads as a 6% scheduling rate, when in fact 47 of those turns ran
before the feature existed and were never candidates. `completionRateAllTime` is
kept beside them and is not the headline.

### Materiality

```
materialLabelRate        how often the extractor applied the material label
materialityPrecision     not yet measured
materialityRecall        not yet measured
claimPrecision           not yet measured
claimRecall              not yet measured
```

The first is a prevalence statistic about the extractor's own output. It is not
precision. 18 of 19 claims marked material says how often the label was applied,
not whether any of those 18 assignments were correct, and says nothing at all
about what was missed. Both need human labels, and the report carries them as
explicit nulls rather than omitting them so that nobody can read the label rate
as either one.

### Completion loss

A scheduled record is written before the model is called and completed in place
afterwards. If the process dies mid-call, `agent_end` never finishes and no turn
record is written, so the scheduled file on disk is the only evidence the
extraction was ever attempted.

`scripts/inspect-turns.mjs` separates:

```
complete   the record finished
pending    not written yet, inside the settlement window (60 s default)
lost       scheduled and never finished, past the window
missing    the turn claims an extraction, nothing on disk, past the window
expired    gone, and the turn is older than retention — pruning explains it
```

`pending` and `lost` exist because extraction runs *after* delivery, so a turn
record can be read before its extraction lands. Reading that as loss would
report a completion failure on every turn caught mid-flight.

## The manual audit

Once the pool is large enough: `scripts/shadow-report.mjs --sample` produces a
stratified sample. Stratified rather than random because the interesting groups
are rare — an all-material extraction and a stored-personal claim would each
appear once or twice in fifty random turns, and those are the two the
materiality judge is most likely to get wrong.

**Label blind to the extractor's decision where practical.** Determine the
claims first, then compare. Reading the model's output first anchors the
judgement, and the thing being measured is whether the model agrees with a human
who had not seen it.

Per turn:

```
gold claims asserted by the answer
atomicity
claim type
materiality
missed claims
spurious claims
duplicate propositions
elliptical reconstruction correctness
```

Then compute, separately:

```
claim precision and recall
material-claim precision and recall
claim-type accuracy
atomic decomposition rate
conversational material false-positive rate
abstention rate
end-to-end recall with abstentions counted as misses
```

### Overlabelling patterns to watch

The first audit should include the ten-of-ten record specifically. Plausible is
not the same as correct — a price comparison can legitimately be all material.
Watch for:

- retailer names or formatting details treated as independently material
- transitional or explanatory sentences marked material
- uncertainty statements treated as claims about the unknown external fact
- one comparison decomposed into duplicate claims
- source attribution and the underlying proposition counted twice

### Not during this audit

No support labelling, no entailment. That is a separate judgement and mixing it
in confounds extractor quality with evidence adequacy — the question "did the
model correctly identify what was claimed" has to be answered before "was the
claim supported" means anything.

## Acceptance thresholds

Before moving toward claim-to-evidence matching:

```
invalid accepted outputs                  0
accepted mechanically non-atomic claims   0
extraction completion rate                >= 98%
timeout rate                              < 1%
conversational material false positives   <= 2%
bare-answer recall                        >= 95%
current-external recall                   >= 95%
stored-personal recall                    >= 95%
```

Manual materiality precision at least 95% for continued shadow development.
Enforcement would require substantially stricter.

## The timeout

20 seconds, unchanged while the distribution is gathered. One 10.1-second call
is not grounds to move it. Revisit if any of:

- p95 approaches 15 s
- timeouts exceed 1%
- long claim-bearing answers cluster near the ceiling

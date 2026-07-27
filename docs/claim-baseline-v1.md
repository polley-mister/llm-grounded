# Claim extractor — untuned baseline v1

Frozen record of the first live run, kept so later prompt work is measured
against something that cannot move. **No prompt tuning had occurred when these
numbers were produced.**

## Run

| | |
|---|---|
| prompt version | `claims-v1` |
| provider / model | `deepseek` / `deepseek-v4-flash` |
| transport | `openclaw capability model run` (one-shot, no agent) |
| corpus | `tests/fixtures/claims-corpus-baseline-v1.jsonl` — 24 turns, 21 gold claims, 17 groups |
| core commit | `69d9d7c` |
| date | 2026-07-27 |

## Results

```
records:   24
  extracted:  13
  no_claims:  10
  abstained:   1   (malformed_output)

recall by claim type
  stable_general             3/3   100%
  current_external           5/6    83%
  system_or_runtime_state    3/4    75%
  stored_personal            2/3    67%
  calculated                 2/4    50%
  opinion_or_recommendation  1/1   100%

conversational turns given a material claim:   0 of 8
invalid output accepted as valid:              0
```

## What this establishes, and what it does not

**Establishes.** The isolated provider path works. Every one of the eight
conversational turns produced `no_claims` with zero material claims, including
*"I could not confirm a current price, so I won't quote one"* — an uncertainty
statement that a naive extractor would flag as the very claim it declines to
make. That is the property most likely to regress while chasing recall, and it
is the one that must not.

**Does not establish a malformed-output rate.** One malformed response in 24
calls is a single observation, not a measurement. Re-running the same input
produced valid output, which shows provider nondeterminism at temperature 0 and
nothing more. A rate needs ≥200 calls; until then malformed abstentions are
reported as counts.

**Does not establish a production false-positive rate.** Eight curated
conversational turns is a count, not a rate.

## Known gaps this run exposed

**Composite decomposition does not happen.** On the budget-versus-price case the
model returned two claims, the first being the whole compound sentence labelled
`conversation_supplied`. Non-atomic claims cannot be mapped to distinct
evidence, which is the entire purpose of the next stage.

**Bare answers are dropped.** `"Four hundred and eight."` and `"Humour is at
65."` were both read as non-factual. The proposition in an elliptical answer
lives partly in the operator's turn, and the v1 contract never said so.

Both gaps are addressed by schema fields added in this commit — `proposition`,
`dependsOn` — and by prompt work that is deliberately **not** part of it.

## Split status

All three partitions of the v1 corpus were observed during this run. They are
therefore **not** held out any longer, and the v1 corpus is retained only as
this frozen baseline.

Corpus v2 supersedes it: 117 turns, 103 gold claims, 50 groups, stratified by
scenario family so each split carries a proportional share of each family while
keeping paraphrase groups whole.

`tests/fixtures/claims-corpus-test-v2.jsonl` has **not been run** and must stay
unobserved until the prompt is frozen.

# ADR-0001: Use DeepSeek V4 Flash for shadow claim extraction

Status: Accepted
Date: 2026-07-27

## Context

Claim extraction is offline today and will first run in production shadow mode.
Its output will have no authority to compel a tool, revise an answer, block
delivery, or fail closed.

DeepSeek V4 Flash was evaluated over five repeated runs of the frozen
development split. DeepSeek V4 Pro was evaluated **once** against the same
prompt, transport, temperature, token limit, corrected schema and corpus, with
no retries.

The original composite benchmark was itself defective: it required every premise
to be independently anchored to a span in the draft, and three cases assert only
a comparison whose premises are never stated. That is not expressible, and one
case failed in five runs out of five for that reason alone. After separating
answer claims from implied evidence premises, Flash's composite decomposition
improved from a 44–78% swing to 88.9%.

## Results

| Metric | Flash | Pro |
|---|---:|---:|
| Calls | 92 | 92 |
| Cost | $0.044 | $0.537 |
| Median latency | 4.2 s | 10.2 s |
| Wall clock | 13 min | 23 min |
| Coverage | 97.8% | 98.9% |
| `calculated` end-to-end recall | 94.4% | 100% |
| `current_external` end-to-end recall | 95.5% | 95.5% |
| `stored_personal` end-to-end recall | 93.8% | 93.8% |
| `system_or_runtime_state` end-to-end recall | 100% | 100% |
| `stable_general` end-to-end recall | 100% | 100% |
| Composite decomposition | 8/9 | 8/9 |
| Bare-answer recall | 100% | 100% |
| Conversational material false positives | 1/23 | 0/23 |
| Invalid outputs accepted | 0 | 0 |
| Accepted non-atomic extractions | 0 | 0 |

Both models spend most of their generation on reasoning — 86% and 89% of output
tokens respectively — which is why an earlier 1,500-token limit returned empty
content. Pro used slightly *fewer* output tokens than Flash.

Flash's five-run study measured conversational false positives at **1, 2, 0, 1,
0** and coverage from **94.6% to 97.8%**. Pro's single-run figures sit inside
both ranges.

## Decision

Use DeepSeek V4 Flash for production shadow claim extraction.

Do not use extractor output for enforcement.

Do not run the planned Pro stability panel at this stage.

## Rationale

Flash is accurate when it returns an accepted extraction — conditional recall
was 100% in every run — abstains safely at a bounded 2–5%, and has never
produced an accepted malformed or mechanically non-atomic output.

Pro's advantages amount to one fewer false positive, one fewer abstention and
one additional `calculated` claim, measured once. Every one of those falls
within variance Flash has already demonstrated across five runs. **This is n=1
against n=5**, and a single run cannot distinguish a better model from a better
sample. That is precisely the error made earlier in this project, when a prompt
was edited to fix a false positive that then failed to reproduce in any of five
runs.

Establishing a real difference would require Pro's own five-run panel, at
roughly 12× the cost, to decide a question that does not gate the next step.

The blocker for shadow mode is that tool results are captured nowhere, so
"unsupported" cannot be computed at all. That is an absent capability, not a
model-quality problem, and no amount of extractor accuracy addresses it.

## Consequences

- Shadow extraction is expected to abstain on roughly 2–5% of turns, based on
  development observations rather than production traffic.
- Extractor conclusions are telemetry only and carry no authority.
- `validation` and `test-v2` remain unrun; the prompt is not frozen.
- Model selection must be revisited before any enforcement decision.

## Revisit criteria

Re-evaluate Pro or another model when any of these becomes true:

- extractor output is proposed for enforcement;
- shadow traffic shows a systematic Flash false-positive family;
- end-to-end recall stays below threshold on real claims rather than curated
  ones;
- abstention materially limits evidence-verification coverage;
- provider pricing or latency changes substantially;
- a specialised claim or materiality classifier becomes available.

## Note on what actually moved the numbers

The largest improvement in this cycle came from correcting the benchmark, not
from changing the model. A significant share of what had been recorded as model
instability was a schema that demanded something the drafts could not express.
Worth remembering the next time a metric looks like a model problem.

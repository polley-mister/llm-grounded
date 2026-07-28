# Changelog

This project follows [Semantic Versioning](https://semver.org/). While the
major version is `0`, the public API may change in a minor release.

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

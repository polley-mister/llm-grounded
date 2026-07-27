# Claim verification

## Why this exists

The classifier decided what evidence an answer needed *before the answer
existed*. That is prediction over unbounded input, and it cannot be made to
work: every fix produced a new way for a prompt to be misread. The measured
cost is in [FAILURE-CATALOGUE.md](FAILURE-CATALOGUE.md) — 61% of ordinary turns
compelled a tool, 29% ended in a refusal.

Claim verification moves the decision to where the information actually is. A
draft states its own assertions in plain text; you do not have to guess what it
will say. The classification problem is not solved, it is **deleted**.

The cost asymmetry flips too. A false positive on input destroys a turn. A
false positive on output costs one revision, which is already budgeted.

This document defines the contracts. They come first deliberately: writing
extraction code against ambiguous semantics is exactly how the precedence chain
accreted.

---

## What a claim is

An **atomic proposition** that could in principle be true or false, carried by
the draft.

Atomic matters. This sentence is three claims, not one:

> Your $3,500 budget is not enough for the card's current $4,000 price.

| text | claimType | requiredEvidence |
|---|---|---|
| Your budget is $3,500. | `stored_personal` | `["memory"]` |
| The card currently costs $4,000. | `current_external` | `["web"]` |
| $3,500 is less than $4,000. | `calculated` | `["calculation","claim:c1","claim:c2"]` |

They have different evidence needs and different failure modes. A single label
over the sentence would force a choice between things that are not
alternatives — the same mistake as the exclusive routing tiers, reappearing one
level down. **`claimType` is a single primary type; `requiredEvidence` is
multi-label.**

---

## Claim types

Keyed on **epistemic source** — where the truth of the claim comes from — not on
subject matter. Subject matter is what the old classifier keyed on, and it is
why "Humor" being capitalised routed a settings question to the web.

| type | the claim's truth depends on |
|---|---|
| `current_external` | the world right now, outside this system |
| `stored_personal` | something the operator told us previously |
| `conversation_supplied` | something stated in this conversation |
| `calculated` | arithmetic or derivation from other claims |
| `stable_general` | durable public knowledge unlikely to have changed |
| `system_or_runtime_state` | this system's own configuration or state |
| `opinion_or_recommendation` | a judgement, not a fact about the world |
| `non_factual` | greeting, acknowledgement, banter, stylistic content |

`stable_general` is deliberately separate from `current_external`. "Water boils
at 100°C at sea level" and "the card costs $4,000" are both factual and only one
of them goes stale.

---

## Modality, factuality, materiality, verification

Four independent fields. Collapsing them is how gates become evadable.

**Modality** describes *how the proposition is presented*. It does **not** decide
whether verification applies:

| modality | normally truth-evaluable |
|---|---|
| `asserted` | yes |
| `hedged` | **yes** — "probably around $4,000" is still checkable |
| `attributed` | the attribution is; the embedded proposition may be too |
| `quoted` | the quote and its source may both be |
| `hypothetical` | usually not |
| `interrogative` | usually not |
| `imperative` | usually not |

Hedging must not be an exemption. If it were, a model would learn that "probably"
buys it out of the contract, and the gate would decay into a style filter.

Attribution is subtler: *"NVIDIA says the card has 48 GB"* contains two claims —
that NVIDIA said it, and possibly that it is true. The first is checkable on its
own.

**`factual`** — is this a proposition about the world at all?

**`material`** — does it matter enough to interrupt a turn over? `{factual: true,
material: false}` is legal and common:

> That is a common approach, but I would use a state machine here.

"Common approach" is arguably factual. It is not what the answer turns on.
**Only material claims enter the remedy ladder.**

**`verificationTarget`** — the field that actually gates the ladder. Derived
from the other three plus type, and stated explicitly so the decision is
inspectable rather than recomputed differently by each consumer.

---

## Claims that must not trigger anything

The extractor downgrades or excludes:

greetings and acknowledgements · humour and banter · questions · commands ·
recommendations framed as recommendations · conclusions derived directly from
user-supplied facts · statements of uncertainty · stylistic content ·
hypotheticals and role-play · reasoning that adds no external premise

Worked examples:

```
"Goodnight."
  → no claims

"That architecture is brittle."
  → opinion_or_recommendation, material:false, no evidence required

"If the cart is frictionless, its acceleration is 4 m/s²."
  → calculated or conversation_supplied, depending on what the turn supplied

"What if I told you I am <a famous actor>?"
  → interrogative / hypothetical, no durable personal claim
```

That last one is a real production failure: it became a web search for a
private individual's residence.

---

## Support states

Assigned during evidence verification, **not** by the extractor. The extractor
cannot know support before evidence exists, and a field it can guess at is a
field it will guess at.

`supported` · `partially_supported` · `contradicted` · `unsupported` ·
`not_applicable` · `unknown`

Deliberately not binary. Partial support is common — evidence showing several
listings near $4,000 supports "around $4,000" and not "$4,000" — and it selects
a different remedy.

---

## Remedy ladder

Per claim, not per turn. A single unsupported sentence must not discard an
otherwise good answer.

1. **Preserve** — supported.
2. **Remove** — unsupported and not load-bearing. Deletion cannot invent.
3. **Hedge** — exactness exceeds the evidence but a qualified form is supportable.
4. **Retrieve** — missing evidence is obtainable and the claim is material.
5. **Revise** — regenerate only the affected portion.
6. **Narrow refusal** — the central claim cannot be established. Say which part
   failed and answer the rest.

Rungs 3 and 5 rewrite text, which is where a renderer starts altering numbers or
dropping qualifications. They stay gated on measured extractor precision;
deletion ships first.

---

## Extractor contract

```js
extractClaims({ userTurn, draft, conversationFacts }, { llm, ... })
```

Returns a **discriminated** result. Abstention is never disguised as "no claims":

```js
{ status: "extracted", provenance: {...}, claims: [ ... ] }
{ status: "no_claims", claims: [] }
{ status: "abstained", reason: "no_llm" | "timeout" | "malformed_output"
                             | "low_confidence" | "oversized" | "empty_draft" }
```

A broken extractor reading as a clean conversational turn would be the same
class of error as the fail-closed sentence being treated as a control signal: a
failure that disguises itself as a normal outcome in the metric. Enforcement may
treat `abstained` permissively; **metrics must count it separately.**

Per claim:

```
id, text, sourceStart, sourceEnd, sentenceIndex,
claimType, modality, factual, material, verificationTarget,
requiredEvidence[], confidence
```

Source offsets are into the draft and make prediction-versus-gold matching
deterministic, rather than a subjective judgement about whether two phrasings
are "the same claim".

### Invariants

- **Isolation.** The call requests no tools, no memory, no workspace context, no
  persona. The extractor sees its own contract and the explicit inputs. Asserted
  by test, not assumed from a name.
- **No legacy input.** The extractor is never given `legacyVerdict` or
  `features`. Biasing the replacement toward reproducing the classifier is the
  one outcome that makes the exercise pointless.
- **The deterministic layer does not classify.** It normalises, segments,
  bounds length, redacts obvious secrets, preserves offsets. It does **not**
  drop questions or quotations:

  > "The update is already installed," according to the service log.
  >
  > The current version is 2.1, correct?

  Both carry material content despite their syntax. Removing content before the
  model sees it is how semantic decisions get smuggled back into a regex.
- **Temperature 0, strict schema, bounded output.** Off-schema output abstains.

---

## Evidence capture contract

Not implemented yet; specified here so the next commit does not default to
recording whole tool payloads.

Bounded, redacted excerpts in the evidence store, referenced from telemetry by
id:

```json
{
  "evidenceId": "e1",
  "turnId": "...",
  "tool": "web_search",
  "sourceType": "web",
  "query": "...",
  "excerpt": "...",
  "excerptHash": "sha256:...",
  "retrievedAt": "...",
  "truncated": true
}
```

Requirements: strict excerpt size bounds; secret and credential filtering;
`0600` permissions; never whole pages or transcripts; never raw results in
ordinary telemetry; a retention policy; and an explicit distinction between
*the tool succeeded* and *the claim is supported*. Those are different facts and
conflating them is how "a web tool ran" became a proxy for grounding.

---

## Calibration

The live corpus is too small and too smoke-test-heavy to calibrate against: 71
records, 56 non-heartbeat, 16 human-classified. The development benchmark is
therefore a curated, PII-free labelled corpus in this repository.

**What the curated corpus is valid for:** schema validation, regression
coverage, per-type recall, materiality and modality behaviour, threshold
development.

**What it is not:** evidence about production false-positive rates. Replay over
real telemetry reports raw counts — "0 material false positives among 16 human
turns" — never as proof of a rate.

Splits are assigned by hashing `groupId`, not the turn id, so paraphrases of one
scenario cannot land in three different splits and inflate apparent
generalisation.

### Metrics, reported separately

| metric | shadow target |
|---|---|
| conversational turns given a material claim | ≤2% |
| recall, clear `current_external` | ≥95% |
| recall, clear `stored_personal` | ≥95% |
| whole-answer intervention on conversational turns | 0% |
| off-schema extractor output | 0% (abstain instead) |
| abstention rate by reason | reported, never merged into `no_claims` |

Never aggregated into one accuracy number. A missed external claim and a false
claim on "Good one" are not interchangeable, and averaging them hides the exact
failure this project exists to avoid.

---

## When the precedence chain can be deleted

Only once claim-level telemetry shows all of:

1. hard triggers still cover explicit commands and arithmetic;
2. the extractor catches material current-external and stored-personal claims;
3. post-draft retrieval can obtain missing evidence;
4. claim-specific revision does not damage conversational turns;
5. the classifier contributes no unique safety coverage.

Then `explicit.js`, `corrections.js`, the arithmetic parser and the
administrative commands remain. Everything else in `classify.js` goes behind a
flag first, and is removed after one clean epoch.

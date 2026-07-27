# llm-grounded

A deterministic grounding and voice contract for LLM agents.

llm-grounded sits between a model and its user. It decides — in ordinary code,
not in a prompt — when an answer needs evidence, whether the evidence actually
arrived, and whether the reply that came back is the shape the operator asked
for. When something is missing it asks for one bounded revision, and when that
fails it says so rather than shipping a confident guess.

**The core is framework-independent.** It is plain synchronous functions over
strings and plain objects: it opens no sockets, calls no model, and holds no
framework types. An [OpenClaw](https://openclaw.ai) plugin adapter ships in the
box; for anything else — LangGraph, the Vercel AI SDK, the OpenAI Agents SDK, a
hand-rolled loop — import the core and write the adapter, which is a handful of
call sites. See **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

```js
import { hardTrigger, assessToolSafety, assessVoice } from "llm-grounded/core";
```

It is small, dependency-free, and heavily commented. Most of the comments
explain a failure that happened in production.

> **Status: works, but young.** This runs a single homelab installation. The
> architecture and the failure catalogue are the parts worth borrowing; treat
> the thresholds as one operator's calibration rather than defaults you should
> trust.

---

## The problem it exists for

An agent that can search will search when it shouldn't, and will answer from
nothing when it should have looked. Prompt instructions ("only search when
necessary") are advisory to a model in a way that code is not.

The obvious fix — classify the user's turn, then compel the matching tool — is
the one this project started with, and it is worth being explicit about how
badly it went. Across 28 ordinary conversational turns:

| Measure | Value |
|---|---|
| Turns where a tool was compelled | **61%** |
| Turns that ended in a refusal to answer | **29%** |
| Turns where a capitalised-word heuristic decided the route | **43%** |

Some concrete failures from that period:

- `Are you able to change your Humor setting to 100?` — "Humor" is capitalised,
  so it read as a proper noun, so the turn was routed to the web, so the agent
  searched the internet for information about its own configuration.
- `Good one` — capitalised common word, same path, and the two-word reaction to
  a joke ended in *"I could not verify that, so I will not answer."*
- `What if I told you that I am <name of a famous actor>?` — a playful
  hypothetical became a web search for that person's private residence.

Every one of those is a **jurisdiction** error rather than a judgement error.
The contract was deciding what evidence an answer needed *before the answer
existed*, which is prediction over unbounded input. The classifier worked
correctly on turns it should never have owned.

## The approach

**Advisory by default; deterministic where semantics are unambiguous.**

Hard enforcement survives only where the meaning of the turn is not in
question:

- an explicit request for a tool — "search the web", "check your memory"
- a bare, parseable arithmetic expression
- administrative and direct tool-invocation commands
- a correction to a fact that is about to be written down
- a search whose purpose is to locate a private individual

Everything else defaults permissive. The classifier still runs and still
records what it thought, but it cannot promote a turn to a grounded tier. That
verdict becomes a measurement rather than an instruction, which is what makes a
false-positive rate observable instead of theoretical.

The honest cost of that choice is stated in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): between advisory routing and
claim-level verification, the deterministic factual guarantee shrinks to
explicit requests. That is a real regression, taken deliberately, because the
guarantee was otherwise being bought by breaking ordinary conversation.

## What it does

| Gate | Behaviour |
|---|---|
| **Grounding** | Explicit tool requests are enforced. A turn that was required to retrieve and did not gets one bounded revision, then fails closed with a fixed sentence. |
| **Sensitive search** | Searches whose purpose is to locate a private residence, personal contact details, or a named individual's identity are blocked outright. IP and MAC addresses are exempt. |
| **Corrections** | A correction must be *resolved* before a durable fact is written. It does not compel retrieval: the user is the authority on their own world, so their assertion is the evidence. |
| **Fact transactions** | Optional. Writing a durable fact goes through a guarded transaction with an audit step. Off by default. |
| **Voice** | Replies over a configured length, or carrying stock openers, get one bounded revision. Measured effect: p90 draft length 144 words → 82 delivered. |
| **Telemetry** | One JSONL record per turn: the verdict, which patterns matched, tools called, the pre-revision draft, the delivered text, which gates fired, latency, model. Bounded retention. |

Everything is fail-closed on its own failure: an error inside the plugin
withholds the write or the answer, it does not silently open the gate.

## Install

```bash
git clone https://github.com/OWNER/llm-grounded.git
cd llm-grounded
npm test                      # 215 tests, no dependencies
```

Requires Node 22.19+. There are no runtime dependencies and nothing to build.

### As an OpenClaw plugin

```bash
openclaw plugins install --link "$PWD"
```

Then add configuration under `plugins.entries.llm-grounded.config` — see
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) and
[examples/config.example.json](examples/config.example.json). Requires OpenClaw
2026.6.0+.

**OpenClaw does not reload plugin code on its own.** Restart the gateway after
installing or editing, or you will spend an evening debugging behaviour that is
not the behaviour you have on disk. This has happened to the author more than
once.

### In any other stack

```js
import {
  hardTrigger, requirementText, advisoryText,
  assessToolSafety, blockMessage, assessVoice,
} from "llm-grounded/core";
```

Three call sites — before you build the prompt, around tool dispatch, and after
the model drafts — get you the grounding, sensitive-search and voice gates.
Adding the obligation store and the turn logger is another dozen lines.
[docs/INTEGRATION.md](docs/INTEGRATION.md) has the full walkthrough, a mapping
table for common frameworks, and the invariants you must not break in an
adapter.

The OpenClaw peer dependency is declared optional; `llm-grounded/core` never
imports it, and `tests/core.test.mjs` asserts that structurally so it stays
true.

## Configuration you should not skip

Two keys carry your installation's vocabulary. Both default to empty, because
this package ships with nobody's private world compiled into it:

```jsonc
{
  "agentNames": ["atlas"],
  "personalTerms": ["sam", "rivera", "parts catalogue", "on-call weekend"]
}
```

`agentNames` are the names your agent answers to. Being addressed by name is
stripped before classification — without this, a capitalised agent name reads
as an external proper noun and the turn goes looking for evidence about its own
name.

`personalTerms` are the names, projects, hosts, and schedule vocabulary that
belong to you. Questions containing one route to memory rather than the web,
and the words are never mistaken for external entities.

Leaving both empty is safe. The classifier simply never treats a proper noun as
personally owned, which under advisory routing costs a slightly worse
suggestion and nothing else.

## Documentation

- [Integration](docs/INTEGRATION.md) — using the core outside OpenClaw: the
  seam, the call sites, per-framework notes, and what you give up
- [Architecture](docs/ARCHITECTURE.md) — the hooks, the precedence chain, why
  the classifier is advisory, and what is deliberately not built yet
- [Configuration](docs/CONFIGURATION.md) — every key, what it does, what
  happens when it is wrong
- [Failure catalogue](docs/FAILURE-CATALOGUE.md) — the bugs, with the measured
  cost of each and the shape of the fix
- [Telemetry](docs/TELEMETRY.md) — the record format and how to compute a
  false-positive rate from it

## Design notes worth stealing even if you do not use this

**Measure disagreement, not enforcement.** The rate at which a gate fires is
not its false-positive rate. False positives live in the set of turns where the
gate would have compelled a tool and a free model reached for nothing. That set
is small enough to hand-label weekly and is the only honest measure available.

**Deletion cannot invent; rewriting can.** When a reply contains an unsupported
claim, the remedy ladder is log → strike the sentence → revise the turn → fail
closed. Attribution and hedging come last, gated on measured precision, because
a false positive that silently rewords a figure is worse than one that visibly
removes a sentence.

**Roll epochs, do not freeze development.** Every record carries a behaviour
epoch plus separate hashes for the prompt, the ruleset, and the config. A
measurement corpus that cannot tell you which code produced it is not a corpus.
Segmenting by epoch beats holding still.

**A correction is a scope, not a tier.** "A correction must be resolved before a
durable fact is written" and "every correction must run a memory search" are
different claims. Conflating them is what put a grounding gate in front of
ordinary conversation.

## License

MIT. See [LICENSE](LICENSE).

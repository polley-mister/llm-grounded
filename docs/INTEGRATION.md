# Integrating llm-grounded into another stack

This package ships an OpenClaw plugin, but nothing that decides anything
depends on OpenClaw. The decision logic is plain synchronous functions over
strings and plain objects. If you are running LangGraph, the Vercel AI SDK, the
OpenAI Agents SDK, or a hand-rolled `while` loop around a chat completion, you
can use the same gates by importing the core and writing the adapter yourself.

```js
import { hardTrigger, assessVoice, assessToolSafety } from "llm-grounded/core";
```

The adapter is the part you write. In this repo it is `src/index.js` — about a
thousand lines, but the large majority of that is OpenClaw-specific bookkeeping
(run/session key reconciliation, two delivery lanes, the optional fact
transaction) that you will not need. The load-bearing calls into the core are
the handful shown below.

---

## What the core is, and what it deliberately is not

`llm-grounded/core` answers two questions and refuses to answer a third:

| Question | Answered by |
|---|---|
| What does this turn oblige? | `hardTrigger`, `detectFactStatement`, `resolveCorrection` |
| Does this reply satisfy it? | `isReleasable`, `assessVoice`, `assessToolSafety` |
| *When should I call the model, how do I retry, where does state live?* | **Your host.** Not this package. |

That third row is the whole reason the seam exists. Retry semantics, streaming,
session identity, and persistence are the things every framework does
differently and does opinionatedly. A library that guessed at them would fight
your framework rather than compose with it.

Concretely, the core:

- never opens a network socket
- never calls a model
- never writes to disk *(the two modules that do — `evidence.js` and
  `telemetry.js` — are imported separately and are optional)*
- holds no framework types, and no `async` in the decision path

`createGroundingStore` is in-memory and process-local. If you run more than one
process, either pin a session to a process or reimplement the store against
your own state layer — it is a small interface and the semantics are documented
below.

---

## The minimal integration

Three gates, no state, no telemetry. This is a genuinely useful amount of the
value and takes about fifteen lines.

```js
import {
  hardTrigger,
  requirementText,
  advisoryText,
  classifyGrounding,
  assessToolSafety,
  blockMessage,
  assessVoice,
  configureAgentNames,
  configurePersonalTerms,
} from "llm-grounded/core";

// Once, at startup. Both default to empty, which is safe.
configureAgentNames(["atlas"]);
configurePersonalTerms(["sam", "rivera", "parts catalogue"]);

// 1. Before you build the prompt — decide what this turn may compel.
const hard = hardTrigger(userTurn, { prevAssistant });
const advisory = hard.kind === null;
const legacy = classifyGrounding(userTurn, { prevAssistant });   // measurement only

const instruction = advisory
  ? advisoryText(legacy.kind)                 // a hint; safe to ignore
  : requirementText(hard.kind);               // an obligation
if (instruction) systemContext.push(instruction);
// requirementText returns "" for arithmetic, admin and correction triggers —
// those bind a scope, not a retrieval tier, so no requirement text is injected.

// 2. Before you execute any tool call — refuse private-person lookups.
const safety = assessToolSafety(toolName, params);
if (safety.blocked) return blockMessage();    // returned to the model in place of results

// 3. After the model drafts a reply — check its shape.
const voice = assessVoice(draft, { userMessage: userTurn, maxWords: 90 });
if (!voice.ok) {
  // Retry once with voice.instruction appended. Once. See "Budgets" below.
}
```

`hardTrigger` returning `{kind: null}` is the normal case and is *the point* —
permissive by default. Read
[the failure catalogue](FAILURE-CATALOGUE.md) for the measured cost of getting
this backwards.

---

## The full integration

Add the obligation store when you want the grounding gate to actually enforce —
that is, to notice that a turn was required to retrieve and did not.

```js
import { createGroundingStore, isReleasable, revisionInstruction, FAIL_CLOSED_TEXT }
  from "llm-grounded/core";

const store = createGroundingStore({ ttlMs: 600_000, maxEntries: 200 });
const key = { runId, sessionKey };            // either may be undefined; not both
```

**At the start of a turn**, record the obligation. Only `web` and `memory` are
tiers; everything else is stored as `kind: null`, which is releasable on
arrival:

```js
store.begin({
  ...key,
  kind: hard.kind === "web" || hard.kind === "memory" ? hard.kind : null,
  reason: legacy.reason,
  userMessage: userTurn,
  prevAssistant,
});
```

**After each tool result**, tell the store what happened. This is what marks an
obligation satisfied:

```js
store.recordTool({ ...key, toolName, ok: !isError, params });
```

Satisfaction is not merely "a tool ran". `recordTool` marks the entry verified
only when the tool matches the obligation (`web_search` for `web`;
`memory_search` or `wiki_search` for `memory`) **and** the query is topically
related to the turn. The right tool aimed at the wrong subject leaves the entry
unverified on purpose.

**Before you deliver the reply**, check and remedy:

```js
const entry = store.get(key);
if (!isReleasable(entry)) {
  if (entry.revisions < 1) {
    store.noteRevision(key);
    return retryWith(revisionInstruction(entry.kind, entry.userMessage));
  }
  store.markFailClosed(key);
  return FAIL_CLOSED_TEXT;          // never reword this; see below
}
```

**Release** when the turn is fully done, so the entry does not linger:

```js
store.release(key);
```

Entries also expire on `ttlMs`, so a crashed turn cannot leak.

---

## Mapping to your framework

| llm-grounded concept | Where it goes in your stack |
|---|---|
| `hardTrigger` + `requirementText` | Wherever you assemble the system prompt for a turn |
| `assessToolSafety` | Your tool-call middleware, *before* execution — LangChain callbacks, AI SDK `experimental_prepareStep`, or a wrapper around your dispatch |
| `store.recordTool` | Your tool-result handler |
| `isReleasable` + `assessVoice` | Immediately before you deliver, after the model's final draft exists |
| `retryWith(instruction)` | Your framework's retry — a graph edge back to the model node, a second `generateText` call, a loop iteration |
| `buildTurnRecord` / `writeTurn` | Optional; anywhere you can see the whole turn |

### Notes per framework

**LangGraph** — the natural shape is a `grounding` node after your agent node,
returning a conditional edge: `revise` back to the agent, or `deliver` onward.
Put the store in the graph's state rather than module scope if you checkpoint.

**Vercel AI SDK** — `assessToolSafety` fits in a tool's `execute` wrapper;
`assessVoice` fits after `generateText` resolves. For streaming you cannot
assess a draft you have not finished, so either buffer the final message or
accept that voice runs on the completed text only.

**OpenAI Agents SDK** — the gates map onto guardrails; `blockMessage()` is the
tripwire output.

**A hand-rolled loop** — you already have the right shape. The three call sites
in the minimal integration go before the completion, around tool dispatch, and
after the completion.

---

## Things you must not change

**`FAIL_CLOSED_TEXT` is asserted verbatim by the tests and is deliberately not
configurable.** The injected requirement, the revision instruction, and the
delivered substitution have to be the same sentence. A config knob would let
those three drift apart, and a contract you can weaken from configuration is
not a contract. If you want different words, fork the constant — but change all
three together.

**Budgets are separate on purpose.** The grounding gate and the voice gate get
their own retry allowance. Sharing one budget means a long reply can spend the
retry that correctness depended on, and you ship a pretty wrong answer.

**Order matters: ground first, then voice.** Never re-roll a reply for style
while it is still unverified. Assessing voice first means occasionally making a
wrong answer nicer instead of making it right.

**Fail closed on your own failure.** An exception inside a gate should withhold
the answer or the write, not silently open. Every gate here is written that
way; keep the property in the adapter.

---

## Configuration and state

The core reads no configuration file. `parseConfig` validates a plain object
against `CONFIG_JSON_SCHEMA` and fills defaults — feed it from wherever your
host keeps config:

```js
import { parseConfig, DEFAULTS } from "llm-grounded/core";
const cfg = parseConfig(myHostConfig.grounding ?? {});
```

State and telemetry directories resolve, in order:

1. `$LLM_GROUNDED_HOME`
2. `$XDG_STATE_HOME/llm-grounded`
3. `$HOME/.local/state/llm-grounded`

Every directory is also overridable through config, so a non-OpenClaw host
needs no environment variables at all.

One default is OpenClaw-shaped and you should override it: `promptFiles`
defaults to OpenClaw's workspace prompt files. It exists so each telemetry
record carries a hash of the prompt surfaces in force — a wording change alters
behaviour without touching code, and a corpus that cannot see that will
eventually be used to justify a wrong conclusion. Point it at your own prompt
sources. Missing files hash as `"absent"`, so a wrong path degrades to a
constant rather than an error.

---

## What you give up by not using the plugin

The OpenClaw adapter does a few things the core cannot do for you, because they
need host cooperation:

- **Two delivery lanes.** OpenClaw exposes both a payload path and a plain
  content path, and the adapter fails closed on both. A host with one delivery
  path is simpler; a host with several needs the check on each, or the gate has
  a hole.
- **Terminal evidence flush.** Runs that end without reaching a natural
  finalize still get their record written. If your framework can abort a turn,
  you need the equivalent or you will lose exactly the turns most worth reading.
- **The guarded fact transaction** (`facts-tool.js`, `case-audit.js`,
  `vault-txn.js`), which assumes an external CLI and a durable store. It is off
  by default even under OpenClaw.

None of those are load-bearing for the grounding, sensitive-search, or voice
gates.

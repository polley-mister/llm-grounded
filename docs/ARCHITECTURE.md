# Architecture

## Shape

llm-grounded is a per-turn state machine wrapped in host adapters. It holds no
model of its own and makes no network calls.

The state machine is the part that decides anything, and it is
framework-independent — see [INTEGRATION.md](INTEGRATION.md). What follows is
the shape of the OpenClaw adapter (`src/index.js`), which is the reference
implementation of the hook points any adapter has to provide.

```
before_prompt_build   classify the turn, record what matched, inject any
                      requirement text, open per-turn state
before_tool_call      block a tool the turn must not use (sensitive search,
                      unauthorized fact write)
after_tool_call       record what the tool actually returned; bind usable
                      results as evidence
before_agent_finalize the draft exists — check grounding, check voice, request
                      at most one bounded revision
message_sending       last gate before delivery; substitute the fail-closed
                      sentence if the contract was not met
before_message_write  keep unverified drafts out of the transcript
```

Per-turn state is keyed by run id, TTL-bounded, and capped in count. A turn
that never reaches `before_agent_finalize` expires rather than leaking.

## Why the classifier is advisory

The original design classified the user's turn into `web`, `memory`, or
`direct`, then compelled the matching tool. The precedence chain grew to 15
branches over 14 regex lists, and maintaining it was O(n²): `acknowledgement`
and `self-settings` both had to be hoisted above `current-information` because
that rule was stealing them. Reordering was whack-a-mole by construction.

The deeper problem was not the ordering. It was that the contract decided what
evidence an answer needed *before the answer existed* — prediction over
unbounded input. One function, a capitalised-proper-noun detector, produced
three of the worst failures on its own.

Making the classifier advisory defuses the precedence problem without
rewriting it. **An ambiguous ordering only matters while its output is
binding.** The verdict is still computed and still recorded; it just cannot
promote a turn to a grounded tier. `src/explicit.js` owns hard enforcement, so
the demote-only invariant holds unconditionally in the file that declares it.

Once claim-level verification lands, the precedence chain gets deleted rather
than maintained.

### The interim cost, stated plainly

Between advisory routing and claim verification, the deterministic factual
guarantee shrinks to explicit requests. A model that confabulates a date on a
turn nobody flagged will ship that date.

That is a real regression, accepted deliberately, because the guarantee was
being bought at the price of refusing 29% of ordinary conversation. The
sensitive-search block, the correction gate, and the voice gate are unaffected.

## The nonce guard

`before_prompt_build` fires again when the harness rebuilds a prompt for a
revision. That rebuilt text is *the plugin's own requirement*, not the user's
turn. Classifying it derives the obligation from the wrong string.

Every turn carries a nonce. The verdict and the hard-trigger decision are
computed once, when the nonce is new, and reused on every rebuild. This trap
has been fallen into twice; both times the symptom was a turn that escalated
its own requirements on each revision.

## Corrections are a scope, not a tier

The invariant worth preserving is narrow:

> A correction must be resolved before a durable fact is written.

The invariant is **not** "every correction must run a memory search". Those are
different claims, and conflating them is what put a grounding gate in front of
ordinary conversation.

`src/corrections.js` resolves a correction into one of three scopes:

| Scope | Evidence | May write a durable fact |
|---|---|---|
| `user_owned_fact` | the user's own assertion | yes |
| `external_world` | not settled by asserting it | no |
| `ambiguous` | no proposition to act on | no — ask for clarification |

`requiredTool` is `null` in every case. A lookup may follow, to find the record
being superseded, but never to *believe* the new value. The user is the
authority on which car they own.

A failed write withholds the write. It does not replace the conversational
answer with a grounding-failure sentence, because no retrieval failure
occurred.

## Fail-closed text is not configurable

The injected requirement, the revision instruction, and the delivery
substitution must all be the same sentence, and acceptance asserts it verbatim.
A config knob would let those three drift apart, and would be a way to weaken
the contract from configuration.

A companion test asserts the sentence in the plugin matches the sentence in the
prompt files. They drifted once, and the check was blind to its own outcome.

## Behaviour epochs

Development is not frozen to collect a baseline. Instead every telemetry record
carries:

- `behaviorEpoch` — bumped on every deliberate behaviour change
- `promptHash`, `rulesetHash`, `configHash` — computed separately, so a prompt
  edit and a rule edit are distinguishable

Analysis segments by epoch. Freeze interpretability, not development.

## Not built yet

**Phase 2 — settings compilation.** Prose explaining what each persona setting
means is what produces a model reciting its own configuration. Strip the prose,
keep the numbers, measure. Conditional injection is deliberately *not* the
first move: it converts a fail-open path into a fail-wrong one, which is
strictly worse for a question about the system's own state.

**Phase 4 — claim verification.** Extract material assertions from the draft
and ask whether this turn's tool results support each one. Fail closed only
when all four hold: the claim is material, it needs unavailable evidence, one
retry did not obtain it, and it is stated in unhedged declarative modality.

Remedy ladder, in shipping order: log only → strike the sentence → revise the
turn → fail closed. Attribution and hedging are last and gated on measured
extractor precision, because rewriting a sentence to preserve meaning is the
exact surface where a well-meaning renderer starts altering numbers.

**Deliberately not doing:** embedding routers, DSPy, LangGraph. All reasonable
end states; all new infrastructure to run. If permissive defaults hold, most of
the routing they would improve stops existing. Revisit only if the disagreement
set says otherwise.

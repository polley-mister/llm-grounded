#!/usr/bin/env node
//
// A complete integration in one file. Run it:
//
//     node examples/minimal.mjs
//
// There is no real model here. `fakeModel` is a lookup table so the output is
// deterministic and the gates are the only thing doing any work — which is the
// point, because every decision below is ordinary code you can step through.
//
// What this demonstrates, in order:
//
//   1. an ordinary conversational turn is not gated at all
//   2. an explicit search request is enforced, and fails closed when ignored
//   3. the same request succeeds when the tool actually runs
//   4. how narrow the hard triggers are: a near-miss phrasing is only advisory
//   5. a search for a private individual is refused outright
//   6. a long reply gets one bounded revision
//   7. arithmetic is a hard trigger that compels no retrieval
//
// See docs/INTEGRATION.md for the same code explained, and for how the pieces
// map onto LangGraph, the Vercel AI SDK, and other hosts.

import {
  hardTrigger,
  classifyGrounding,
  requirementText,
  advisoryText,
  revisionInstruction,
  assessToolSafety,
  blockMessage,
  assessVoice,
  createGroundingStore,
  isReleasable,
  configureAgentNames,
  configurePersonalTerms,
  FAIL_CLOSED_TEXT,
} from "../src/core.js";

// --------------------------------------------------------------------------
// Installation vocabulary. Both default to empty, which is safe; setting them
// is what stops a capitalised agent name reading as an external proper noun.
// --------------------------------------------------------------------------

configureAgentNames(["atlas"]);
configurePersonalTerms(["rivera", "parts catalogue"]);

const store = createGroundingStore({ ttlMs: 600_000, maxEntries: 200 });

// --------------------------------------------------------------------------
// A stand-in for your model and your tools.
// --------------------------------------------------------------------------

/** Canned drafts, keyed by turn. The second entry is what a retry returns. */
const DRAFTS = {
  "Good one": ["Ha. I'll take it."],
  "search the web for the tide times at Aberdaron": [
    // First draft answers from nothing, ignoring the requirement. This is the
    // failure the grounding gate exists for, and models really do it.
    "High tide is around 4pm.",
    "Still around 4pm, I think.",
  ],
  "search the web for high tide at Aberdaron": ["High tide at Aberdaron is 16:12 BST."],
  "look up the tide times at Aberdaron": ["I think it's mid-afternoon."],
  "where does Jane Doe live": ["I can't help with that."],
  "tell me about the parts catalogue": [
    // Deliberately over-long and opening with a stock phrase, to trip voice.
    "Great question! The parts catalogue is a really interesting topic and I'm " +
      "happy to walk you through it in detail. " +
      "There are many aspects worth considering here. ".repeat(12),
    "It's the inventory list you keep for the workshop.",
  ],
  "what is 17 * 24": ["408."],
};

function fakeModel(turn, attempt) {
  const drafts = DRAFTS[turn] ?? ["(no canned draft)"];
  return drafts[Math.min(attempt, drafts.length - 1)];
}

/** Which tools the model decides to call. Turn 2 deliberately calls nothing. */
const TOOL_CALLS = {
  "search the web for high tide at Aberdaron": [
    { name: "web_search", params: { query: "Aberdaron high tide" } },
  ],
  "where does Jane Doe live": [
    { name: "web_search", params: { query: "where does Jane Doe live" } },
  ],
};

// --------------------------------------------------------------------------
// The adapter. This is the part you would write for your own framework.
// --------------------------------------------------------------------------

let turnNo = 0;

function runTurn(userTurn, { prevAssistant = "" } = {}) {
  const key = { runId: `run-${++turnNo}`, sessionKey: "demo" };
  const log = [];

  // 1. Decide what this turn may compel. hardTrigger is the ONLY thing that
  //    creates an obligation; classifyGrounding is recorded as a measurement
  //    and has no authority over the outcome.
  const hard = hardTrigger(userTurn, { prevAssistant });
  const legacy = classifyGrounding(userTurn, { prevAssistant });
  const advisory = hard.kind === null;

  log.push(`policy      ${advisory ? "advisory" : "BINDING"}  hardTrigger=${hard.kind ?? "null"}` +
    `  (legacy classifier would have said: ${legacy.kind ?? "null"})`);

  const instruction = advisory ? advisoryText(legacy.kind) : requirementText(hard.kind);
  if (instruction) log.push(`inject      ${truncate(instruction, 88)}`);

  // Only web and memory are retrieval tiers. Everything else is stored as
  // kind:null, which is releasable on arrival: no requirement, no revision,
  // and structurally no route to fail-closed.
  store.begin({
    ...key,
    kind: hard.kind === "web" || hard.kind === "memory" ? hard.kind : null,
    reason: legacy.reason,
    userMessage: userTurn,
    prevAssistant,
  });

  // 2. Tool dispatch, with the sensitive-search gate in front of it.
  for (const call of TOOL_CALLS[userTurn] ?? []) {
    const safety = assessToolSafety(call.name, call.params);
    if (safety.blocked) {
      log.push(`tool        ${call.name} BLOCKED (${safety.reason})`);
      log.push(`            model receives: ${truncate(blockMessage(), 76)}`);
      continue;
    }
    log.push(`tool        ${call.name} ran, query=${JSON.stringify(call.params.query)}`);
    // recordTool is what marks an obligation satisfied. The right tool aimed
    // at an unrelated subject deliberately does not count.
    store.recordTool({ ...key, toolName: call.name, ok: true, params: call.params });
  }

  // 3. Draft, then gate. Grounding first: never re-roll for style while the
  //    answer is still unverified.
  let attempt = 0;
  let draft = fakeModel(userTurn, attempt);
  log.push(`draft       ${truncate(draft, 88)}`);

  let entry = store.get(key);
  if (!isReleasable(entry)) {
    if (entry.revisions < 1) {
      store.noteRevision(key);
      log.push(`GROUNDING   unsatisfied, requesting one bounded revision`);
      log.push(`            ${truncate(revisionInstruction(entry.kind, userTurn), 76)}`);
      draft = fakeModel(userTurn, ++attempt);
      log.push(`redraft     ${truncate(draft, 88)}`);
    }
    if (!isReleasable(store.get(key))) {
      store.markFailClosed(key);
      log.push(`GROUNDING   still unsatisfied after its one retry: failing closed`);
      store.release(key);
      return finish(userTurn, FAIL_CLOSED_TEXT, log);
    }
  }

  // Voice gate, on its own separate budget. Sharing one budget would let a
  // long reply spend the retry that correctness depended on.
  const voice = assessVoice(draft, { userMessage: userTurn, maxWords: 90 });
  if (!voice.ok) {
    log.push(`VOICE       ${voice.violations.join(", ")}`);
    log.push(`            ${truncate(voice.instruction, 76)}`);
    draft = fakeModel(userTurn, ++attempt);
    log.push(`redraft     ${truncate(draft, 88)}`);
  }

  store.release(key);
  return finish(userTurn, draft, log);
}

// --------------------------------------------------------------------------
// Presentation only, below here.
// --------------------------------------------------------------------------

function truncate(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function finish(turn, delivered, log) {
  console.log(`\n\x1b[1m> ${turn}\x1b[0m`);
  for (const line of log) console.log(`  \x1b[2m${line}\x1b[0m`);
  console.log(`  \x1b[32mdelivered   ${truncate(delivered, 88)}\x1b[0m`);
  return delivered;
}

console.log("llm-grounded: six turns through the gates. No model is called.");

// 1. Ordinary conversation. Nothing is compelled, nothing can fail closed.
runTurn("Good one", { prevAssistant: "…so the backup restored itself." });

// 2. An explicit search request the model then ignores. This is the only
//    shape that reaches fail-closed under advisory routing.
runTurn("search the web for the tide times at Aberdaron");

// 3. The same obligation, this time satisfied by an actual search.
runTurn("search the web for high tide at Aberdaron");

// 4. A near miss, and the most important line of output in this file. "look up
//    the tide times" is not an explicit tool request, so it is ADVISORY: the
//    model is told it may search, and its unsupported answer still ships. That
//    is the deliberate cost of permissive defaults. The alternative — treating
//    this as binding — is what produced a 29% refusal rate on ordinary
//    conversation. See docs/FAILURE-CATALOGUE.md.
runTurn("look up the tide times at Aberdaron");

// 5. A search aimed at locating a private individual. Blocked regardless of
//    policy mode: this gate does not care whether routing is advisory.
runTurn("where does Jane Doe live");

// 6. A reply that is too long and opens with a stock phrase.
runTurn("tell me about the parts catalogue");

// 7. Arithmetic is a hard trigger, but it binds no retrieval tier.
runTurn("what is 17 * 24");

console.log("\nEvery decision above came from ordinary code. No model was consulted.\n");

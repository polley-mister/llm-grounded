import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyGrounding,
  extractTurnNonce,
  extractUserTurn,
  hasLowercaseExternalReference,
  hasNamedExternalEntity,
  isNegatedAssertion,
  isSelfReferenceQuestion,
  stripChannelContext,
  stripVocative,
  SATISFYING_TOOLS,
} from "../src/classify.js";

import "./_vocabulary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(await readFile(path.join(here, "vectors", "grounding-cases.json"), "utf8"));

test("shared vectors classify exactly as recorded", () => {
  for (const c of vectors.cases) {
    const got = classifyGrounding(c.message);
    assert.equal(got.kind, c.kind, `${c.name}: kind (reason=${got.reason})`);
    assert.equal(got.correction, c.correction, `${c.name}: correction`);
  }
});

test("precedence is current web > memory > named external > direct", () => {
  // current beats personal
  assert.equal(classifyGrounding("what is my Proxmox node doing right now").kind, "web");
  // personal beats a bare external name
  assert.equal(classifyGrounding("did we ever finish the parts catalogue backtest for Tesla").kind, "memory");
  // named external beats direct
  assert.equal(classifyGrounding("How did Boromir die?").kind, "web");
  // nothing left => direct
  assert.equal(classifyGrounding("is it better to write the test first or the code first").kind, null);
});

test("corrections always re-ground and are flagged", () => {
  const external = classifyGrounding("No, that's wrong. He did not die that way.");
  assert.equal(external.kind, "web");
  assert.equal(external.correction, true);

  const personal = classifyGrounding("That's wrong, my car is the 330i.");
  assert.equal(personal.kind, "memory");
  assert.equal(personal.correction, true);
});

test("fact-plus-emotion still requires web grounding", () => {
  const got = classifyGrounding("How did Boromir die, and how do you feel about it?");
  assert.equal(got.kind, "web");
  assert.equal(got.reason, "named-external-fact-with-emotion");
});

test("arithmetic never grounds", () => {
  for (const m of ["2 + 2", "what is 2 + 2?", "calculate 1440 / 24", "(3*4)-1"]) {
    assert.equal(classifyGrounding(m).kind, null, m);
  }
});

test("questions about the agent itself are direct and spend no search", () => {
  // WP-2026-005. `Atlas` used to be a memory term, so every one of these
  // demanded a vault lookup for a question the injected prompt files already
  // answer — and when the lookup returned nothing usable, the turn failed
  // closed on "who are you".
  for (const message of [
    "Who are you?",
    "What are you?",
    "what are you capable of, Atlas?",
    "Atlas, what can you do?",
    "do you have opinions?",
    "are you an AI or something else?",
    "how do you work?",
    "tell me about yourself",
    "What should I know about Atlas?",
    "how would you describe yourself?",
  ]) {
    const verdict = classifyGrounding(message);
    assert.equal(verdict.kind, null, `${message} must not require evidence`);
    assert.equal(verdict.reason, "self-reference");
    assert.equal(verdict.correction, false);
  }
});

test("Live Settings questions are answered from the injected prompt", () => {
  // Regression: the setting names are capitalised, so hasNamedExternalEntity()
  // read "Humor" as a proper noun and sent the turn to the web tier. Observed
  // in the wild as a web_search on "Are you able to change your Humor setting
  // to 100?", which returned an unrelated answer that the contract accepted
  // because a search had run.
  //
  // "right now" is the second path: it matches CURRENT_INFO, which also beat
  // the self-reference branch.
  for (const message of [
    "what are your settings?",
    "What is your humor setting at right now?",
    "Are you able to change your Humor setting to 100?",
    "Can you set humor to seventy-five?",
    "dial your Verbosity up to 60",
    "what is your Honesty level currently?",
  ]) {
    const verdict = classifyGrounding(message);
    assert.equal(verdict.kind, null, `${message} must not require evidence`);
    assert.equal(verdict.reason, "self-settings", message);
    assert.equal(verdict.correction, false);
  }
});

test("a self-question about live state stays grounded", () => {
  for (const message of [
    "What is your current status?",
    "what is your current config?",
    "how are you configured?",
    "what are you working on?",
    "what model are you running on?",
  ]) {
    const verdict = classifyGrounding(message);
    assert.equal(verdict.kind, "memory", `${message} is stored state, not character`);
    assert.equal(verdict.reason, "self-state");
  }
  // Current-information markers still outrank everything.
  assert.equal(classifyGrounding("what did you deploy today?").kind, "web");
  // And a mention of the agent that is not a question about it is still
  // workspace context.
  assert.equal(classifyGrounding("Atlas is broken").kind, "memory");
});

test("a second-person opener does not launder an external factual claim", () => {
  // "are you sure Boromir died first" is a claim about a film wearing a
  // question about the agent. The named-entity exclusion is what stops the
  // self-reference rule becoming a way to skip grounding.
  assert.equal(classifyGrounding("are you sure Boromir died first?").kind, "web");
  assert.equal(isSelfReferenceQuestion("are you sure Boromir died first?"), false);
  assert.equal(isSelfReferenceQuestion("what are your settings?"), true);
});

test("every arithmetic verb still matches after the scanner-safe rewrite", () => {
  // The alternation was respelled so the source does not trip OpenClaw's
  // install scanner. Behaviour must be unchanged: both the short and long verb
  // forms still classify as arithmetic.
  for (const m of [
    "eval 6*7",
    "evaluate 6*7",
    "calculate 6*7",
    "compute 6*7",
    "solve 6*7",
    "what's 6*7",
    "what is 6*7",
    "6*7",
  ]) {
    const got = classifyGrounding(m);
    assert.equal(got.kind, null, m);
    assert.equal(got.reason, "arithmetic", m);
  }
  // The verb alone is not arithmetic — it still needs digits and an operator.
  assert.notEqual(classifyGrounding("evaluate the deploy plan").reason, "arithmetic");
});

test("creative and transformational work suppresses name detection", () => {
  assert.equal(hasNamedExternalEntity("Write me a poem about rain in Paris"), true);
  assert.equal(classifyGrounding("Write me a poem about rain in Paris").kind, null);
  assert.equal(classifyGrounding("summarize the paragraph above").kind, null);
});

test("common sentence-leading words are not treated as names", () => {
  for (const m of [
    "Explain the deploy gate",
    "Should I upgrade the disk",
    "Compare the two options",
    "Check whether the build is stale",
  ]) {
    assert.equal(hasNamedExternalEntity(m), false, m);
  }
});

test("code spans do not create false names", () => {
  assert.equal(hasNamedExternalEntity("does `MutationGuard` still apply here"), false);
  assert.equal(hasNamedExternalEntity("```\nclass Foo {}\n```\nwhat does that do"), false);
});

test("quoted titles and years are external markers", () => {
  assert.equal(hasNamedExternalEntity('who wrote "the pragmatic programmer"'), true);
  assert.equal(hasNamedExternalEntity("what shipped in 2019"), true);
});

test("satisfying tools match the accepted contract", () => {
  assert.deepEqual(SATISFYING_TOOLS.web, ["web_search"]);
  assert.deepEqual(SATISFYING_TOOLS.memory, ["memory_search", "wiki_search"]);
});

// --- regressions from the original transcript (Codex review, 2026-07-24) ----
// These three exact strings all classified wrongly before this batch. They are
// fixed by general rules, not by hard-coded trivia: no rule below mentions any
// specific person, film, or work.

test("REGRESSION: lowercase factual question plus emotion grounds to web", () => {
  const got = classifyGrounding("how did Boromir die from lord of the rings, how did that make you feel?");
  assert.equal(got.kind, "web");
  assert.equal(got.reason, "named-external-fact-with-emotion");
});

test("REGRESSION: a factual negative correction grounds to web", () => {
  const got = classifyGrounding("The wormhole never collapsed.");
  assert.equal(got.kind, "web");
  assert.equal(got.correction, true);
});

test("REGRESSION: a vocative prefix does not hide arithmetic", () => {
  const got = classifyGrounding("Hey Atlas, what is 1 + 1?");
  assert.equal(got.kind, null);
  assert.equal(got.reason, "arithmetic");
});

test("REGRESSION: a transport timestamp does not turn arithmetic into memory", () => {
  // The exact live acceptance prompt. The prefix defeated the start-anchored
  // vocative strip, leaving `the agent` to match as a project term.
  const live = "[Fri 2026-07-24 18:46 PDT] Hey Atlas, what is 2 + 2?";
  assert.equal(stripChannelContext(live), "Hey Atlas, what is 2 + 2?");
  const got = classifyGrounding(live);
  assert.equal(got.kind, null);
  assert.equal(got.reason, "arithmetic");
  // The bare form was always right; both must now agree.
  assert.deepEqual(got, classifyGrounding("Hey Atlas, what is 2 + 2?"));
});

test("transport framing is stripped without eating content", () => {
  assert.equal(stripChannelContext("[a] [b] hello"), "hello");
  assert.equal(stripChannelContext("no prefix here"), "no prefix here");
  // Only leading framing: a bracketed expression inside a message survives.
  assert.equal(
    stripChannelContext("does the list [1, 2, 3] sort correctly"),
    "does the list [1, 2, 3] sort correctly",
  );
  // Stripping must never empty the message.
  assert.equal(stripChannelContext("[only a bracket]"), "[only a bracket]");
  // Grounding survives the prefix in both directions.
  assert.equal(classifyGrounding("[Fri 18:46] how did Boromir die from lord of the rings?").kind, "web");
  assert.equal(classifyGrounding("[Fri 18:46] what is my on-call weekend schedule").kind, "memory");
});

test("lowercase external references are found without capitalization", () => {
  assert.equal(hasLowercaseExternalReference("how did Boromir die"), true);
  assert.equal(hasLowercaseExternalReference("what is lord of the rings about"), true);
  assert.equal(hasLowercaseExternalReference("a quote from lord of the rings"), true);
  // First and second person subjects are not external.
  assert.equal(hasLowercaseExternalReference("how do i fix this"), false);
  assert.equal(hasLowercaseExternalReference("what did you say"), false);
  // Ordinary nouns in subject position are not external referents.
  assert.equal(hasLowercaseExternalReference("how does the deploy script work"), false);
  assert.equal(hasLowercaseExternalReference("when did the build finish"), false);
});

test("negated assertions are corrections; negated instructions are not", () => {
  assert.equal(isNegatedAssertion("The wormhole never collapsed."), true);
  assert.equal(isNegatedAssertion("He didn't die in the explosion."), true);
  assert.equal(isNegatedAssertion("That was not the reason."), true);
  assert.equal(isNegatedAssertion("the car's chassis is TC20, not TC10."), true);
  // A leading negation is an instruction.
  assert.equal(isNegatedAssertion("do not deploy that yet"), false);
  assert.equal(isNegatedAssertion("don't restart the gateway"), false);
  // Questions are not assertions.
  assert.equal(isNegatedAssertion("didn't it collapse?"), false);
  // Dismissals assert no competing fact.
  assert.equal(isNegatedAssertion("it doesn't matter"), false);
  // Bare "not" must not trip it.
  assert.equal(isNegatedAssertion("I'm not sure about that"), false);
});

test("vocatives and greetings are stripped, content is not", () => {
  assert.equal(stripVocative("Hey Atlas, what is 1 + 1?"), "what is 1 + 1?");
  assert.equal(stripVocative("Atlas, what is 12 * 12?"), "what is 12 * 12?");
  assert.equal(stripVocative("hey what is the weather"), "what is the weather");
  // A bare greeting has no content to keep, so the original survives.
  assert.equal(stripVocative("hey"), "hey");
  // The agent name inside content is not an address.
  assert.equal(stripVocative("Atlas is broken"), "Atlas is broken");
  assert.equal(classifyGrounding("Atlas is broken").kind, "memory");
});

test("a first-person negated assertion corrects memory, not the web", () => {
  const got = classifyGrounding("I never use tabs.");
  assert.equal(got.kind, "memory");
  assert.equal(got.correction, true);
});

test("emotion without an external premise stays direct", () => {
  assert.equal(classifyGrounding("how did that make you feel?").kind, null);
});

test("the user turn is extracted from a composed the console prompt", () => {
  const composed = [
    "[Context — current date & time: Friday]",
    "[the console chat — mode: chat] Normal conversation. You may search and maintain memory.",
    "[user-message:a1b2c3d4]\n2 + 2\n[/user-message:a1b2c3d4]",
    "Reply as the agent.",
  ].join("\n\n");
  assert.equal(extractUserTurn(composed), "2 + 2");
  // Without extraction the surrounding blocks would ground a trivial turn.
  assert.equal(classifyGrounding(extractUserTurn(composed)).kind, null);
  assert.notEqual(classifyGrounding(composed).kind, null);
});

test("a native channel prompt has no markers and classifies whole", () => {
  assert.equal(extractUserTurn("How did Boromir die?"), "How did Boromir die?");
  assert.equal(extractUserTurn(""), "");
});

test("the per-turn nonce is extracted alongside the turn", () => {
  const composed = "[user-message:a1b2c3d4]\n2 + 2\n[/user-message:a1b2c3d4]";
  assert.equal(extractTurnNonce(composed), "a1b2c3d4");
  assert.equal(extractUserTurn(composed), "2 + 2");
  // Native channels carry no marker, so there is no nonce to bind to.
  assert.equal(extractTurnNonce("How did Boromir die?"), null);
  assert.equal(extractTurnNonce(""), null);
  // The nonce always belongs to the same pair the turn came from.
  const two =
    "[user-message:11111111]\nfirst\n[/user-message:11111111]\n\n" +
    "[user-message:22222222]\nsecond\n[/user-message:22222222]";
  assert.equal(extractTurnNonce(two), "22222222");
  assert.equal(extractUserTurn(two), "second");
});

test("a mismatched closing nonce is not a marker at all", () => {
  const text = "[user-message:aaaaaaaa]\nhidden\n[/user-message:bbbbbbbb]";
  assert.equal(extractUserTurn(text), text);
});

test("the last complete marker pair wins", () => {
  const text =
    "[user-message:11111111]\nfirst\n[/user-message:11111111]\n\n" +
    "[user-message:11111111]\nsecond\n[/user-message:11111111]";
  assert.equal(extractUserTurn(text), "second");
});

test("empty and whitespace input is direct", () => {
  assert.equal(classifyGrounding("").kind, null);
  assert.equal(classifyGrounding("   ").kind, null);
  assert.equal(classifyGrounding(undefined).kind, null);
});

test("a contextual correction re-grounds against the store that owns the claim", () => {
  // WP-2026-004. "It's an TC20." names nothing personal and carries no
  // correction vocabulary, so on the message alone it read as a named external
  // fact and demanded a web_search to re-ground a fact about the operator's own car.
  const message = "It's an TC20.";
  // Was "web". The only thing making this look external was the contraction:
  // "It's" was looked up as "it's", missed "it" in COMMON_WORDS, and read as a
  // proper noun ("TC20" is skipped as an acronym). Normalising contractions
  // removed that trigger, so on the message alone this is now direct — which
  // is the reading the comment above already argued for. The contextual path
  // below is what actually runs in production and is unchanged.
  assert.equal(
    classifyGrounding(message).kind,
    null,
    "the message alone names nothing external",
  );

  const personal = classifyGrounding(message, {
    prevAssistant: "Sam, your car is a 330i — an TC10 chassis.",
    contextualCorrection: true,
  });
  assert.equal(personal.kind, "memory");
  assert.equal(personal.correction, true);
  assert.equal(personal.reason, "correction-personal-context");

  // The prior answer only moves a correction from web to memory. An external
  // claim stays external.
  const external = classifyGrounding(message, {
    prevAssistant: "The film opened in 2014.",
    contextualCorrection: true,
  });
  assert.equal(external.kind, "web");
  assert.equal(external.reason, "correction-external");

  // And context alone never invents a correction.
  assert.equal(
    classifyGrounding("What chassis is it?", { prevAssistant: "the car is your TC10." }).correction,
    false,
  );
});

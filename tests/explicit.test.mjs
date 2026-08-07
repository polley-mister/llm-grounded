// Hard triggers: the only decisions in the package that may compel a tool.
//
// This file did not exist until a vocative prefix was found to disable every
// one of them - "Hey Atlas, what is 1 + 1?" resolved to no trigger while
// "what is 1 + 1?" resolved to arithmetic. The regression had a named test
// under the old classifier and was reintroduced when enforcement moved into
// explicit.js, because the vocative stripping stayed behind in classify.js and
// nothing here was checking.
//
// The invariant under test is narrow and worth stating: a hard trigger fires
// only on something the operator said outright, and phrasing that does not
// change what they said must not change whether it fires.

import assert from "node:assert/strict";
import test from "node:test";

import { AGENT } from "./_vocabulary.mjs";
import { advisoryText, bindsCurrentInformation, hardTrigger } from "../src/explicit.js";

test("an ordinary factual question compels nothing", () => {
  // The whole point of the split. This resembles a web question and is not one.
  for (const s of [
    "how did the deploy go",
    "what is the capital of France",
    "how much storage does the array have",
    "is it better to write the test first",
  ]) {
    assert.equal(hardTrigger(s).kind, null, s);
  }
});

test("an explicit tool request compels that tool", () => {
  assert.equal(hardTrigger("search the web for the current price").kind, "web");
  assert.equal(hardTrigger("look it up online").kind, "web");
  assert.equal(hardTrigger("check your memory for the budget").kind, "memory");
});

test("a parseable expression is arithmetic", () => {
  assert.equal(hardTrigger("what is 1 + 1?").kind, "arithmetic");
  assert.equal(hardTrigger("what is 12 * 12").kind, "arithmetic");
  // A number in a sentence is not an expression.
  assert.equal(hardTrigger("we have 12 nodes now").kind, null);
});

test("REGRESSION: a vocative prefix does not hide a hard trigger", () => {
  // Addressing the agent by name is the most natural way to open a turn. It
  // changes nothing about what was asked, so it must change nothing here.
  assert.equal(hardTrigger(`Hey ${AGENT}, what is 1 + 1?`).kind, "arithmetic");
  assert.equal(hardTrigger(`${AGENT}, what is 12 * 12?`).kind, "arithmetic");
  assert.equal(hardTrigger(`${AGENT}, search the web for that`).kind, "web");
  assert.equal(hardTrigger(`${AGENT} - check your memory for the budget`).kind, "memory");
});

test("a hyphenated identifier is not a vocative", () => {
  // "atlas-chat is broken" names a service, not the agent. Stripping a
  // vocative here would silently rewrite the operator's subject.
  const s = `${AGENT.toLowerCase()}-chat is broken`;
  assert.equal(hardTrigger(s).kind, null);
});

test("stripping the vocative cannot empty the turn", () => {
  // A turn that is nothing but the agent's name still resolves, rather than
  // falling through a blank string into an unrelated matcher.
  const got = hardTrigger(AGENT);
  assert.equal(got.kind, null);
  assert.equal(typeof got.reason, "string");
});

test("a correction binds the fact-commit path and compels no retrieval", () => {
  const got = hardTrigger("no, the budget is 4000", {
    prevAssistant: "Your budget is 3500.",
  });
  assert.equal(got.kind, "correction");
  assert.equal(got.policyScope, "fact_commit");
  // The operator is the authoritative source for their own world, so their
  // assertion is the evidence. Nothing is looked up to believe it.
  assert.equal(got.requiredTool, null);
});

test("REGRESSION: a current-information question compels the web tier", () => {
  // The live turn this tier was added for. classify.js already returned
  // current-information; only advice came of it, so the agent invented a
  // forecast for a location it does not know.
  const got = hardTrigger(`How's the weather looking like for you, ${AGENT}?`);
  assert.equal(got.kind, "web");
  assert.equal(got.reason, "current-information-topic");

  for (const s of [
    "what's the weather in Portland?",
    "what is the stock price of AAPL",
    "who won the game last night?",
    "any news on the outage?",
    "what's the release date for that",
  ]) {
    assert.equal(hardTrigger(s).kind, "web", s);
  }
});

test("the topic tier does not fire on the agent's own state", () => {
  // CURRENT_INFO in classify.js matches "today" and "latest" so it can advise.
  // Binding on those would compel a search for things already in context.
  for (const s of [
    "what did you change today?",
    "what's your latest config?",
    "how did the deploy go",
    "what model are you running?",
  ]) {
    assert.equal(hardTrigger(s).kind, null, s);
  }
});

test("the topic tier does not fire on invention or on a statement", () => {
  for (const s of [
    "write me a poem about the weather",
    "summarise the news article I pasted",
    "hypothetically, what if the price of copper doubled?",
    "the weather was miserable last week",
  ]) {
    assert.equal(hardTrigger(s).kind, null, s);
  }
});

test("an explicit instruction outranks the topic tier", () => {
  // Both mention a bound topic. The tier the operator named must win, or the
  // trigger silently redirects them to a different store.
  assert.equal(hardTrigger("check your vault for the forecast").reason, "explicit-memory-request");
  assert.equal(hardTrigger("search the web for the weather").reason, "explicit-web-request");
});

test("bindsCurrentInformation needs topic, question shape and factual intent", () => {
  assert.equal(bindsCurrentInformation("what's the weather?"), true);
  assert.equal(bindsCurrentInformation("the weather is fine"), false);
  assert.equal(bindsCurrentInformation("write a haiku about the weather"), false);
  assert.equal(bindsCurrentInformation("what's for dinner?"), false);
  for (const v of ["", "   ", null, undefined]) {
    assert.equal(bindsCurrentInformation(v), false);
  }
});

test("the web advisory does not offer answering from memory", () => {
  // The old wording ended "use web search if you need it", which the agent read
  // as permission to decide it did not need it.
  const advice = advisoryText("web");
  assert.match(advice, /do not answer from memory/i);
  assert.doesNotMatch(advice, /if you need it/i);
});

test("empty and non-string input resolve rather than throw", () => {
  for (const v of ["", "   ", null, undefined, 42, {}]) {
    const got = hardTrigger(v);
    assert.equal(got.kind, null);
    assert.equal(typeof got.reason, "string");
  }
});

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
import { hardTrigger } from "../src/explicit.js";

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

test("empty and non-string input resolve rather than throw", () => {
  for (const v of ["", "   ", null, undefined, 42, {}]) {
    const got = hardTrigger(v);
    assert.equal(got.kind, null);
    assert.equal(typeof got.reason, "string");
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { classifyGrounding } from "../src/classify.js";

import "./_vocabulary.mjs";

test("short reactions never require grounding", () => {
  // Observed: "Good one" was answered with the fail-closed line, immediately
  // after the agent told the joke that earned it. There is nothing in a reaction to
  // ground, so routing one to a tier can only fail closed.
  for (const message of [
    "Good one",
    "good one",
    "Nice",
    "Ha",
    "lol",
    "thanks",
    "Thanks the agent",
    "ok",
    "Fair enough",
    "That's funny",
    "yep",
    "Well done",
  ]) {
    const verdict = classifyGrounding(message);
    assert.equal(verdict.kind, null, `${message} must not require evidence`);
    assert.equal(verdict.correction, false);
  }
});

test("capitalisation alone never decides whether a turn needs a search", () => {
  // Root cause: COMMON_WORDS held instruction vocabulary but not everyday
  // words, so a capitalised "Good" read as a proper noun while "good" did not.
  // A two-word reply required a web search purely for starting a sentence.
  for (const [upper, lower] of [
    ["Good one", "good one"],
    ["Nice", "nice"],
    ["True", "true"],
    ["Perfect", "perfect"],
  ]) {
    assert.equal(
      classifyGrounding(upper).kind,
      classifyGrounding(lower).kind,
      `${upper} and ${lower} must classify alike`,
    );
  }
});

test("a real question that merely opens with a reaction word still grounds", () => {
  // The acknowledgement branch is bounded to five words precisely so it cannot
  // swallow a genuine request that happens to start politely.
  for (const message of [
    "Good question — what does the Grafana changelog say?",
    "True, but what did OpenAI announce this week?",
    "Nice, is Kubernetes still supported on Debian?",
    "Perfect. Now check the news on the Cloudflare outage.",
  ]) {
    assert.notEqual(
      classifyGrounding(message).kind,
      null,
      `${message} must still require evidence`,
    );
  }
});

test("capitalised contractions are not proper nouns", () => {
  // The token strip only removes non-letters from the ENDS of a word, so
  // "There#s" was looked up as "there#s" and missed "there" in COMMON_WORDS.
  // Every capitalised contraction therefore read as a named entity: the turn
  // "There#s a runaway trolley..." was classified as external fact, forcing a
  // web search on a joke and returning an encyclopedia entry.
  for (const message of [
    "There is a runaway trolley going down the tracks",
    "That is a strange way to put it",
    "It is fine, I was only kidding",
    "I am not sure that follows",
    "He is wrong about that",
  ]) {
    assert.equal(classifyGrounding(message).kind, null, message);
  }
  // The apostrophe forms must behave identically to the expanded ones.
  for (const [contracted, expanded] of [
    [String.fromCharCode(84,104,101,114,101,39,115) + " a runaway trolley going down the tracks", "There is a runaway trolley going down the tracks"],
    [String.fromCharCode(84,104,97,116,39,115) + " a strange way to put it", "That is a strange way to put it"],
  ]) {
    assert.equal(
      classifyGrounding(contracted).kind,
      classifyGrounding(expanded).kind,
      contracted,
    );
  }
});

test("possessive proper nouns are still detected", () => {
  // The same normalisation strips possessives, so verify it did not blind the
  // detector to real names.
  for (const message of [
    String.fromCharCode(80,114,111,120,109,111,120,39,115) + " latest release notes",
    "Is " + String.fromCharCode(67,108,111,117,100,102,108,97,114,101,39,115) + " outage resolved?",
  ]) {
    assert.notEqual(classifyGrounding(message).kind, null, message);
  }
});

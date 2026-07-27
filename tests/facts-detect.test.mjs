// Contextual detection: what may open the vault door, and what may not.
//
// The exclusion cases matter more than the positive ones. A missed capture is
// one absent record; a false positive writes something the operator never said into
// the state of record.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectFactStatement, isMostlyQuotation } from "../src/facts-detect.js";

import "./_vocabulary.mjs";

const CAR_ANSWER = "the car is your 2011 BMW 330i — an F30 chassis.";

function detect(message, prev = CAR_ANSWER) {
  return detectFactStatement(message, prev);
}

test("the acceptance case: a bare contextual correction is recognized", () => {
  const result = detect("It's an M2.");
  assert.equal(result.eligible, true);
  assert.equal(result.kind, "correct");
  assert.equal(result.reason, "contextual-correction");
  assert.equal(result.unambiguous, true);
});

test("transport framing and vocatives do not hide a correction", () => {
  assert.equal(detect("[Fri 2026-07-24 18:46 PDT] Hey Atlas, it's an M2.").kind, "correct");
});

test("a correction with no preceding answer has nothing to correct", () => {
  const result = detectFactStatement("It's an M2.", "");
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "correction-without-prior-answer");
});

test("explicit rejections and negated assertions are corrections", () => {
  for (const message of [
    "No, that's wrong — it's an M2.",
    "Actually, it is an M2.",
    "You got that wrong.",
    "the car was never an F30.",
    "the car's chassis is M2, not F30.",
  ]) {
    const result = detect(message);
    assert.equal(result.eligible, true, message);
    assert.equal(result.kind, "correct", message);
  }
});

test("a self-contained old/new correction can bind to vault evidence without a preceding answer", () => {
  const result = detectFactStatement("the car's chassis is M2, not F30.", "");
  assert.equal(result.eligible, true);
  assert.equal(result.kind, "correct");
  assert.equal(result.reason, "negated-correction");
});

test("first-person durable statements create a fact", () => {
  for (const message of [
    "My router is a MikroTik CCR2004.",
    "I drive a 2011 BMW 330i.",
    "I switched to OPNsense last month.",
    "Mine is the grey one.",
  ]) {
    const result = detectFactStatement(message, "");
    assert.equal(result.eligible, true, message);
    assert.equal(result.kind, "create", message);
  }
});

test("questions never produce a transaction", () => {
  for (const message of [
    "What chassis is the car?",
    "Is the car an M2?",
    "Do you remember my router?",
    "Tell me about my homelab.",
    "remind me what the car is",
  ]) {
    assert.equal(detect(message).eligible, false, message);
  }
});

test("uncertainty, hypotheticals, jokes, quotations and third parties are excluded", () => {
  const cases = {
    "I think it's an M2.": "uncertain",
    "I'm not sure, maybe an M2.": "uncertain",
    "If it were an M2 I'd have the N54.": "hypothetical",
    "Imagine my car is an M2.": "hypothetical",
    "It's an M2, lol jk.": "joke",
    '"the car is an M2 with the N54."': "quotation",
    // Quoted *and* attributed. Either exclusion alone would be enough.
    '"It\'s an M2" is what the forum said.': "third-party",
    "He said it's an M2.": "third-party",
    "According to the VIN decoder it's an M2.": "third-party",
    "My friend told me it's an M2.": "third-party",
  };
  for (const [message, reason] of Object.entries(cases)) {
    const result = detect(message);
    assert.equal(result.eligible, false, `${message} should not be eligible`);
    assert.equal(result.reason, reason, message);
  }
});

test("opinions and instructions are not durable facts", () => {
  assert.equal(detect("That's a great car.").eligible, false);
  assert.equal(detect("Remember that it's an M2.").reason, "instruction");
  assert.equal(detect("Please update the vault.").reason, "instruction");
  assert.equal(detect("Don't record that.").reason, "instruction");
});

test("ordinary conversation and arithmetic are inert", () => {
  for (const message of ["2 + 2", "thanks", "hey", "write me a haiku about rain"]) {
    assert.equal(detectFactStatement(message, CAR_ANSWER).eligible, false, message);
  }
});

test("an essay is not one durable fact", () => {
  assert.equal(detectFactStatement(`My car is ${"x".repeat(700)}`, "").reason, "too-long");
});

test("quotation share, not quotation presence, is what excludes", () => {
  assert.equal(isMostlyQuotation('"the whole thing is quoted"'), true);
  assert.equal(isMostlyQuotation('My dog is named "Bit" and he is nine years old.'), false);
  // …so a fact that merely contains a quoted name still counts.
  assert.equal(detectFactStatement('My dog is named "Bit" and he is nine years old.', "").eligible, true);
});

test("empty and whitespace input is inert", () => {
  for (const message of ["", "   ", null, undefined]) {
    assert.equal(detectFactStatement(message, CAR_ANSWER).eligible, false);
  }
});
